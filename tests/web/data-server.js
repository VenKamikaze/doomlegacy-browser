// SPDX-License-Identifier: GPL-2.0-or-later
//
// A test server for the data download (brief 03). It serves the build and testdata/ like tests/tools/serve.js and lets
// a test describe how a path answers, and records every request:
//
//   const s = await DataServer.start(root);              // 127.0.0.1, a port of its own
//   s.set('/doom1.wad', { body: buffer, gzip: true, etag: '"v1"', cors: '*' });
//   s.count('/doom1.wad')                                // GET requests for that path so far
//   s.set('/config.js', () => ({ body: 'window.DL_CONFIG = ...', type: 'text/javascript' }))   // a function answers per request
//
// A route: body (Buffer), type, status, gzip (Content-Encoding: gzip; Content-Length is the compressed size unless
// chunked), chunked (no Content-Length), etag (a string; answers 304 to a matching If-None-Match), lastModified,
// cors ('*' or an origin: Access-Control-Allow-Origin, and an answer to the preflight), expose, allowHeaders,
// cutTo (send only the first N bytes, with a matching Content-Length: a short file), dropAfter (promise the whole
// body, send N bytes, then close the connection), stallAfter (send N bytes, then nothing, until the client leaves),
// chunk and gap (send `chunk` bytes at a time, `gap` ms apart: a slow download with progress), delay (ms before answering).
'use strict';
const http = require('http');
const zlib = require('zlib');
const { makeHandler } = require('../tools/serve.js');

class DataServer {
  constructor(root, mounts) {
    this.routes = {};
    this.log = [];
    this.base = makeHandler(root, mounts || {});
    this.sockets = new Set();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
  }
  static async start(root, mounts) {
    const s = new DataServer(root, mounts);
    await new Promise((resolve, reject) => { s.server.once('error', reject); s.server.listen(0, '127.0.0.1', resolve); });
    s.port = s.server.address().port;
    s.origin = `http://127.0.0.1:${s.port}`;
    return s;
  }
  set(path, spec) { this.routes[path] = spec; }
  clear(path) { delete this.routes[path]; }
  count(path, method) { return this.log.filter((r) => r.path === path && (method ? r.method === method : r.method !== 'OPTIONS')).length; }
  requests(path) { return this.log.filter((r) => r.path === path); }
  reset() { this.log = []; }
  async close() {
    for (const s of this.sockets) { s.destroy(); }
    await new Promise((r) => this.server.close(r));
  }

  handle(req, res) {
    const path = req.url.split('?')[0];
    this.log.push({ method: req.method, path, url: req.url, headers: req.headers, at: Date.now() });
    let spec = this.routes[path];
    if (typeof spec === 'function') { spec = spec(req); }
    if (!spec) { return this.base(req, res); }
    const go = () => this.answer(spec, req, res);
    if (spec.delay) { setTimeout(go, spec.delay); } else { go(); }
  }

  answer(spec, req, res) {
    const headers = {};
    if (spec.cors) {
      headers['Access-Control-Allow-Origin'] = spec.cors;
      if (spec.expose) { headers['Access-Control-Expose-Headers'] = spec.expose; }
      if (req.method === 'OPTIONS') {
        headers['Access-Control-Allow-Headers'] = spec.allowHeaders || 'If-None-Match, If-Modified-Since';
        res.writeHead(204, headers); res.end(); return;
      }
    } else if (req.method === 'OPTIONS') { res.writeHead(405); res.end(); return; }
    if (spec.status && spec.status !== 200) {
      res.writeHead(spec.status, Object.assign(headers, { 'Content-Type': 'text/plain' }));
      res.end(spec.text || ('status ' + spec.status)); return;
    }
    let body = spec.body || Buffer.alloc(0);
    headers['Content-Type'] = spec.type || 'application/octet-stream';
    headers['Cache-Control'] = 'no-store';
    if (spec.etag) {
      headers['ETag'] = spec.etag;
      if (req.headers['if-none-match'] === spec.etag) { res.writeHead(304, headers); res.end(); return; }
    }
    if (spec.lastModified) { headers['Last-Modified'] = spec.lastModified; }
    if (spec.gzip) { body = zlib.gzipSync(body, { level: 6 }); headers['Content-Encoding'] = 'gzip'; }
    const sendLen = spec.cutTo !== undefined ? spec.cutTo : body.length;
    if (!spec.chunked) { headers['Content-Length'] = (spec.dropAfter !== undefined || spec.stallAfter !== undefined) ? body.length : sendLen; }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    let limit = sendLen;
    if (spec.dropAfter !== undefined) { limit = spec.dropAfter; }
    if (spec.stallAfter !== undefined) { limit = spec.stallAfter; }
    const chunk = spec.chunk || limit || 1;
    let at = 0;
    const step = () => {
      if (res.destroyed || res.writableEnded) { return; }
      if (at >= limit) {
        if (spec.dropAfter !== undefined) { res.socket.destroy(); }
        else if (spec.stallAfter !== undefined) { /* hold the connection open */ }
        else { res.end(); }
        return;
      }
      const to = Math.min(limit, at + chunk);
      res.write(body.subarray(at, to));
      at = to;
      if (spec.gap) { setTimeout(step, spec.gap); } else { setImmediate(step); }
    };
    step();
  }
}
module.exports = { DataServer };
