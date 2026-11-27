#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// A static file server for the wasm build: serves build/wasm/bin (the page, doomlegacy.js and
// .wasm, legacy.wad) and, next to the page, the test data from testdata/: every *.wad
// (doom1.wad is the page's default IWAD, freedoom1.wad and freedoom2.wad are there for ?iwad=) and /demos/NAME for testdata/demos/NAME.
// 127.0.0.1 only. Used by the browser tests and by scripts/serve-wasm.sh.
//
//   node tests/tools/serve.js [--port N] [--root DIR] [--mount /url=FILE]...
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

function dataMounts() {
  const m = {};
  const td = path.join(repo, 'testdata');
  if (fs.existsSync(td)) {
    for (const f of fs.readdirSync(td)) { if (/\.wad$/i.test(f)) { m['/' + f] = path.join(td, f); } }
    const dd = path.join(td, 'demos');
    if (fs.existsSync(dd)) { for (const f of fs.readdirSync(dd)) { m['/demos/' + f] = path.join(dd, f); } }
  }
  return m;
}

// The request handler: root is the build's bin directory, mounts {'/url': 'file'} are added to the test data.
// tests/web/data-server.js wraps it to add its own routes.
function makeHandler(root, mounts) {
  const all = Object.assign(dataMounts(), mounts || {});
  return (req, res) => {
    let url;
    try { url = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); res.end('bad url'); return; }
    let file = all[url];
    if (!file) {
      const rel = path.normalize(url === '/' ? '/index.html' : url);
      file = path.join(root, rel);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  };
}

function serve(root, mounts, port) {
  const server = http.createServer(makeHandler(root, mounts));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 0, '127.0.0.1', () => resolve(server));
  });
}
module.exports = { serve, makeHandler, dataMounts, repo };

if (require.main === module) {
  let port = 8000, root = path.join(repo, 'build', 'wasm', 'bin');
  const mounts = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--port') port = +a[++i];
    else if (a[i] === '--root') root = path.resolve(a[++i]);
    else if (a[i] === '--mount') { const [u, f] = a[++i].split('='); mounts[u] = path.resolve(f); }
    else { console.error('unknown option ' + a[i]); process.exit(2); }
  }
  if (!fs.existsSync(path.join(root, 'doomlegacy.wasm'))) { console.error(root + '/doomlegacy.wasm not found: run scripts/build-wasm.sh'); process.exit(1); }
  serve(root, mounts, port).then((s) => {
    const have = fs.existsSync(path.join(repo, 'testdata', 'doom1.wad'));
    console.log(`serving ${root}\nopen http://127.0.0.1:${s.address().port}/` + (have ? '' : '\n(no testdata/doom1.wad, the page\'s default: run scripts/fetch-test-data.sh, or add ?iwad=URL)'));
  }, (e) => { console.error(e.message); process.exit(1); });
}
