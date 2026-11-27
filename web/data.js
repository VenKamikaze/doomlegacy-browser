// SPDX-License-Identifier: GPL-2.0-or-later
//
// Game data for the browser build (brief 03): download, check, cache, pick a local copy.
// No page code here: page.js shows the progress and the messages and writes the file for the game.
// The structure follows jfsw-browser's web/data.js (the user's own work, GPL), with SHA-256 and IWAD checks.
//
//   DlData.load(options) -> Promise of the data (see load() below); rejects with a DataError whose
//   `kind` is http, network, truncated, size, corrupt, notiwad or cancelled.
//   DlData.sha256(bytes, forceJs), DlData.inspect(bytes), DlData.identify(size, sha256), DlData.forgetAll().
//
// The cache is an IndexedDB database of its own, "doomlegacy-data" (not the game's /persist folder,
// which is IDBFS). Store "files": one record per source, key "url:<absolute url>" for a download and
// "local" for the file the person picked. Store "meta": { key: 'source', value: 'url' | 'local' }.
// A record: { key, schema, config (the signature it was stored under), size, sha256, bytes (ArrayBuffer),
// name (the file name the game gets), url, fileName, etag, lastModified, storedAt }.
(function () {
  'use strict';

  var KNOWN = window.DL_IWADS || [];
  var DB_NAME = 'doomlegacy-data';
  var SCHEMA = 1;
  var LOCAL_KEY = 'local';

  // ---- Errors ------------------------------------------------------------------------------------------

  function DataError(kind, message, extra) {
    var e = new Error(message);
    e.name = 'DataError';
    e.kind = kind;
    if (extra) { Object.keys(extra).forEach(function (k) { e[k] = extra[k]; }); }
    return e;
  }

  // ---- SHA-256 -----------------------------------------------------------------------------------------

  // crypto.subtle exists only in a secure context (https, localhost); a page served over plain http from a LAN
  // address has none, so there is a plain JavaScript version too (about 4 times slower, still 0.1 s for 4 MB).
  var K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function compress(h, w, buf, off) {
    var i, a, b, c, d, e, f, g, hh, t1, t2, x, y;
    for (i = 0; i < 16; i++, off += 4) { w[i] = (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]; }
    for (; i < 64; i++) {
      x = w[i - 15]; y = w[i - 2];
      w[i] = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] +
              (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
    }
    a = h[0]; b = h[1]; c = h[2]; d = h[3]; e = h[4]; f = h[5]; g = h[6]; hh = h[7];
    for (i = 0; i < 64; i++) {
      t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  function sha256js(bytes) {
    var h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var w = new Int32Array(64);
    var n = bytes.length, full = n - (n % 64), i;
    for (i = 0; i < full; i += 64) { compress(h, w, bytes, i); }
    var tail = new Uint8Array(n - full + 9 <= 64 ? 64 : 128);
    tail.set(bytes.subarray(full));
    tail[n - full] = 0x80;
    var bits = n * 8, end = tail.length;
    tail[end - 4] = (bits >>> 24) & 255; tail[end - 3] = (bits >>> 16) & 255; tail[end - 2] = (bits >>> 8) & 255; tail[end - 1] = bits & 255;
    tail[end - 5] = Math.floor(n / 536870912) & 255;      // the high bits of the bit count (files over 512 MB are not a concern)
    for (i = 0; i < end; i += 64) { compress(h, w, tail, i); }
    var out = '';
    for (i = 0; i < 8; i++) { out += ('00000000' + (h[i] >>> 0).toString(16)).slice(-8); }
    return out;
  }
  function toHex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) { s += (b[i] < 16 ? '0' : '') + b[i].toString(16); }
    return s;
  }
  // Resolves { hex, ms, how: 'subtle' | 'js' }.
  function sha256(bytes, forceJs) {
    var t0 = performance.now();
    if (!forceJs && window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', bytes).then(function (d) { return { hex: toHex(d), ms: performance.now() - t0, how: 'subtle' }; });
    }
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ hex: sha256js(bytes), ms: performance.now() - t0, how: 'js' }); }, 0);
    });
  }

  // ---- What an IWAD is -----------------------------------------------------------------------------------

  var GAMES = {
    'doom1.wad': 'Doom shareware', 'doom.wad': 'Doom', 'doomu.wad': 'The Ultimate Doom', 'doom2.wad': 'Doom II',
    'plutonia.wad': 'Final Doom: Plutonia', 'tnt.wad': 'Final Doom: TNT Evilution',
    'freedoom1.wad': 'Freedoom: Phase 1', 'freedoom2.wad': 'Freedoom: Phase 2', 'freedm.wad': 'FreeDM',
    'chex1.wad': 'Chex Quest', 'blasphem.wad': 'Blasphemer'
  };

  function identify(size, sha) {
    for (var i = 0; i < KNOWN.length; i++) { if (KNOWN[i].size === size && KNOWN[i].sha256 === sha) { return KNOWN[i]; } }
    return null;
  }

  // The file name the game must be given to pick the right game: src/d_main.c's game_desc_table chooses by file
  // name and then checks key lumps. This follows the table's key lumps (the first name of each entry); '' for a
  // WAD it does not know, which then keeps its own name and the game takes it as "another IWAD".
  function classify(has) {
    if (has.FREEDOOM) {
      if (has.FREEDM) { return 'freedm.wad'; }
      if (has.MAP01) { return 'freedoom2.wad'; }
      if (has.E4M1) { return 'freedoom1.wad'; }
    }
    if (has.BLASPHEM) { return 'blasphem.wad'; }
    if (has.W94_1 && has.POSSH0M0) { return 'chex1.wad'; }
    if (has.MAP01) { return has.CAMO1 ? 'plutonia.wad' : has.REDTNT2 ? 'tnt.wad' : 'doom2.wad'; }
    if (has.E4M1) { return 'doomu.wad'; }
    if (has.E3M9) { return 'doom.wad'; }
    if (has.E1M1) { return 'doom1.wad'; }
    return '';
  }

  // Looks at the bytes of a WAD. Returns { ok: true, lumps, names (set of lump names), game: classify() } or
  // { ok: false, reason: 'tiny' | 'notiwad' | 'pwad' | 'directory', detail }.
  // An IWAD has the header "IWAD", a lump count, and a directory (16 bytes a lump) that lies inside the file, with every
  // lump (that has bytes) inside it too: a cut-off file fails the last two.
  function inspect(b) {
    var size = b.length;
    if (size < 12) { return { ok: false, reason: 'tiny', detail: 'only ' + size + ' bytes' }; }
    var id = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (id === 'PWAD') { return { ok: false, reason: 'pwad', detail: 'a PWAD (a patch for a game), not the game data itself' }; }
    if (id !== 'IWAD') { return { ok: false, reason: 'notiwad', detail: 'it does not start with "IWAD"' }; }
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var n = dv.getInt32(4, true), ofs = dv.getInt32(8, true);
    if (n < 1 || n > 1000000 || ofs < 12 || ofs + n * 16 > size) {
      return { ok: false, reason: 'directory', detail: 'its lump directory (' + n + ' lumps at byte ' + ofs + ') does not lie inside the file' };
    }
    var names = {};
    for (var i = 0; i < n; i++) {
      var at = ofs + i * 16;
      var pos = dv.getInt32(at, true), len = dv.getInt32(at + 4, true);
      if (pos < 0 || len < 0 || (len > 0 && pos + len > size)) {
        return { ok: false, reason: 'directory', detail: 'lump ' + i + ' lies outside the file' };
      }
      var s = '';
      for (var k = 0; k < 8 && b[at + 8 + k]; k++) { s += String.fromCharCode(b[at + 8 + k]); }
      names[s.toUpperCase()] = 1;
    }
    return { ok: true, lumps: n, names: names, game: classify(names) };
  }

  function safeName(n) {
    n = String(n || '').replace(/[^A-Za-z0-9._-]/g, '_');
    return /\.wad$/i.test(n) ? n : (n ? n + '.wad' : 'game.wad');
  }
  function nameOf(url) {
    try { return decodeURIComponent(new URL(url, location.href).pathname.split('/').pop()); } catch (e) { return ''; }
  }
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
  function fmt(n) { return n.toLocaleString('en-US'); }

  // Throws a DataError unless the bytes are a file the game can start with; returns { name, game, entry, info }.
  //   declared { size, sha256, name } from the config (or none); fallback: the name to use for an unknown IWAD.
  function verify(bytes, hash, what, declared, fallback) {
    var size = bytes.length;
    var found = 'Found: ' + fmt(size) + ' bytes, SHA-256 ' + hash + '.';
    var want = declared && (declared.size || declared.sha256)
      ? ' This page expects: ' + (declared.size ? fmt(declared.size) + ' bytes' : 'any size') + (declared.sha256 ? ', SHA-256 ' + declared.sha256 + '.' : '.') : '';
    var info = inspect(bytes);
    if (!info.ok && info.reason !== 'directory') {
      throw DataError('notiwad', what + ' is not a Doom data file (an IWAD): ' + info.detail + '. ' + found + want, { size: size, sha256: hash });
    }
    if (declared && declared.size && size < declared.size) {
      throw DataError('truncated', what + ' is incomplete: only ' + fmt(size) + ' of the ' + fmt(declared.size) + ' bytes arrived, so the download looks cut off. ' + found + want, { size: size, sha256: hash });
    }
    if (declared && declared.size && size !== declared.size) {
      throw DataError('corrupt', what + ' is not the file this page expects: the size is wrong. ' + found + want, { size: size, sha256: hash });
    }
    if (declared && declared.sha256 && hash !== declared.sha256.toLowerCase()) {
      throw DataError('corrupt', what + ' is damaged or is not the file this page expects: its SHA-256 is wrong. ' + found + want, { size: size, sha256: hash });
    }
    if (!info.ok) {
      throw DataError('truncated', what + ' is not a whole IWAD: ' + info.detail + ' (' + fmt(size) + ' bytes), so it looks cut off or damaged.', { size: size, sha256: hash });
    }
    var entry = identify(size, hash);
    var name = (declared && declared.name) || (entry && entry.file) || info.game || safeName(fallback);
    var game = entry ? entry.game : (GAMES[info.game] ? GAMES[info.game] : 'an IWAD the game will identify');
    return { name: name, game: game, entry: entry, info: info };
  }

  // ---- IndexedDB cache -----------------------------------------------------------------------------------

  function openDb(hooks) {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        if (hooks && hooks.idb === 'off') { throw new Error('IndexedDB is switched off (test)'); }
        if (!window.indexedDB) { throw new Error('IndexedDB is not available'); }
        req = window.indexedDB.open(DB_NAME, 1);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        db.createObjectStore('files', { keyPath: 'key' });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('could not open the database')); };
      req.onblocked = function () { reject(new Error('the database is blocked by another tab')); };
    });
  }
  // Runs fn(objectStore) in a transaction; resolves with its request's result when the transaction has committed.
  function run(db, store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx, req, result;
      try {
        tx = db.transaction(store, mode);
        req = fn(tx.objectStore(store));
        if (req) { req.onsuccess = function () { result = req.result; }; }
      } catch (e) { reject(e); return; }
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(tx.error || (req && req.error) || new Error('database error')); };
      tx.onabort = function () { reject(tx.error || new Error('database transaction aborted')); };
    });
  }
  function Cache(db, hooks) { this.db = db; this.hooks = hooks || {}; }
  Cache.prototype.get = function (key) { return run(this.db, 'files', 'readonly', function (s) { return s.get(key); }); };
  Cache.prototype.keys = function () { return run(this.db, 'files', 'readonly', function (s) { return s.getAllKeys(); }); };
  Cache.prototype.del = function (key) { return run(this.db, 'files', 'readwrite', function (s) { return s.delete(key); }); };
  Cache.prototype.put = function (rec) {
    var hooks = this.hooks;
    return run(this.db, 'files', 'readwrite', function (s) {
      // Test hook (?test=1&idb=quota): fail the way a full disk does. A real put() whose data does not fit aborts the
      // transaction with a QuotaExceededError; this throws the same error from inside the transaction, which ends in
      // run()'s reject by the same road (tests/web/data.js also does it for real, with a quota set through the devtools protocol).
      if (hooks.idb === 'quota') { throw new DOMException('simulated: the browser has no space left for this site', 'QuotaExceededError'); }
      return s.put(rec);
    });
  };
  Cache.prototype.getMeta = function (key) {
    return run(this.db, 'meta', 'readonly', function (s) { return s.get(key); }).then(function (r) { return r ? r.value : null; });
  };
  Cache.prototype.setMeta = function (key, value) { return run(this.db, 'meta', 'readwrite', function (s) { return s.put({ key: key, value: value }); }); };

  function forgetAll() {
    return new Promise(function (resolve) {
      try { var r = window.indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = function () { resolve(); }; } catch (e) { resolve(); }
    });
  }

  function storeProblem(e) {
    var quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
    return quota ? 'The browser has no space left to keep the game data' : 'The browser would not keep the game data (' + ((e && e.message) || e) + ')';
  }

  // ---- Download ------------------------------------------------------------------------------------------

  // Fetches `url`. Resolves { bytes, etag, lastModified } or { notModified: true }.
  // o: size (declared, or 0), headers, onProgress(got, total) with total 0 when unknown or not trustworthy, stallMs, signal.
  function download(url, o) {
    var absolute = new URL(url, location.href);
    var crossOrigin = absolute.origin !== location.origin;
    var ctl = new AbortController();
    var stalled = false, timer = 0;
    // Stall detection: no byte for o.stallMs aborts the fetch. o.signal (the person picked a file instead) also aborts it.
    function arm() {
      clearTimeout(timer);
      if (!o.stallMs) { return; }
      timer = setTimeout(function () { stalled = true; ctl.abort(); }, o.stallMs);
    }
    function cancelled() { return !!(o.signal && o.signal.aborted); }
    if (o.signal) { if (o.signal.aborted) { ctl.abort(); } else { o.signal.addEventListener('abort', function () { ctl.abort(); }); } }
    arm();
    // cache: 'no-store': the page keeps its own copy, a second one in the HTTP cache would only take room.
    return fetch(absolute.href, { headers: o.headers || {}, cache: 'no-store', signal: ctl.signal }).then(function (resp) {
      arm();
      if (resp.status === 304 && o.headers && Object.keys(o.headers).length) { return { notModified: true }; }
      if (!resp.ok) {
        throw DataError('http', 'The game data could not be downloaded: ' + absolute.href + ' answered ' + resp.status + (resp.statusText ? ' ' + resp.statusText : '') + '.', { status: resp.status });
      }
      var declared = o.size || 0;
      var length = +resp.headers.get('content-length') || 0;
      var encoded = !!resp.headers.get('content-encoding');
      // The bytes the page sees are decompressed; Content-Length is the compressed size. Trust it for the progress
      // bar only when the response is not encoded; otherwise the declared size, or no total (an unfilled bar).
      var total = declared || (encoded ? 0 : length);
      var expect = declared || (encoded ? 0 : length);
      var meta = { etag: resp.headers.get('etag') || '', lastModified: resp.headers.get('last-modified') || '' };
      var reader = resp.body && resp.body.getReader && resp.body.getReader();
      if (!reader) {
        return resp.arrayBuffer().then(function (ab) { return { bytes: new Uint8Array(ab), etag: meta.etag, lastModified: meta.lastModified }; });
      }
      var buf = declared ? new Uint8Array(declared) : null;
      var chunks = [];
      var got = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { return; }
          var c = r.value;
          arm();
          if (declared && got + c.length > declared) {
            reader.cancel().catch(function () {});
            throw DataError('size', 'The game data from ' + absolute.href + ' is larger than the ' + fmt(declared) + ' bytes this page expects (at least ' + fmt(got + c.length) + ' bytes arrived). It is not the file the page is set up for.', { size: got + c.length });
          }
          if (buf) { buf.set(c, got); } else { chunks.push(c); }
          got += c.length;
          if (o.onProgress) { o.onProgress(got, total && got <= total ? total : 0); }
          return pump();
        });
      }
      return pump().catch(function (e) {
        if (e && e.name === 'DataError') { throw e; }
        if (cancelled()) { throw DataError('cancelled', 'Cancelled.'); }
        if (stalled) {
          throw DataError('truncated', 'The download from ' + absolute.href + ' stalled: no data arrived for ' + (o.stallMs / 1000) + ' seconds (' + fmt(got) + ' bytes' + (expect ? ' of ' + fmt(expect) : '') + ' had arrived). The server may be overloaded or the connection lost.', { received: got });
        }
        throw DataError('truncated', 'The download from ' + absolute.href + ' was cut off after ' + fmt(got) + ' bytes' + (expect ? ' of ' + fmt(expect) : '') + ' (' + ((e && e.message) || e) + ').', { received: got });
      }).then(function () {
        // A short body (the server promised no more than it sent) is judged by verify(): a text file or an error page is
        // "not an IWAD", the front of an IWAD is "incomplete", with the sizes.
        var bytes = buf ? buf.subarray(0, got) : null;
        if (!bytes) {
          bytes = new Uint8Array(got);
          var at = 0;
          chunks.forEach(function (c) { bytes.set(c, at); at += c.length; });
        }
        return { bytes: bytes, etag: meta.etag, lastModified: meta.lastModified };
      });
    }, function (e) {
      if (cancelled()) { throw DataError('cancelled', 'Cancelled.'); }
      if (stalled) { throw DataError('network', 'The server at ' + absolute.origin + ' did not answer within ' + (o.stallMs / 1000) + ' seconds (' + absolute.href + '). It may be down or overloaded.'); }
      // A browser reports a request that CORS blocked exactly like one that never arrived: the page cannot tell them apart.
      var hint = crossOrigin
        ? ' The page is on ' + location.origin + ' and the data is on ' + absolute.origin + ': that server must send an Access-Control-Allow-Origin header (CORS), or the data must be served from the same origin as the page.'
        : '';
      throw DataError('network', 'The game data could not be downloaded from ' + absolute.href + '. The server may be down or unreachable' + (crossOrigin ? ', or it does not allow this page to read it (a browser reports a blocked cross-origin request the same way as a network failure).' : '.') + hint, { crossOrigin: crossOrigin });
    }).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }

  // ---- The whole job -------------------------------------------------------------------------------------

  // What a stored download was stored under: when this changes, the stored copy is not used.
  function sig(o, absolute) { return [SCHEMA, absolute, o.name || '', o.size || 0, (o.sha256 || '').toLowerCase()].join('|'); }

  function usable(rec, o, key, absolute) {
    if (!rec || rec.schema !== SCHEMA || rec.key !== key || rec.config !== sig(o, absolute)) { return false; }
    if (!rec.bytes || rec.bytes.byteLength !== rec.size) { return false; }
    if (o.size && rec.size !== o.size) { return false; }
    return !!rec.name;
  }

  // A stored record is trusted only after its bytes are hashed again (a few ms): IndexedDB, a disk error or an
  // extension could have changed them since they were stored.
  function intact(rec, forceJs) {
    if (!rec.bytes || rec.bytes.byteLength !== rec.size) { return Promise.resolve(false); }
    return sha256(new Uint8Array(rec.bytes), forceJs).then(function (h) { return h.hex === rec.sha256; });
  }

  // Ask the browser not to evict the data under storage pressure. Chromium decides by itself (no prompt: it grants for
  // installed or often visited sites and refuses a new profile); Firefox asks the person. The answer is informational.
  function askPersistent() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        return navigator.storage.persisted().then(function (already) { return already || navigator.storage.persist(); }).then(function (granted) {
          window.dlPersistent = granted;
          return granted;
        }).catch(function () { return false; });
      }
    } catch (e) { /* not available */ }
    return Promise.resolve(false);
  }

  // load(o):
  //   url, name, size, sha256   what to fetch and what is expected (name '', size 0 and sha256 '' declare nothing)
  //   revalidate                ask the server whether a cached download is still current
  //   force                     ignore the cached download and fetch again
  //   file                      a File the person picked: use that instead of the url
  //   useDownload               forget the picked file and use the download
  //   keepUrls                  urls whose records stay though they are not `url` (the configured one, on an ?iwad= visit)
  //   hooks                     test hooks { idb: 'off' | 'quota', sha: 'js' }
  //   stallMs, signal, onProgress(got, total), onStatus(text)
  // Resolves { bytes, source: 'download'|'local', from: 'cache'|'network'|'revalidated'|'picked', notes: [text], name, game,
  //            size, sha256, storedAt, url, fileName, cached (is it in the cache now), hashMs, hashHow, downloadMs }.
  function load(o) {
    var notes = [];
    var cache = null;
    var absolute = new URL(o.url, location.href).href;
    var key = 'url:' + absolute;
    var status = o.onStatus || function () {};
    var forceJs = !!(o.hooks && o.hooks.sha === 'js');
    var keep = (o.keepUrls || []).map(function (u) { return 'url:' + new URL(u, location.href).href; });

    function store(rec) {
      if (!cache) { return Promise.resolve(false); }
      return cache.put(rec).then(function () { return cache.setMeta('source', rec.key === LOCAL_KEY ? 'local' : 'url'); }).then(function () {
        askPersistent();
        return true;
      }, function (e) {
        notes.push(storeProblem(e) + '. The game will start, but ' + (rec.key === LOCAL_KEY ? 'your file will have to be picked again next time.' : 'the data will be downloaded again next time.'));
        return false;
      });
    }
    function newRecord(k, bytes, hash, extra) {
      return Object.assign({ key: k, schema: SCHEMA, config: sig(o, absolute), size: bytes.length, sha256: hash,
                             bytes: bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer, storedAt: Date.now() }, extra);
    }
    function result(rec, from, extra) {
      var entry = identify(rec.size, rec.sha256);
      var cls = GAMES[rec.name] || '';
      return Object.assign({
        bytes: new Uint8Array(rec.bytes), source: rec.key === LOCAL_KEY ? 'local' : 'download', from: from, notes: notes,
        name: rec.name, game: entry ? entry.game : (cls || 'an IWAD the game will identify'), size: rec.size, sha256: rec.sha256,
        storedAt: rec.storedAt, url: rec.url || '', fileName: rec.fileName || '', cached: from !== 'network' && from !== 'picked'
      }, extra);
    }
    function dropLocal() { return cache.del(LOCAL_KEY).then(function () { return cache.setMeta('source', 'url'); }).then(function () { return null; }, function () { return null; }); }

    var opened = openDb(o.hooks).then(function (db) { cache = new Cache(db, o.hooks); }, function (e) {
      notes.push('This browser would not let the page keep the game data (' + ((e && e.message) || e) + '), so ' + (o.file ? 'your file has to be picked again each time.' : 'it is downloaded each time.'));
    });

    return opened.then(function () {
      // A picked file.
      if (o.file) {
        status('Reading ' + o.file.name + '...');
        return o.file.arrayBuffer().then(function (ab) {
          var bytes = new Uint8Array(ab);
          return sha256(bytes, forceJs).then(function (h) {
            var what = 'The file "' + o.file.name + '"';
            var v = verify(bytes, h.hex, what, null, o.file.name);
            var rec = newRecord(LOCAL_KEY, bytes, h.hex, { name: v.name, fileName: o.file.name });
            return store(rec).then(function (stored) { return result(rec, 'picked', { cached: stored, hashMs: h.ms, hashHow: h.how }); });
          });
        });
      }
      // Remove copies of urls that are no longer configured; the picked file is kept.
      var purge = cache ? cache.keys().then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== key && k !== LOCAL_KEY && keep.indexOf(k) < 0; }).map(function (k) { return cache.del(k); }));
      }).catch(function () {}) : Promise.resolve();
      return purge.then(function () {
        if (!cache) { return null; }
        if (o.useDownload) { return dropLocal().then(function () { return 'url'; }); }
        return cache.getMeta('source').catch(function () { return null; });
      }).then(function (source) {
        if (source !== 'local' || o.force) { return null; }
        return cache.get(LOCAL_KEY).then(function (rec) {
          if (!rec || !rec.bytes || rec.bytes.byteLength !== rec.size || !rec.name) { return null; }
          return intact(rec, forceJs).then(function (ok) {
            if (ok) { return result(rec, 'cache'); }
            notes.push('The copy of your own file kept in this browser was damaged and has been discarded; the download is used instead (pick your file again to use it).');
            return dropLocal();
          });
        }, function () { return null; });
      }).then(function (local) {
        if (local) { return local; }
        var cached = cache && !o.force ? cache.get(key).catch(function () { return null; }) : Promise.resolve(null);
        return cached.then(function (rec) {
          var good = usable(rec, o, key, absolute);
          return (good ? intact(rec, forceJs) : Promise.resolve(false)).then(function (ok) {
            if (good && !ok) {
              good = false;
              notes.push('The copy kept in this browser was damaged and has been discarded; downloading it again.');
              if (cache) { cache.del(key).catch(function () {}); }
            }
            var headers = null;
            if (good && o.revalidate && (rec.etag || rec.lastModified)) {
              headers = {};
              if (rec.etag) { headers['If-None-Match'] = rec.etag; }
              if (rec.lastModified) { headers['If-Modified-Since'] = rec.lastModified; }
            } else if (good) {
              return result(rec, 'cache');
            }
            status('Downloading the game data...');
            var t0 = performance.now();
            return download(o.url, { size: o.size, headers: headers, onProgress: o.onProgress, stallMs: o.stallMs, signal: o.signal }).then(function (d) {
              if (d.notModified) { return result(rec, 'revalidated'); }
              status('Checking the file...');
              return sha256(d.bytes, forceJs).then(function (h) {
                var v = verify(d.bytes, h.hex, 'The file from ' + absolute, { size: o.size, sha256: o.sha256, name: o.name }, nameOf(absolute));
                var downloadMs = performance.now() - t0;
                var fresh = newRecord(key, d.bytes, h.hex, { name: v.name, url: absolute, etag: d.etag, lastModified: d.lastModified });
                return store(fresh).then(function (stored) {
                  return result(fresh, 'network', { cached: stored, hashMs: h.ms, hashHow: h.how, downloadMs: downloadMs });
                });
              });
            }, function (e) {
              // Could not ask the server, but a copy that was good is in the browser: use it.
              if (headers && e && (e.kind === 'network' || (e.kind === 'http' && e.status >= 500))) {
                notes.push('The server could not be reached to check for a newer version' + (e.status ? ' (it answered ' + e.status + ')' : '') + '; using the copy kept in this browser.');
                return result(rec, 'cache');
              }
              throw e;
            });
          });
        });
      });
    });
  }

  window.DlData = { load: load, sha256: sha256, sha256js: sha256js, inspect: inspect, identify: identify, classify: classify, forgetAll: forgetAll, GAMES: GAMES, mb: mb, fmt: fmt };
})();
