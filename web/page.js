// SPDX-License-Identifier: GPL-2.0-or-later
//
// The page around the Emscripten build of Doom Legacy (brief 02).
//
// Starts the game from a click (so that audio may start), fetches the data, keeps the config and
// saved games in IndexedDB (IDBFS), and ends in a clear "the game has ended" state.
//
// Parts follow jfsw-browser's page (the user's own work, GPL): the click-to-start overlay, the
// Escape handling under pointer lock, the IDBFS sync queue.
//
// The game data (brief 03): config.js says where it is (default doom1.wad next to the page, D14), data.js downloads it
// with progress, checks it, keeps it in IndexedDB (its own database) and offers "Use your own copy" (a file picker).
//
//   ?iwad=URL     the IWAD to use instead of config.js's (any origin that sends CORS headers). Its size and SHA-256 are not
//                 declared: it must be an IWAD whose lump directory lies inside the file, and it is named after what it is.
//   ?test=1       test hooks, below
//
// Test hooks, only with ?test=1:
//   args=JSON|TEXT   game arguments after the page's own (a JSON array, or words split at spaces)
//   files=URL,...    fetched into the game's working directory /work before the game starts
//   persist=0        no IndexedDB: config and saved games are in memory (the control run)
//   home=DIR         the game's -home (default /persist, the IndexedDB folder)
//   nolock=1         never lock the pointer (headless Chromium stalls the page for 100 ms to 3 s at a time while it is locked)
//   fast=1           test pacing: yield without waiting for a display frame (src/sdl/i_web.c)
//   fastms=N         ... at most every N ms (default 20)
//   audio=dummy      SDL's dummy audio driver
//   video=native     leave the video mode to the game (its default, fullscreen: a canvas the size of the
//                    window), as the runner did before the page existed
//   nofetch=1        do not fetch the IWAD, though the game is told where it would be (a missing IWAD)
//   raw=1            with iwad=URL: put the file into /work as it is, under its URL's name: no checks, no cache, no IndexedDB
//                    (the runner's way; tests/tools/run-wasm.js)
//   idb=off          the data cache's IndexedDB is unavailable (the game's /persist is not touched: see persist=0)
//   idb=quota        storing the data in IndexedDB fails with a QuotaExceededError
//   sha=js           hash with the plain JavaScript SHA-256 (what a page without crypto.subtle uses)
//   stall=MS         stop a download after MS ms without data (default 30000)
//   relay=URL        (brief 04) the vnet relay's WebSocket URL, ws://HOST:PORT/vnet, in place of config.js's relay. The page passes
//                    the relay to the game as -relay URL; without ?test=1 the address bar cannot change it
//   relay_wt=URL     the relay's WebTransport URL (https://HOST:PORT/vnet): tried first; needs relay_cert on a development relay
//   relay_cert=HEX   the SHA-256 of the relay's -dev-cert certificate (64 hex digits), given to the browser as serverCertificateHashes
//   impair=SPEC      vnet's impairment spec, e.g. lat=30,jit=10,loss=3,dup=2,reorder=3,seed=7 (VNET_IMPAIR: a browser has no environment)
//                    a malformed or over-long value of these four is refused with a message and the game does not start
//   window.dlNet     what the page shows about the network game: {kind, text}; kind 0 none, 1 connecting, 2 in a room, 3 ended
//   window.dlData    what the loader produced (source, from, name, game, size, sha256, cached, notes, hashMs, ...)
//   window.dlStarts  how many times the page called callMain
//   window.dlProgress  each progress report of the download: [bytes so far, total or 0 when unknown]
//   window.dlPersistent  the answer of navigator.storage.persist(), once the data was stored
//   Module.dlYields  each yield: [the game gave control away, the page resumed it, the game was running again]
//   window.dlMouse   mouse movements seen on the page (all, while locked, their sum)
//   window.dlTest    FS, readFile, writeFile, listFiles, syncNow, quit() (the game quits at its next tic, as -testquit does); window.dlOut and dlErr (the game's
//                    output), window.dlExit ({code}), window.dlState, Module.dlFrameLog (when the game
//                    presented a frame, performance.now())
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TEST = params.get('test') === '1';
  var PERSIST = !(TEST && params.get('persist') === '0');
  var HOME_DIR = (TEST && params.get('home')) || '/persist';
  var WORK_DIR = '/work';
  var CLOSE_DELAY_MS = 10;
  var NOLOCK = TEST && params.get('nolock') === '1';

  // ---- The relay (brief 04) ---------------------------------------------------------------------------
  // The relay is config.js's (DL_CONFIG.relay); a test page (?test=1) can take another from the address bar, with
  // the knobs for a development relay. Nothing in the address bar has any effect without ?test=1.
  var RELAY_RE = /^wss?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[0-9]{1,5})?\/[\x21-\x7e]*$/i;
  var NET = { relay: '', relayWt: '', relayCert: '', impair: '', error: '', note: '' };
  (function () {
    var cfg = window.DL_CONFIG && window.DL_CONFIG.relay;
    if (cfg) {
      if (typeof cfg === 'string' && cfg.length <= 150 && RELAY_RE.test(cfg)) { NET.relay = cfg; }
      else { NET.note = 'config.js: relay is not a ws:// or wss:// URL (ws://HOST:PORT/vnet): no network game is offered.'; }
    }
    if (!(params.get('test') === '1')) { return; }
    function knob(name, max, re, what) {
      var v = params.get(name);
      if (v === null || v === '') { return ''; }
      if (v.length > max) { NET.error = NET.error || (name + '= is ' + v.length + ' characters long (at most ' + max + '): ' + what); return ''; }
      if (!re.test(v)) { NET.error = NET.error || (name + '= is not valid: ' + what); return ''; }
      return v;
    }
    var r = knob('relay', 150, RELAY_RE, 'give the relay as ws://HOST:PORT/vnet or wss://HOST/vnet');
    if (r) { NET.relay = r; }
    NET.relayWt = knob('relay_wt', 190, /^https:\/\/[\x21-\x7e]+$/i, 'give the WebTransport address as https://HOST:PORT/vnet');
    NET.relayCert = knob('relay_cert', 64, /^[0-9a-f]{64}$/i, 'give the certificate hash as 64 hex digits');
    NET.impair = knob('impair', 120, /^[a-z]+=[0-9.]+(,[a-z]+=[0-9.]+)*$/, 'for example lat=30,jit=10,loss=3,dup=2,reorder=3,seed=7');
  })();

  var canvas = document.getElementById('canvas');
  var overlay = document.getElementById('overlay');
  var statusEl = document.getElementById('status');
  var progressEl = document.getElementById('progress');
  var startBtn = document.getElementById('start');
  var reloadBtn = document.getElementById('reload');
  var helpEl = document.getElementById('help');
  var dataInfoEl = document.getElementById('datainfo');
  var notesEl = document.getElementById('notes');
  var pickWrap = document.getElementById('pickwrap');
  var pickInput = document.getElementById('pick');
  var retryBtn = document.getElementById('retry');
  var redownloadBtn = document.getElementById('redownload');
  var useDownloadBtn = document.getElementById('usedownload');
  var testInfoEl = document.getElementById('testinfo');
  var netBar = document.getElementById('netbar');

  var FS = null;
  var running = false;
  var ended = false;
  var storageNote = '';
  var dataName = '';        // the file name the game is given (/work/NAME), once the data is there
  var exitedAt = 0;

  window.dlState = 'loading';
  window.dlStarts = 0;
  window.dlOut = [];
  window.dlErr = [];
  window.dlSyncs = 0;
  function setState(s) { window.dlState = s; }

  function showStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'error' : '';
  }
  function describe(e) { return (e && (e.message || e.name)) ? (e.message || e.name) : String(e); }

  // The end: a message and a reload button, never a frozen picture.
  function finish(message, isError, replace) {
    if (ended && !replace) { return; }
    ended = true;
    running = false;
    setState(isError ? 'error' : 'ended');
    overlay.hidden = false;
    progressEl.hidden = true;
    startBtn.hidden = true;
    helpEl.hidden = true;
    dataUi(false);
    showStatus(message, isError);
    reloadBtn.hidden = false;
    reloadBtn.focus();
  }
  reloadBtn.addEventListener('click', function () { location.reload(); });

  // What the game printed (stdout and stderr), for the end message and the tests.
  var errLines = [];
  function capped(arr, max) { if (arr.length > max) { arr.splice(0, max / 2); } return arr; }

  // The game ended with an error: its own words, from stderr: the "Error: ..." line and the few lines before it, which
  // say what could not be found ("Warn: IWAD ... not found").
  function gameWords() {
    var i = -1;
    for (var k = errLines.length - 1; k >= 0; k--) { if (/^Error: /.test(errLines[k])) { i = k; break; } }
    if (i < 0) { return ''; }
    // what it could not find: the last few lines before the error that say so (the rest is the search list)
    var why = errLines.slice(Math.max(0, i - 40), i).filter(function (l) { return /^Warn: |not found|Does not have|Cannot|Couldn't|can't/i.test(l); }).slice(-3);
    return why.concat(errLines[i]).map(function (l) { return l.replace(/^(Error|Warn): /, ''); }).filter(function (l) { return /\S/.test(l); }).join('\n');
  }

  var Module = {
    canvas: canvas,
    noInitialRun: true,
    print: function (text) {
      console.log(text);
      capped(window.dlOut, 20000).push(text);
    },
    printErr: function (text) {
      console.warn(text);
      capped(errLines, 400).push(text);
      capped(window.dlErr, 20000).push(text);
    },
    setStatus: function (text) {
      var m = /\((\d+)\/(\d+)\)/.exec(text || '');
      if (m && +m[2] > 0) { progressEl.hidden = false; progressEl.value = 100 * +m[1] / +m[2]; }
    },
    preRun: [function (m) {
      // the environment is read when the runtime starts
      if (TEST && params.get('audio') === 'dummy') { m.ENV.SDL_AUDIODRIVER = 'dummy'; }
      // The game finds the relay and the test knobs in its environment (src/i_vnet.c): DL_RELAY says the page offers a
      // network game, the others are only ever set on a test page.
      if (NET.relay) { m.ENV.DL_RELAY = NET.relay; }
      if (NET.relayWt) { m.ENV.DL_RELAY_WT = NET.relayWt; }
      if (NET.relayCert) { m.ENV.DL_RELAY_CERT = NET.relayCert; }
      if (NET.impair) { m.ENV.VNET_IMPAIR = NET.impair; }
    }],
    onRuntimeInitialized: function () { prepare().catch(function (e) { finish('Could not start: ' + describe(e), true); }); },
    // exit() was called somewhere in the game (I_Quit, I_Error), or main returned.
    onExit: function (code) {
      window.dlExit = { code: code };
      exitedAt = performance.now();
      stopSyncing();
      var words = gameWords();
      var msg = code === 0 ? 'The game has ended.' : 'The game stopped with an error (exit status ' + code + ').';
      if (code !== 0 && words) { msg += '\n' + words; }
      msg += '\nReload the page to play again.';
      syncNow().then(function () { finish(msg, code !== 0); },
                     function () { finish(msg + '\n(Saving to the browser failed.)', code !== 0); });
    },
    onAbort: function (what) {
      finish('The game crashed: ' + describe(what) + '\nReload the page to try again.', true);
    }
  };
  window.Module = Module;
  // What the game says about the network game (src/sdl/i_web.c, I_Web_NetStatus): shown under the picture and kept in
  // window.dlNet. 3 is a network game that ended (the relay failed, the host went): it stays until the next one.
  window.dlNet = { kind: 0, text: '' };
  Module.dlNetStatus = function (kind, text) {
    window.dlNet = { kind: kind, text: text };
    netBar.textContent = text;
    netBar.className = kind === 3 ? 'ended' : '';
    netBar.hidden = !(kind > 0 && text);
  };
  if (TEST) {
    if (params.get('fast') === '1') {
      Module.dlFast = 1;
      // Test pacing: nothing is shown, so the browser has nothing to composite. A headless Chromium without a GPU
      // reads every presented frame back from WebGL and the game then waits for it; hidden, the frames cost the game
      // nothing (the demo tests ran as fast as the CPU allows before the page existed).
      canvas.style.display = 'none';
      window.addEventListener('resize', function () { canvas.style.display = 'none'; });
    }
    if (params.get('fastms')) { Module.dlFastMs = +params.get('fastms'); }
    Module.dlFrameLog = [];
    Module.dlYields = [];     // each yield: [gave control away, resumed by the page, running again] (performance.now())
  }

  // A trap in WebAssembly would otherwise freeze the picture. Errors from elsewhere (an extension) are logged.
  function fromGame(err, file) {
    if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) { return true; }
    var where = (file || '') + ' ' + ((err && err.stack) || '');
    return /(^|\/)(doomlegacy|page)\.(js|wasm)/.test(where) || /doomlegacy\.wasm/.test(where);
  }
  function gameError(err, file) {
    if (!fromGame(err, file)) { return false; }
    if (err && err.name === 'ExitStatus') { return false; }     // how exit() unwinds
    var refusal = typeof DOMException !== 'undefined' && err instanceof DOMException;
    if (exitedAt > 0 && refusal) { return false; }
    if (running) { return true; }
    return exitedAt > 0 && performance.now() - exitedAt < 250;
  }
  window.addEventListener('error', function (e) {
    if (gameError(e.error, e.filename)) { finish('Something went wrong: ' + describe(e.error || e) + '\nReload the page to try again.', true, true); }
    else { console.warn('page error (not from the game):', describe(e.error || e)); }
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (gameError(e.reason)) { finish('Something went wrong: ' + describe(e.reason) + '\nReload the page to try again.', true, true); return; }
    console.warn('unhandled rejection (not from the game):', describe(e.reason));
  });

  // ---- Files ------------------------------------------------------------------------------------------

  function exists(path) { try { FS.stat(path); return true; } catch (e) { return false; } }
  function syncfs(populate) {
    return new Promise(function (resolve, reject) {
      FS.syncfs(populate, function (err) { if (err) { reject(err); } else { resolve(); } });
    });
  }

  // What is in the persisted folder, without log.txt (the game keeps it open and writes it all the time).
  function walk(dir, out) {
    FS.readdir(dir).forEach(function (name) {
      if (name === '.' || name === '..') { return; }
      var p = dir + '/' + name;
      var st;
      try { st = FS.stat(p); } catch (e) { return; }
      if (FS.isDir(st.mode)) { walk(p, out); } else if (name !== 'log.txt') { out.push(p + ':' + st.size + ':' + (+st.mtime)); }
    });
    return out;
  }
  function persistSignature() { return walk(HOME_DIR, []).sort().join('|'); }

  var lastSignature = '';
  var writing = false;
  var current = Promise.resolve();
  var queued = null;
  var syncTimer = 0;
  var closeTimer = 0;

  function run() {
    writing = true;
    var sig = persistSignature();
    current = syncfs(false).then(function () { lastSignature = sig; window.dlSyncs++; writing = false; },
      function (e) { writing = false; console.warn('Saving to the browser failed:', e); throw e; });
    return current;
  }
  // Writes the persisted folder to IndexedDB. A request that arrives while a write is running is not dropped:
  // one more write follows it (several requests share that one), and the promise settles when the write that
  // covers this request has finished.
  function syncNow() {
    if (!PERSIST) { return Promise.resolve(); }
    if (!writing) { return run(); }
    if (!queued) {
      var go = function () { queued = null; return run(); };
      queued = current.then(go, go);
    }
    return queued;
  }
  function syncIfChanged() { if (persistSignature() !== lastSignature) { syncNow().catch(function () {}); } }

  function startSyncing() {
    if (!PERSIST) { return; }
    lastSignature = persistSignature();
    // The game writes its files with plain C file calls. Watch the closes of files opened for writing in the
    // persisted folder (a saved game, config.cfg) and write to IndexedDB a moment after the last one.
    var realClose = FS.close;
    FS.close = function (stream) {
      var path = stream && stream.path;
      var wrote = stream && (stream.flags & 3) !== 0;
      var r = realClose.apply(FS, arguments);
      if (wrote && path && path.indexOf(HOME_DIR + '/') === 0 && !/\/log\.txt$/.test(path)) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(function () { syncNow().catch(function () {}); }, CLOSE_DELAY_MS);
      }
      return r;
    };
    // A safety net for anything changed without a close.
    syncTimer = setInterval(syncIfChanged, 1000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { syncIfChanged(); } });
    window.addEventListener('pagehide', syncIfChanged);
  }
  function stopSyncing() { clearInterval(syncTimer); }

  function fetchBytes(url, label) {
    return fetch(url).then(function (resp) {
      if (!resp.ok) { throw new Error(label + ': ' + url + ' answered ' + resp.status + ' ' + resp.statusText); }
      var total = +resp.headers.get('content-length') || 0;
      if (!resp.body || !resp.body.getReader) { return resp.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
      var reader = resp.body.getReader();
      var chunks = [];
      var got = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { return; }
          chunks.push(r.value);
          got += r.value.length;
          if (total) {
            progressEl.hidden = false;
            progressEl.value = 100 * got / total;
            showStatus(label + ': ' + (got / 1048576).toFixed(1) + ' of ' + (total / 1048576).toFixed(1) + ' MB');
          }
          return pump();
        });
      }
      return pump().then(function () {
        var out = new Uint8Array(got);
        var at = 0;
        chunks.forEach(function (c) { out.set(c, at); at += c.length; });
        progressEl.hidden = true;
        return out;
      });
    }, function (e) { throw new Error(label + ': could not fetch ' + url + ' (' + describe(e) + ')'); });
  }

  // ---- The game data ----------------------------------------------------------------------------------

  var CONFIG = (window.DL_CONFIG && window.DL_CONFIG.data) || { url: 'doom1.wad', name: 'doom1.wad', size: 0, sha256: '', revalidate: false };
  var OVERRIDE = params.get('iwad') || '';
  var loadSeq = 0;
  var loadCtl = null;
  var lastRequest = {};

  function bytesText(n) { return (n / 1048576).toFixed(1) + ' MB'; }

  // Where the game's file name comes from when the data is not fetched (nofetch=1) or placed as it is (raw=1): the URL's name.
  function urlFileName(u) {
    var n = '';
    try { n = decodeURIComponent(new URL(u, location.href).pathname.split('/').pop()); } catch (e) { /* below */ }
    n = n.replace(/[^A-Za-z0-9._-]/g, '_');
    return /\.wad$/i.test(n) && n.toLowerCase() !== 'legacy.wad' ? n : 'game.wad';      // legacy.wad is the build's own file
  }

  function dataOptions() {
    var hooks = {};
    if (TEST) { hooks.idb = params.get('idb') || ''; hooks.sha = params.get('sha') || ''; }
    return {
      url: OVERRIDE || CONFIG.url,
      name: OVERRIDE ? '' : (CONFIG.name || ''),
      size: OVERRIDE ? 0 : (CONFIG.size || 0),
      sha256: OVERRIDE ? '' : (CONFIG.sha256 || ''),
      revalidate: !OVERRIDE && !!CONFIG.revalidate,
      override: !!OVERRIDE,
      keepUrls: [CONFIG.url],
      hooks: hooks,
      stallMs: (TEST && +params.get('stall')) || 30000
    };
  }

  // Which buttons belong to which state. The picker is on the start screen and in every error, not once the game runs.
  function dataUi(on) {
    var st = window.dlState;
    var d = window.dlData;
    var show = on !== false && (st === 'loading' || st === 'nodata' || st === 'ready');
    pickWrap.hidden = !show;
    retryBtn.hidden = !(show && st === 'nodata');
    redownloadBtn.hidden = !(show && st === 'ready' && d && d.source === 'download');
    useDownloadBtn.hidden = !(show && st === 'ready' && d && d.source === 'local');
    dataInfoEl.hidden = !(show && dataInfoEl.textContent);
    notesEl.hidden = !notesEl.textContent;
  }
  function setNotes(list) { notesEl.textContent = list.filter(Boolean).join('\n'); notesEl.hidden = !notesEl.textContent; }

  function describeData(r) {
    var what = r.game + ' (' + r.name + ', ' + bytesText(r.size) + ')';
    var kept = r.cached ? ' Kept in this browser.' : '';
    if (r.source === 'local') {
      var own = 'Game data: your own copy "' + r.fileName + '", ' + what;
      return r.from === 'cache' ? own + ', kept in this browser since ' + new Date(r.storedAt).toLocaleDateString() + '.'
                                : own + ', read from your computer.' + kept;
    }
    var from = r.url || '';
    if (r.from === 'cache') { return 'Game data: ' + what + ', from this browser\'s copy of ' + from + ' (stored ' + new Date(r.storedAt).toLocaleDateString() + ').'; }
    if (r.from === 'revalidated') { return 'Game data: ' + what + ', from this browser\'s copy of ' + from + ' (the server says it has not changed).'; }
    return 'Game data: ' + what + ', downloaded just now from ' + from + '.' + kept;
  }

  function showProgress(got, total) {
    if (TEST) { (window.dlProgress || (window.dlProgress = [])).push([got, total]); }
    progressEl.hidden = false;
    if (total) {
      progressEl.max = 100;
      progressEl.value = 100 * got / total;
      showStatus('Downloading ' + (dataName || 'the game data') + ': ' + bytesText(got) + ' of ' + bytesText(total) + ' (' + Math.floor(100 * got / total) + '%)');
    } else {
      progressEl.removeAttribute('value');      // total unknown: an unfilled bar, and the bytes so far
      showStatus('Downloading the game data: ' + bytesText(got) + ' so far');
    }
  }

  function accept(r) {
    // The file goes in as /work/NAME, where the game looks (-iwad). A file picked earlier under another name goes.
    if (dataName && dataName !== r.name && exists(WORK_DIR + '/' + dataName)) { FS.unlink(WORK_DIR + '/' + dataName); }
    FS.writeFile(WORK_DIR + '/' + r.name, r.bytes);
    dataName = r.name;
    window.dlData = { source: r.source, from: r.from, name: r.name, game: r.game, size: r.size, sha256: r.sha256, cached: r.cached,
                      notes: r.notes.slice(), hashMs: r.hashMs, hashHow: r.hashHow, downloadMs: r.downloadMs, url: r.url, fileName: r.fileName,
                      persistent: window.dlPersistent };
    dataInfoEl.textContent = describeData(r);
    setNotes([storageNote].concat(r.notes));
    progressEl.hidden = true;
    showStatus('');
    setState('ready');
    dataUi();
    startBtn.hidden = false;
    startBtn.focus();
    if (testInfoEl && !testInfoEl.hidden) { testInfoEl.textContent = 'test mode: args=' + JSON.stringify(gameArgs()) + ' persist=' + PERSIST + ' fast=' + !!Module.dlFast; }
  }

  function dataFailed(e) {
    var msg = e && e.name === 'DataError' ? e.message : 'The game data could not be loaded: ' + describe(e);
    dataInfoEl.textContent = '';
    progressEl.hidden = true;
    startBtn.hidden = true;
    setNotes([storageNote]);
    setState('nodata');
    showStatus(msg + '\nPick your own copy of the game data (an IWAD, such as DOOM.WAD or DOOM2.WAD), or try again.', true);
    window.dlData = { error: e && e.kind ? e.kind : 'unknown', message: msg };
    dataUi();
    retryBtn.focus();
  }

  // Gets the data: the download (or the cache), or a File the person picked, or the download again. A request that comes
  // while another runs replaces it: the earlier one is aborted and its result is dropped.
  function loadData(extra) {
    var seq = ++loadSeq;
    if (loadCtl) { loadCtl.abort(); }
    loadCtl = new AbortController();
    lastRequest = extra && !extra.file ? extra : {};
    setState('loading');
    window.dlData = null;
    startBtn.hidden = true;
    showStatus('Loading the game data...');
    progressEl.hidden = true;
    dataInfoEl.textContent = '';
    dataUi();
    var o = Object.assign(dataOptions(), extra || {}, { signal: loadCtl.signal, onProgress: showProgress, onStatus: function (t) { showStatus(t); } });
    return DlData.load(o).then(function (r) { if (seq === loadSeq) { accept(r); } })
      .catch(function (e) { if (seq === loadSeq && !(e && e.kind === 'cancelled')) { dataFailed(e); } });
  }

  pickInput.addEventListener('change', function () {
    var f = pickInput.files && pickInput.files[0];
    pickInput.value = '';
    if (f && !running) { loadData({ file: f }); }
  });
  retryBtn.addEventListener('click', function () { loadData(lastRequest); });
  redownloadBtn.addEventListener('click', function () { loadData({ force: true }); });
  useDownloadBtn.addEventListener('click', function () { loadData({ useDownload: true }); });

  function prepare() {
    if (NET.error) { finish('The address of this test page is not valid: ' + NET.error, true); return Promise.resolve(); }
    FS = Module.FS;
    FS.mkdir(WORK_DIR);
    var ready = Promise.resolve();
    if (PERSIST) {
      FS.mkdir(HOME_DIR);
      FS.mount(Module.IDBFS, {}, HOME_DIR);
      showStatus('Loading saved settings...');
      // Private windows and blocked site data can make IndexedDB fail: play without keeping anything.
      ready = syncfs(true).catch(function (e) {
        PERSIST = false;
        storageNote = 'Saved games and settings will not be kept: this browser would not let the page use its storage (' + describe(e) + ').';
        console.warn('IndexedDB unavailable:', e);
      });
    } else if (!exists(HOME_DIR)) {
      FS.mkdir(HOME_DIR);
    }
    if (NET.note) { storageNote = [storageNote, NET.note].filter(Boolean).join('\n'); }
    return ready.then(function () {
      FS.chdir(WORK_DIR);   // writable: the join's $$$.sav goes to the working directory
      // legacy.wad is part of the build, not game data: served next to the page and left to the HTTP cache (data-hosting.md).
      return fetchBytes('legacy.wad', 'legacy.wad').then(function (b) { FS.writeFile(WORK_DIR + '/legacy.wad', b); });
    }).then(function () {
      var files = TEST ? (params.get('files') || '').split(',').filter(Boolean) : [];
      return files.reduce(function (p, url) {
        return p.then(function () {
          return fetchBytes(url, 'Test file').then(function (b) { FS.writeFile(WORK_DIR + '/' + decodeURIComponent(url.split('?')[0].split('/').pop()), b); });
        });
      }, Promise.resolve());
    }).then(function () {
      startSyncing();
      if (TEST && params.get('nofetch') === '1') {
        // the game is told where the file would be; it is not there
        dataName = urlFileName(OVERRIDE || CONFIG.url);
        setState('ready'); progressEl.hidden = true; showStatus(storageNote); startBtn.hidden = false; startBtn.focus();
        return;
      }
      if (TEST && params.get('raw') === '1' && OVERRIDE) {
        // The runner's way: the file as it is, under its URL's name, with no check and no cache.
        dataName = urlFileName(OVERRIDE);
        return fetchBytes(OVERRIDE, dataName).then(function (b) {
          FS.writeFile(WORK_DIR + '/' + dataName, b);
          window.dlData = { source: 'raw', name: dataName, size: b.length };
          setState('ready'); progressEl.hidden = true; showStatus(storageNote); startBtn.hidden = false; startBtn.focus();
        });
      }
      return loadData();
    });
  }

  // ---- Running ----------------------------------------------------------------------------------------

  function gameArgs() {
    // A 640x480 window: the game's default is "fullscreen", which SDL turns into a canvas the size of the
    // browser window, and that is a different (and large) picture for every window.
    var a = ['-home', HOME_DIR, '-iwad', WORK_DIR + '/' + dataName, '-nomusic', '-noendtext'];
    if (NET.relay) { a.push('-relay', NET.relay); }
    if (!(TEST && params.get('video') === 'native')) { a.push('-window', '-width', '640', '-height', '480'); }
    if (!TEST) { return a; }
    var extra = params.get('args') || '';
    if (/^\s*\[/.test(extra)) { try { return a.concat(JSON.parse(extra).map(String)); } catch (e) { /* as words */ } }
    return a.concat(extra.split(/\s+/).filter(Boolean));
  }

  // The audio must start inside the click. callMain returns at the game's first yield, and SDL opens its audio device
  // many yields (hundreds of ms) later, outside the click: it would only work through the browser's "sticky" activation
  // and SDL's resume timer. So the page makes the AudioContext here, in the click, and hands it to SDL, which uses
  // Module.SDL2.audioContext when it is there (SDL_emscriptenaudio.c). test hook: ?noprime=1 leaves it to SDL.
  function primeAudio() {
    if (TEST && (params.get('noprime') === '1' || params.get('audio') === 'dummy')) { return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { return; }
    try {
      var ctx = new AC();
      if (ctx.state === 'suspended') { ctx.resume().catch(function () {}); }
      Module.SDL2 = Module.SDL2 || {};
      Module.SDL2.audioContext = ctx;
    } catch (e) { console.warn('could not create the audio context in the click:', e); }
  }

  function start() {
    if (running || ended || window.dlState !== 'ready') { return; }
    startBtn.hidden = true;
    overlay.hidden = true;
    helpEl.hidden = false;
    running = true;
    window.dlStarts++;
    setState('running');
    dataUi(false);
    canvas.focus();
    fit();
    primeAudio();
    try {
      Module.callMain(gameArgs());
    } catch (e) {
      if (e === 'unwind') { return; }                       // ASYNCIFY suspended main, as it should
      if (e && e.name === 'ExitStatus') { return; }         // exit(), reported by onExit
      finish('The game could not start: ' + describe(e), true);
    }
  }
  startBtn.addEventListener('click', start);

  // ---- Canvas size ------------------------------------------------------------------------------------

  // The picture is the video mode the game chose (320x200 to begin with); scale it to the window, keeping
  // its shape. A 320x200 picture is shown 4:3, as on a monitor of the day. SDL sets the canvas size itself,
  // so this runs from outside, now and then.
  function fit() {
    var w = canvas.width, h = canvas.height;
    if (!w || !h) { return; }
    var shapeH = Math.abs(w / h - 1.6) < 0.01 ? w * 3 / 4 : h;
    var helpH = helpEl.hidden ? 0 : helpEl.offsetHeight + 10;
    var availW = document.documentElement.clientWidth - 32;
    var availH = window.innerHeight - helpH - 32;
    var scale = Math.max(0.25, Math.min(availW / w, availH / shapeH));
    canvas.style.width = Math.floor(w * scale) + 'px';
    canvas.style.height = Math.floor(shapeH * scale) + 'px';
  }
  window.addEventListener('resize', fit);
  setInterval(fit, 500);
  fit();

  // ---- Keys the browser would use -----------------------------------------------------------------------

  // While the game runs, the keys it uses must not scroll or navigate the page: arrows, Space, Tab, Backspace,
  // page keys and F1 to F11 (F5 reloads and F11 is full screen in a browser, and both are game keys), also with Alt held
  // (Alt+Left is "back"; Alt is the game's strafe key). F12 (developer tools) and Ctrl+R, Ctrl+L stay the browser's.
  // Ctrl is the game's fire key.
  // Not the keys that type text (Space, ' and /): preventing the default of their keydown stops the browser's
  // keypress, and with it SDL's text input (a space typed in the console or in a saved game's name). Those are
  // stopped at keypress, which is where Firefox starts its quick find and where a page scrolls on Space.
  var GAME_KEYS = /^(Arrow(Up|Down|Left|Right)|Tab|Backspace|Page(Up|Down)|Home|End|F([1-9]|10|11))$/;
  // SDL keeps the default of every key it handles, which would take F12 and Ctrl+R from the browser: those never reach it.
  function browserKey(e) {
    return e.code === 'F12' || ((e.ctrlKey || e.metaKey) && (e.code === 'KeyR' || e.code === 'KeyL'));
  }
  ['keydown', 'keyup', 'keypress'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (!running) { return; }
      if (type !== 'keypress' && browserKey(e)) { e.stopImmediatePropagation(); return; }
      if (type === 'keydown' && GAME_KEYS.test(e.code)) { e.preventDefault(); }
      if (type === 'keypress' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); }
    }, true);
  });
  window.addEventListener('keydown', function (e) { if (e.code === 'Escape') { lastEscape = performance.now(); } }, true);

  // ---- Escape and the mouse ---------------------------------------------------------------------------

  // The game takes the mouse (pointer lock) while a level plays and uses Escape for its menu. A browser takes
  // Escape to leave pointer lock and then does not deliver it to the page, so when the lock is lost and the
  // game did not ask for that, give the game the Escape it would have had.
  var gameReleasedLock = false;
  var lastEscape = 0;
  if (document.exitPointerLock) {
    var realExit = document.exitPointerLock.bind(document);
    document.exitPointerLock = function () { gameReleasedLock = true; return realExit(); };
  }

  // A refused pointer lock or audio resume is normal, not a crash: the browser refuses a request while the
  // document has no focus, and Emscripten's helpers drop the rejected promise. Log it once, quietly.
  var refusalBursts = {};
  function logRefusal(what, e) {
    var b = refusalBursts[what] || (refusalBursts[what] = { more: 0, timer: 0 });
    if (b.timer) { b.more++; clearTimeout(b.timer); } else { console.warn(what + ' refused:', describe(e)); }
    b.timer = setTimeout(function () {
      if (b.more) { console.warn(what + ' refused ' + b.more + ' more time' + (b.more === 1 ? '' : 's') + ' (the same way)'); }
      b.more = 0; b.timer = 0;
    }, 1000);
  }
  function quietRefusal(obj, name, what) {
    var real = obj[name];
    if (typeof real !== 'function') { return; }
    obj[name] = function () {
      var r;
      try { r = real.apply(this, arguments); } catch (e) {
        var p = Promise.reject(e);
        p.then(null, function (x) { logRefusal(what, x); });
        return p;
      }
      if (r && typeof r.then === 'function') { r.then(null, function (e) { logRefusal(what, e); }); }
      return r;
    };
  }
  quietRefusal(canvas, 'requestPointerLock', 'pointer lock');
  quietRefusal(canvas, 'requestFullscreen', 'fullscreen');
  quietRefusal(document, 'exitFullscreen', 'leaving fullscreen');
  if (window.AudioContext) { quietRefusal(window.AudioContext.prototype, 'resume', 'audio resume'); }

  document.addEventListener('pointerlockchange', function () {
    if (document.pointerLockElement) { gameReleasedLock = false; return; }
    if (gameReleasedLock) { gameReleasedLock = false; return; }
    if (!running || !document.hasFocus() || performance.now() - lastEscape < 300) { return; }
    var init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    // Held long enough for the game's next pass over its input.
    setTimeout(function () { window.dispatchEvent(new KeyboardEvent('keyup', init)); }, 100);
  });

  // The mouse. The game wants it (Module.dlMouseGrab(true), from I_GrabMouse in src/sdl/i_system.c) while a level plays
  // and not in a menu. The page then locks the pointer: at once if the player's last key press or click is recent (the
  // browser only allows it then), else at the next click on the picture. While it is locked, each movement goes to the
  // game (dl_mouse_motion). SDL's own mouse mode is not used (src/sdl/i_web.c says why); SDL gets no mouse movement,
  // only the buttons.
  var wantGrab = false;
  function tryLock() {
    if (!wantGrab || !running || document.pointerLockElement || NOLOCK) { return; }
    if (navigator.userActivation && !navigator.userActivation.isActive) { return; }    // the next click will do
    canvas.requestPointerLock();
  }
  Module.dlMouseGrab = function (on) {
    wantGrab = !!on;
    if (wantGrab) { tryLock(); } else if (document.pointerLockElement) { document.exitPointerLock(); }
  };
  window.addEventListener('mousedown', function () { tryLock(); }, true);
  var carryX = 0, carryY = 0;
  window.addEventListener('mousemove', function (e) {
    var locked = document.pointerLockElement === canvas || (TEST && window.dlTest && window.dlTest.passMouse === true);   // (passMouse: a test's sabotage)
    if (e.target === canvas || locked) { e.stopImmediatePropagation(); }
    if (TEST) { var m = window.dlMouse || (window.dlMouse = { moves: 0, lockedMoves: 0, dx: 0, dy: 0 }); m.moves++; if (locked) { m.lockedMoves++; m.dx += e.movementX; m.dy += e.movementY; } }
    if (!locked || !running || !Module._dl_mouse_motion) { return; }
    // movementX can be fractional: keep what the whole numbers leave
    carryX += e.movementX; carryY += e.movementY;
    var dx = Math.trunc(carryX), dy = Math.trunc(carryY);
    carryX -= dx; carryY -= dy;
    if (dx || dy) { Module._dl_mouse_motion(dx, dy); }
  }, true);
  ['mouseenter', 'mouseleave'].forEach(function (type) {
    window.addEventListener(type, function (e) { if (e.target === canvas) { e.stopImmediatePropagation(); } }, true);
  });

  // ---- Test hooks -------------------------------------------------------------------------------------

  if (TEST) {
    testInfoEl.hidden = false;
    testInfoEl.textContent = 'test mode: args=' + JSON.stringify(gameArgs()) + ' persist=' + PERSIST + ' fast=' + !!Module.dlFast;
    window.dlTest = {
      get FS() { return FS; },
      start: start,
      readFile: function (name) {
        try { return FS.readFile(name.charAt(0) === '/' ? name : WORK_DIR + '/' + name); } catch (e) { return null; }
      },
      writeFile: function (name, bytes) { FS.writeFile(name.charAt(0) === '/' ? name : WORK_DIR + '/' + name, bytes); },
      listFiles: function (dir) { return FS.readdir(dir || WORK_DIR).filter(function (n) { return n !== '.' && n !== '..'; }); },
      syncNow: syncNow,
      quit: function () { Module.dlQuitNow = true; }
    };
  }

  // ---- Load the game ----------------------------------------------------------------------------------

  var script = document.createElement('script');
  script.src = 'doomlegacy.js';
  script.onload = function () {
    showStatus('Starting...');
    createDoomLegacy(Module).catch(function (e) { finish('Could not start: ' + describe(e), true); });
  };
  script.onerror = function () { finish('Could not load doomlegacy.js. Is the page served with the build next to it?', true); };
  document.head.appendChild(script);
})();
