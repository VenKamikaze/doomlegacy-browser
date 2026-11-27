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
//   ?iwad=URL     the IWAD to fetch (default freedoom1.wad next to the page). A dev loader; brief 03
//                 replaces it with the real download and cache.
//   ?test=1       test hooks, below
//
// Test hooks, only with ?test=1:
//   args=JSON|TEXT   game arguments after the page's own (a JSON array, or words split at spaces)
//   files=URL,...    fetched into the game's working directory /work before the game starts
//   persist=0        no IndexedDB: config and saved games are in memory (the control run)
//   home=DIR         the game's -home (default /persist, the IndexedDB folder)
//   fast=1           test pacing: yield without waiting for a display frame (src/sdl/i_web.c)
//   fastms=N         ... at most every N ms (default 20)
//   audio=dummy      SDL's dummy audio driver
//   video=native     leave the video mode to the game (its default, fullscreen: a canvas the size of the
//                    window), as the runner did before the page existed
//   nofetch=1        do not fetch the IWAD, though the game is told where it would be (a missing IWAD)
//   Module.dlYields  each yield: [the game gave control away, the page resumed it, the game was running again]
//   window.dlTest    FS, readFile, writeFile, listFiles, syncNow; window.dlOut and dlErr (the game's
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

  var canvas = document.getElementById('canvas');
  var overlay = document.getElementById('overlay');
  var statusEl = document.getElementById('status');
  var progressEl = document.getElementById('progress');
  var startBtn = document.getElementById('start');
  var reloadBtn = document.getElementById('reload');
  var helpEl = document.getElementById('help');
  var testInfoEl = document.getElementById('testinfo');

  var FS = null;
  var running = false;
  var ended = false;
  var storageNote = '';
  var exitedAt = 0;

  window.dlState = 'loading';
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
    showStatus(message, isError);
    reloadBtn.hidden = false;
    reloadBtn.focus();
  }
  reloadBtn.addEventListener('click', function () { location.reload(); });

  // What the game printed (stdout and stderr), for the end message and the tests.
  var errLines = [];
  function capped(arr, max) { if (arr.length > max) { arr.splice(0, max / 2); } return arr; }

  // The game ended with an error: its own words, from stderr ("Error: ..." and the lines after it, or the
  // last warnings, which say what could not be found).
  function gameWords() {
    var i = -1;
    for (var k = errLines.length - 1; k >= 0; k--) { if (/^Error: /.test(errLines[k])) { i = k; break; } }
    var lines = i >= 0 ? errLines.slice(i, i + 6) : errLines.filter(function (l) { return /^Warn: /.test(l); }).slice(-4);
    return lines.map(function (l) { return l.replace(/^(Error|Warn): /, ''); }).filter(Boolean).join('\n');
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
    lastSignature = persistSignature();
    current = syncfs(false).then(function () { window.dlSyncs++; writing = false; },
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

  function iwadUrl() { return params.get('iwad') || 'freedoom1.wad'; }
  function iwadName() {
    var n = '';
    try { n = decodeURIComponent(new URL(iwadUrl(), location.href).pathname.split('/').pop()); } catch (e) { /* below */ }
    n = n.replace(/[^A-Za-z0-9._-]/g, '_');
    return /\.wad$/i.test(n) ? n : 'game.wad';
  }

  function prepare() {
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
    return ready.then(function () {
      FS.chdir(WORK_DIR);   // writable: the join's $$$.sav goes to the working directory
      return fetchBytes('legacy.wad', 'legacy.wad').then(function (b) { FS.writeFile(WORK_DIR + '/legacy.wad', b); });
    }).then(function () {
      if (TEST && params.get('nofetch') === '1') { return; }
      return fetchBytes(iwadUrl(), iwadName()).then(function (b) { FS.writeFile(WORK_DIR + '/' + iwadName(), b); });
    }).then(function () {
      var files = TEST ? (params.get('files') || '').split(',').filter(Boolean) : [];
      return files.reduce(function (p, url) {
        return p.then(function () {
          return fetchBytes(url, 'Test file').then(function (b) { FS.writeFile(WORK_DIR + '/' + decodeURIComponent(url.split('?')[0].split('/').pop()), b); });
        });
      }, Promise.resolve());
    }).then(function () {
      startSyncing();
      setState('ready');
      progressEl.hidden = true;
      showStatus(storageNote);
      startBtn.hidden = false;
      startBtn.focus();
    });
  }

  // ---- Running ----------------------------------------------------------------------------------------

  function gameArgs() {
    // A 640x480 window: the game's default is "fullscreen", which SDL turns into a canvas the size of the
    // browser window, and that is a different (and large) picture for every window.
    var a = ['-home', HOME_DIR, '-iwad', WORK_DIR + '/' + iwadName(), '-nomusic', '-noendtext'];
    if (!(TEST && params.get('video') === 'native')) { a.push('-window', '-width', '640', '-height', '480'); }
    if (!TEST) { return a; }
    var extra = params.get('args') || '';
    if (/^\s*\[/.test(extra)) { try { return a.concat(JSON.parse(extra).map(String)); } catch (e) { /* as words */ } }
    return a.concat(extra.split(/\s+/).filter(Boolean));
  }

  function start() {
    if (running || ended || window.dlState !== 'ready') { return; }
    startBtn.hidden = true;
    overlay.hidden = true;
    helpEl.hidden = false;
    running = true;
    setState('running');
    canvas.focus();
    fit();
    try {
      // The click is the user gesture that lets the game open its audio device.
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

  // While the game runs, the keys it uses must not scroll or navigate the page: arrows, space, Tab, Backspace,
  // page keys and F1 to F4 and F6 to F10. F5 (reload), F11 and F12 (full screen, developer tools) stay the
  // browser's; so does anything with Alt or Meta held (Alt+Left is "back"). Ctrl is the game's fire key.
  var GAME_KEYS = /^(Arrow(Up|Down|Left|Right)|Space|Tab|Backspace|Page(Up|Down)|Home|End|Quote|Slash|F([1-4]|[6-9]|10))$/;
  window.addEventListener('keydown', function (e) {
    if (running && GAME_KEYS.test(e.code) && !e.altKey && !e.metaKey) { e.preventDefault(); }
    if (e.code === 'Escape') { lastEscape = performance.now(); }
  }, true);

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

  // The game gets relative motion only while the pointer is locked. While SDL thinks the pointer is free it
  // turns every mousemove, mouseenter and mouseleave on the canvas into an absolute position and reports the
  // jump as relative motion, which would turn the player's view: pass those events to SDL only while it has
  // been told of the lock (our own copy of the last pointerlockchange: SDL's can come after the event).
  var sdlSeesLock = false;
  document.addEventListener('pointerlockchange', function () { sdlSeesLock = !!document.pointerLockElement; });
  ['mousemove', 'mouseenter', 'mouseleave'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (e.target !== canvas || (sdlSeesLock && document.pointerLockElement === canvas)) { return; }
      e.stopPropagation();
    }, true);
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
      syncNow: syncNow
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
