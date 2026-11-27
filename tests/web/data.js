#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The game data download, in the page (brief 03: AC1 to AC8). Playwright + Chromium against a local server
// (tests/web/data-server.js) that can gzip, send ETags, add or leave out CORS headers, answer errors, cut files short
// and drop connections, and records every request. Each test opens a fresh browser context (a fresh profile) unless the
// cache is what is tested.
//
//   node tests/web/data.js
//   DATA_SABOTAGE=nocache|nohash|nolocal|capitals|heretic|ownname|override|legacy|abort|purgefirst|revalfall|picker node tests/web/data.js    # a loader that ignores the cache / skips the
//                                                                  # SHA-256 check / does not cache picked files: the checks must FAIL
//
//  1. first load (AC1): progress, the game starts, the cache holds the file
//  2. cached load (AC2): no request for the IWAD
//  3. bad files (AC3): a flipped byte, a short file, a dropped connection, random bytes, a text file
//  4. HTTP errors and CORS (AC4)
//  5. a compressed response (AC5)
//  6. the file picker (AC6)
//  7. a quota failure and no IndexedDB (AC7)
//  8. a changed configuration (AC8)
//  9. "Download again", a conditional request (opt-in), a stalled download, the JavaScript SHA-256, hooks without ?test=1,
//     text only through textContent
// Needs scripts/build-wasm.sh and scripts/fetch-test-data.sh.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const t = require('./lib.js');
const { DataServer } = require('./data-server.js');

const SABOTAGE = process.env.DATA_SABOTAGE || '';
const td = (f) => path.join(t.root, 'testdata', f);
const DOOM1 = fs.readFileSync(td('doom1.wad'));
const FD1 = fs.readFileSync(td('freedoom1.wad'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DOOM1_SHA = sha(DOOM1);
const FD1_SHA = sha(FD1);
const ARGS = encodeURIComponent(JSON.stringify(['-nosound']));
const QUERY = (extra) => '?test=1&audio=dummy&persist=0&args=' + ARGS + (extra ? '&' + extra : '');

// The sabotaged loaders: the served data.js with one feature taken out. Each replacement must apply exactly once.
const SABOTAGES = {
  nocache: [["var cached = cache && !o.force ? cache.get(key).catch(function () { return null; }) : Promise.resolve(null);", "var cached = Promise.resolve(null);"],
            ["if (source !== 'local' || o.force || o.override) { return null; }", "if (true) { return null; }"]],
  nohash: [["if (declared && declared.sha256 && hash !== declared.sha256.toLowerCase()) {", "if (false) {"]],
  capitals: [["(o.sha256 || '').toLowerCase()].join('|')", "(o.sha256 || '')].join('|')"]],
  heretic: [["if (has.TITLE) {\n      if (has.MAP01)", "if (false) {\n      if (has.MAP01)"]],
  ownname: [["(ENGINE_NAMES.indexOf(own) >= 0 ? own : '') ||", "'' ||"]],
  override: [["if (source !== 'local' || o.force || o.override) { return null; }", "if (source !== 'local' || o.force) { return null; }"]],
  legacy: [["return RESERVED.indexOf(n.toLowerCase()) >= 0 ? 'game.wad' : n;", "return n;"]],
  abort: [["      checkCancelled();\n      return cache.put(rec)", "      return cache.put(rec)"], ["if (cancelled()) { cache.del(rec.key).catch(function () {}); checkCancelled(); }", ""]],
  purgefirst: [["}).then(function (r) { return purgeOld().then(function () { return r; }); });", "});"], ["      return Promise.resolve().then(function () {\n        if (!cache) { return null; }", "      return purgeOld().then(function () {\n        if (!cache) { return null; }"]],
  revalfall: [["if (e && e.kind !== 'cancelled' && !(e.kind === 'http' && e.status < 500)) {", "if (e && (e.kind === 'network' || (e.kind === 'http' && e.status >= 500))) {"]],
  picker: [["if (o.file.size > MAX_FILE) {", "if (false) {"], ["if (!head.ok && head.reason !== 'directory') {", "if (false) {"]],
  nolocal: [["return store(rec).then(function (stored) { return result(rec, 'picked'", "return Promise.resolve(false).then(function (stored) { return result(rec, 'picked'"]],
};
function sabotagedDataJs() {
  let src = fs.readFileSync(path.join(t.root, 'web', 'data.js'), 'utf8');
  for (const [a, b] of SABOTAGES[SABOTAGE]) {
    if (src.split(a).length !== 2) { throw new Error('sabotage ' + SABOTAGE + ': text not found exactly once: ' + a); }
    src = src.replace(a, b);
  }
  return src;
}

const configJs = (data) => 'window.DL_CONFIG = { data: ' + JSON.stringify(data) + ' }; window.DL_CONFIG_EXAMPLES = {};';
const doomConfig = (o) => Object.assign({ url: 'doom1.wad', name: 'doom1.wad', size: DOOM1.length, sha256: DOOM1_SHA, revalidate: false }, o || {});
const noSpace = (s) => s.replace(/\s+/g, ' ');
const num = (x) => x.toLocaleString('en-US');

async function fresh(env, init) {
  const context = await env.browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await context.newPage();
  if (init) { await page.addInitScript(init); }
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  return { context, page, errors };
}
async function load(env, page, query, mount) {
  await page.goto((mount || env.base) + query);
  return t.waitState(page, ['ready', 'nodata', 'error'], 120000);
}
const status = (page) => page.evaluate(() => document.getElementById('status').textContent);
const dlData = (page) => page.evaluate(() => window.dlData);
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.offsetParent !== null; }, sel);
async function work(page) { return page.evaluate(() => window.dlTest.listFiles('/work').filter((n) => /\.wad$/i.test(n) && n !== 'legacy.wad')); }
async function starts(page) { return page.evaluate(() => window.dlStarts); }
// The cache, read from inside the page.
async function cacheInfo(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('doomlegacy-data');
    r.onupgradeneeded = () => { r.transaction.abort(); };          // it did not exist: do not create it
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) { db.close(); resolve(null); return; }
      const all = db.transaction('files').objectStore('files').getAll();
      all.onsuccess = () => {
        const meta = db.transaction('meta').objectStore('meta').getAll();
        meta.onsuccess = () => {
          resolve({ records: all.result.map((x) => ({ key: x.key, size: x.size, sha256: x.sha256, name: x.name, etag: x.etag, storedAt: x.storedAt, config: x.config, bytes: x.bytes && x.bytes.byteLength, fileName: x.fileName })),
                    meta: meta.result.map((m) => m.key + '=' + m.value) });
          db.close();
        };
      };
    };
  }));
}
const keys = (c) => (c ? c.records.map((r) => r.key).sort() : []);
// Clicks start and waits for the game to name the game it found.
async function play(page, pattern, timeout) {
  await page.click('#start');
  try {
    await page.waitForFunction((p) => window.dlOut.concat(window.dlErr).some((l) => new RegExp(p).test(l)), pattern, { timeout: timeout || 30000, polling: 100 });
  } catch (e) { return ''; }
  return page.evaluate((p) => window.dlOut.concat(window.dlErr).filter((l) => new RegExp(p).test(l))[0], pattern);
}
const recognized = (name) => 'IWAD recognized: ' + name;

async function main() {
  const root = t.BUILD;
  if (!fs.existsSync(path.join(root, 'doomlegacy.wasm'))) { throw new Error(`${root}/doomlegacy.wasm not found: run scripts/build-wasm.sh`); }
  const browser = await chromium.launch();
  const A = await DataServer.start(root);    // the page's origin
  const B = await DataServer.start(root);    // another origin (another port): the data, with or without CORS
  const e = { browser, base: A.origin + '/index.html' };
  if (SABOTAGE) { A.set('/data.js', () => ({ body: Buffer.from(sabotagedDataJs()), type: 'text/javascript' })); }
  const reset = () => { A.routes = {}; B.routes = {}; A.reset(); B.reset(); if (SABOTAGE) { A.set('/data.js', () => ({ body: Buffer.from(sabotagedDataJs()), type: 'text/javascript' })); } };
  try {
    // ---- 1. the first load (AC1) ------------------------------------------------------------------------------
    console.log('1. first load');
    {
      reset();
      A.set('/doom1.wad', { body: DOOM1, chunk: 256 * 1024, gap: 15, etag: '"v1"' });
      const o = await fresh(e);
      const st = await load(e, o.page, QUERY());
      t.check(st === 'ready', `the page is ready (state ${st}: ${await status(o.page)})`);
      const prog = await o.page.evaluate(() => window.dlProgress || []);
      const got = prog.map((p) => p[0]);
      t.check(prog.length > 1, `more than one progress report (${prog.length})`);
      t.check(got.every((v, i) => i === 0 || v > got[i - 1]) && got[got.length - 1] === DOOM1.length, `... bytes increase to the whole file (${got.slice(0, 3).join(', ')} ... ${got[got.length - 1]})`);
      t.check(prog.every((p) => p[1] === DOOM1.length), '... each with the declared total');
      const d = await dlData(o.page);
      t.check(d && d.source === 'download' && d.from === 'network' && d.name === 'doom1.wad' && /shareware/i.test(d.game), `the data: ${d && d.game}, ${d && d.name}, from ${d && d.from}`);
      t.check(d && d.sha256 === DOOM1_SHA && d.size === DOOM1.length, 'its size and SHA-256 are the shareware 1.9 ones');
      const info = await o.page.evaluate(() => document.getElementById('datainfo').textContent);
      t.check(/Doom shareware/.test(info) && /downloaded just now/.test(info) && info.includes(A.origin + '/doom1.wad'), `the page says what it uses and from where: "${info}"`);
      const c = await cacheInfo(o.page);
      const rec = c && c.records[0];
      t.check(c && c.records.length === 1 && rec.key === 'url:' + A.origin + '/doom1.wad' && rec.size === DOOM1.length && rec.sha256 === DOOM1_SHA && rec.bytes === DOOM1.length,
              `the file is in the cache: ${rec && rec.key}, ${rec && rec.size} bytes`);
      t.check(rec && rec.etag === '"v1"' && rec.storedAt > Date.now() - 120000 && /doom1\.wad/.test(rec.config), 'the record holds the ETag, when it was stored and the config signature');
      t.check(d && d.hashHow === 'subtle' && d.hashMs >= 0, `SHA-256 of ${DOOM1.length} bytes with crypto.subtle: ${d && d.hashMs.toFixed(1)} ms`);
      console.log(`  info: the download took ${d.downloadMs.toFixed(0)} ms including the throttle; navigator.storage.persist() answered ${await o.page.evaluate(() => window.dlPersistent)}`);
      t.check(await o.page.evaluate(() => window.dlPersistent !== undefined), 'navigator.storage.persist() was asked and answered');
      const line = await play(o.page, 'IWAD recognized');
      t.check(line === recognized('Doom shareware'), `the game reports shareware Doom: "${line}"`);
      await o.page.waitForTimeout(2500);
      const stats = await t.canvasStats(o.page);
      t.check(t.notBlank(stats), `the picture is not blank (${stats.colors} colours)`);
      t.check(o.errors.length === 0, 'no page error', o.errors.join(' | '));
      await o.context.close();
    }

    // ---- 2. a cached load (AC2) ---------------------------------------------------------------------------------
    console.log('2. cached load');
    {
      reset();
      A.set('/doom1.wad', { body: DOOM1, etag: '"v1"' });
      const o = await fresh(e);
      await load(e, o.page, QUERY());
      t.check(A.count('/doom1.wad') === 1, 'the first load made one request for the IWAD');
      A.reset();
      const st = await (async () => { await o.page.reload(); return t.waitState(o.page, ['ready', 'nodata', 'error']); })();
      t.check(st === 'ready', `after a reload the page is ready (${st})`);
      t.check(A.count('/doom1.wad') === 0 && A.log.filter((r) => /\.wad$/.test(r.path) && r.path !== '/legacy.wad').length === 0,
              `no request for the IWAD reached the server (requests: ${A.log.map((r) => r.path).join(' ')})`);
      const d = await dlData(o.page);
      t.check(d && d.from === 'cache' && d.source === 'download' && d.name === 'doom1.wad', `the data came from the cache (${d && d.from})`);
      const info = await o.page.evaluate(() => document.getElementById('datainfo').textContent);
      t.check(/this browser's copy/.test(info), `the page says so: "${info}"`);
      const line = await play(o.page, 'IWAD recognized');
      t.check(line === recognized('Doom shareware'), `the game starts from the cached copy: "${line}"`);
      await o.context.close();
    }

    // ---- 3. bad files (AC3) ---------------------------------------------------------------------------------------
    console.log('3. bad files');
    {
      const flipped = Buffer.from(DOOM1); flipped[1000000] ^= 0xff;
      let seed = 12345;
      const random = Buffer.alloc(DOOM1.length);
      for (let i = 0; i < random.length; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; random[i] = seed >>> 16; }
      const cases = [
        ['one byte flipped', { body: flipped }, 'corrupt', /SHA-256/, (m) => m.includes(sha(flipped)) && m.includes(DOOM1_SHA) && m.includes(num(DOOM1.length))],
        ['a short file (Content-Length matches)', { body: DOOM1, cutTo: DOOM1.length - 5000 }, 'truncated', /incomplete|cut off/, (m) => m.includes(num(DOOM1.length - 5000)) && m.includes(num(DOOM1.length))],
        ['a dropped connection', { body: DOOM1, dropAfter: 1000000 }, 'truncated', /cut off|incomplete/, () => true],
        ['random bytes of the right size', { body: random }, 'notiwad', /not a Doom data file/, (m) => m.includes(sha(random)) && m.includes(DOOM1_SHA)],
        ['a small text file', { body: Buffer.from('<html><body>Not found, but with status 200</body></html>'), type: 'text/html' }, 'notiwad', /not a Doom data file/, (m) => m.includes('bytes')],
      ];
      for (const [what, spec, kind, re, more] of cases) {
        reset();
        A.set('/doom1.wad', spec);
        const o = await fresh(e);
        const st = await load(e, o.page, QUERY());
        const msg = noSpace(await status(o.page));
        const d = await dlData(o.page);
        t.check(st === 'nodata', `${what}: the page shows the problem (state ${st})`);
        t.check(d && d.error === kind && re.test(msg) && msg.includes(A.origin + '/doom1.wad'), `... a clear message that names the file and the problem (${kind}): "${msg.slice(0, 230)}"`);
        t.check(more(msg), '... with the size and SHA-256 found against the declared ones where they apply');
        t.check((await starts(o.page)) === 0 && (await work(o.page)).length === 0, '... the game was not started and no IWAD was handed to it');
        t.check(keys(await cacheInfo(o.page)).length === 0, '... nothing was cached');
        t.check((await visible(o.page, '#pickwrap')) && (await visible(o.page, '#retry')), '... the file picker and "Try again" are offered');
        // afterwards the correct file loads normally
        A.set('/doom1.wad', { body: DOOM1 });
        await o.page.click('#retry');
        const st2 = await t.waitState(o.page, ['ready', 'nodata', 'error']);
        const line = st2 === 'ready' ? await play(o.page, 'IWAD recognized') : '';
        t.check(st2 === 'ready' && line === recognized('Doom shareware') && keys(await cacheInfo(o.page)).length === 1, '... then "Try again" with the right file loads it, starts the game and caches it');
        await o.context.close();
      }
    }

    // ---- 4. HTTP errors and CORS (AC4) ------------------------------------------------------------------------
    console.log('4. HTTP errors and CORS');
    {
      for (const code of [404, 403, 500]) {
        reset();
        A.set('/doom1.wad', { status: code });
        const o = await fresh(e);
        const st = await load(e, o.page, QUERY());
        const msg = noSpace(await status(o.page));
        const d = await dlData(o.page);
        t.check(st === 'nodata' && d.error === 'http' && msg.includes(String(code)) && msg.includes(A.origin + '/doom1.wad'), `HTTP ${code}: a message with the status and the URL: "${msg.slice(0, 160)}"`);
        t.check((await starts(o.page)) === 0 && (await visible(o.page, '#pickwrap')) && (await visible(o.page, '#retry')), '... not started; the picker and "Try again" are offered');
        await o.context.close();
      }
      reset();
      B.set('/doom1.wad', { body: DOOM1 });                       // another origin, no CORS headers
      {
        const o = await fresh(e);
        const url = B.origin + '/doom1.wad';
        const st = await load(e, o.page, QUERY('iwad=' + encodeURIComponent(url)));
        const msg = noSpace(await status(o.page));
        const d = await dlData(o.page);
        t.check(B.count('/doom1.wad') >= 1, 'the other server was asked');
        t.check(st === 'nodata' && d.error === 'network' && msg.includes(url), `no CORS headers: an error that names the URL: "${msg.slice(0, 200)}"`);
        t.check(/CORS/.test(msg) && /Access-Control-Allow-Origin/.test(msg) && /network failure|down or unreachable/i.test(msg), '... it names both causes (the browser cannot tell them apart) and carries the CORS hint');
        t.check((await starts(o.page)) === 0 && keys(await cacheInfo(o.page)).length === 0, '... not started, nothing cached');
        // the same server, with CORS headers
        B.set('/doom1.wad', { body: DOOM1, cors: '*' });
        await o.page.click('#retry');
        const st2 = await t.waitState(o.page, ['ready', 'nodata', 'error']);
        const d2 = await dlData(o.page);
        t.check(st2 === 'ready' && d2.name === 'doom1.wad' && /shareware/i.test(d2.game), `the same server with CORS headers works: the file is named by what it is (${d2.name}, ${d2.game})`);
        const info = await o.page.evaluate(() => document.getElementById('datainfo').textContent);
        t.check(info.includes(url), `... and the page says where it came from: "${info}"`);
        t.check((await play(o.page, 'IWAD recognized')) === recognized('Doom shareware'), '... the game starts');
        await o.context.close();
      }
      // a URL on the page's own origin gets no CORS hint
      {
        reset();
        const o = await fresh(e);
        const st = await load(e, o.page, QUERY('iwad=' + encodeURIComponent('http://127.0.0.1:1/doom1.wad')));
        const msg = noSpace(await status(o.page));
        t.check(st === 'nodata' && /could not be downloaded/.test(msg) && /CORS/.test(msg), `an unreachable host on another origin: the same message ("${msg.slice(0, 120)}...")`);
        await o.context.close();
      }
      {
        reset();
        A.set('/gone.wad', { status: 404 });
        // the same origin: a network failure of the page's own server is not blamed on CORS
        const o = await fresh(e);
        await load(e, o.page, QUERY('iwad=' + encodeURIComponent('/gone.wad')));
        const msg = noSpace(await status(o.page));
        t.check(/gone\.wad/.test(msg) && /404/.test(msg) && !/CORS/.test(msg), `a 404 on the page's own origin: no CORS hint ("${msg.slice(0, 120)}")`);
        await o.context.close();
      }
    }

    // ---- 5. a compressed response (AC5) -----------------------------------------------------------------------
    console.log('5. compressed response');
    {
      reset();
      A.set('/doom1.wad', { body: DOOM1, gzip: true, chunk: 128 * 1024, gap: 10 });
      const o = await fresh(e);
      const st = await load(e, o.page, QUERY());
      const prog = await o.page.evaluate(() => window.dlProgress || []);
      const got = prog.map((p) => p[0]);
      t.check(st === 'ready', `a gzip response with Content-Length of the compressed size: the download works (${st})`);
      t.check(A.requests('/doom1.wad')[0].headers['accept-encoding'].includes('gzip'), '... the browser asked for gzip');
      t.check(prog.length > 1 && got[got.length - 1] === DOOM1.length && prog.every((p) => p[1] === DOOM1.length && p[0] <= p[1]), `the progress is sensible: ${prog.length} reports, counted in decompressed bytes against the declared size, never over 100% (last ${got[got.length - 1]})`);
      t.check((await dlData(o.page)).sha256 === DOOM1_SHA && keys(await cacheInfo(o.page)).length === 1, 'the checks pass on the decompressed bytes and the file is cached');
      await o.context.close();
      // no declared size (?iwad=): the compressed Content-Length is not the total: the bar is unfilled and the megabytes show
      reset();
      A.set('/zipped.wad', { body: DOOM1, gzip: true, chunk: 128 * 1024, gap: 10 });
      const o2 = await fresh(e);
      const st2 = await load(e, o2.page, QUERY('iwad=' + encodeURIComponent('/zipped.wad')));
      const prog2 = await o2.page.evaluate(() => window.dlProgress || []);
      t.check(st2 === 'ready' && prog2.length > 1 && prog2.every((p) => p[1] === 0), `without a declared size and with Content-Encoding: no total is claimed (${prog2.length} reports, totals ${[...new Set(prog2.map((p) => p[1]))]})`);
      const d2 = await dlData(o2.page);
      t.check(d2.name === 'doom1.wad' && d2.size === DOOM1.length, `... the file is still checked and named by what it is (${d2.name})`);
      await o2.context.close();
      // Content-Length of the plain file, no declared size: the total is known
      reset();
      A.set('/plain.wad', { body: DOOM1, chunk: 256 * 1024, gap: 5 });
      const o3 = await fresh(e);
      await load(e, o3.page, QUERY('iwad=' + encodeURIComponent('/plain.wad')));
      const prog3 = await o3.page.evaluate(() => window.dlProgress || []);
      t.check(prog3.length > 1 && prog3.every((p) => p[1] === DOOM1.length), 'without a declared size and without encoding the total is Content-Length');
      await o3.context.close();
      // cross-origin gzip with CORS: Content-Encoding is not readable by the page; nothing must break
      reset();
      B.set('/doom1.wad', { body: DOOM1, gzip: true, cors: '*', chunk: 128 * 1024, gap: 5 });
      const o4 = await fresh(e);
      const st4 = await load(e, o4.page, QUERY('iwad=' + encodeURIComponent(B.origin + '/doom1.wad')));
      const prog4 = await o4.page.evaluate(() => window.dlProgress || []);
      t.check(st4 === 'ready' && prog4.every((p) => p[1] === 0 || p[0] <= p[1]), `a compressed answer from another origin (Content-Encoding hidden by CORS): the download works and the bar never passes 100% (${st4})`);
      await o4.context.close();
    }

    // ---- 6. the file picker (AC6) ------------------------------------------------------------------------------
    console.log('6. file picker');
    {
      reset();
      A.set('/doom1.wad', { status: 404 });                       // no data URL reachable
      const o = await fresh(e);
      let st = await load(e, o.page, QUERY());
      t.check(st === 'nodata' && (await visible(o.page, '#pickwrap')), 'with no data reachable the page offers the picker');
      await o.page.setInputFiles('#pick', td('doom1.wad'));
      st = await t.waitState(o.page, ['ready', 'nodata', 'error']);
      let d = await dlData(o.page);
      t.check(st === 'ready' && d.source === 'local' && d.from === 'picked' && d.name === 'doom1.wad' && /shareware/i.test(d.game), `a picked doom1.wad is accepted and named (${d && d.game}, ${d && d.name})`);
      const info = await o.page.evaluate(() => document.getElementById('datainfo').textContent);
      t.check(/your own copy "doom1\.wad"/.test(info), `the page says it is the person's own copy: "${info}"`);
      t.check((await play(o.page, 'IWAD recognized')) === recognized('Doom shareware'), 'the game starts');
      let c = await cacheInfo(o.page);
      t.check(keys(c).join() === 'local' && c.meta.includes('source=local') && c.records[0].fileName === 'doom1.wad', `it is cached under a key of its own (${keys(c)}, ${c.meta})`);
      A.reset();
      await o.page.reload();
      st = await t.waitState(o.page, ['ready', 'nodata', 'error']);
      d = await dlData(o.page);
      t.check(st === 'ready' && d.from === 'cache' && d.source === 'local', `after a reload it starts from the cache without picking again (${st}, ${d && d.from})`);
      t.check(A.count('/doom1.wad') === 0, `... and without asking the server for the download (requests: ${A.log.map((r) => r.path).join(' ')})`);
      t.check((await play(o.page, 'IWAD recognized')) === recognized('Doom shareware'), '... the game starts');
      await o.context.close();

      // Freedoom under another name
      reset();
      A.set('/doom1.wad', { status: 404 });
      const o2 = await fresh(e);
      await load(e, o2.page, QUERY());
      await o2.page.setInputFiles('#pick', { name: 'mydata.wad', mimeType: 'application/octet-stream', buffer: FD1 });
      st = await t.waitState(o2.page, ['ready', 'nodata', 'error']);
      d = await dlData(o2.page);
      t.check(st === 'ready' && d.name === 'freedoom1.wad' && d.fileName === 'mydata.wad' && /Freedoom: Phase 1/.test(d.game), `freedoom1.wad picked as mydata.wad is recognised and given its own name (${d && d.name}, ${d && d.game})`);
      t.check((await o2.page.evaluate(() => window.dlTest.listFiles('/work'))).includes('freedoom1.wad'), '... the game gets /work/freedoom1.wad');
      t.check((await play(o2.page, 'IWAD recognized')) === recognized('Ultimate FreeDoom'), 'the game starts Freedoom');
      await o2.context.close();

      // an IWAD that is not in the table, under a name the game does not know: named by its lumps
      reset();
      A.set('/doom1.wad', { status: 404 });
      const odd = Buffer.from(DOOM1);
      const ofs = odd.readInt32LE(8), nl = odd.readInt32LE(4);
      for (let i = 0; i < nl; i++) {
        const name = odd.toString('latin1', ofs + i * 16 + 8, ofs + i * 16 + 16).replace(/\0.*$/, '');
        if (name === 'D_E1M1') { odd[odd.readInt32LE(ofs + i * 16) + 100] ^= 0xff; break; }
      }
      const o3 = await fresh(e);
      await load(e, o3.page, QUERY());
      await o3.page.setInputFiles('#pick', { name: 'My Doom (1).WAD', mimeType: 'application/octet-stream', buffer: odd });
      st = await t.waitState(o3.page, ['ready', 'nodata', 'error']);
      d = await dlData(o3.page);
      t.check(st === 'ready' && d.name === 'doom1.wad' && d.sha256 === sha(odd) && /Doom shareware/.test(d.game), `an IWAD not in the table (a changed music lump), picked as "My Doom (1).WAD": accepted as the person's own copy, named doom1.wad from its lumps (${d && d.name})`);
      t.check((await play(o3.page, 'IWAD recognized')) === recognized('Doom shareware'), '... and the game starts the right game');
      await o3.context.close();

      // refused picks: a text file, a PWAD, a cut-off IWAD
      reset();
      A.set('/doom1.wad', { status: 404 });
      const o4 = await fresh(e);
      await load(e, o4.page, QUERY());
      const picks = [['a text file', { name: 'notes.wad', mimeType: 'text/plain', buffer: Buffer.from('this is not a WAD file, it is some text of a person') }, /not a Doom data file/],
                     ['a PWAD', { name: 'patch.wad', mimeType: 'application/octet-stream', buffer: Buffer.concat([Buffer.from('PWAD'), Buffer.alloc(8)]) }, /not a Doom data file/],
                     ['a cut-off IWAD', { name: 'doom1.wad', mimeType: 'application/octet-stream', buffer: DOOM1.subarray(0, 2000000) }, /not a whole IWAD/]];
      for (const [what, file, re] of picks) {
        await o4.page.setInputFiles('#pick', file);
        st = await t.waitState(o4.page, ['nodata', 'ready', 'error']);
        const msg = noSpace(await status(o4.page));
        t.check(st === 'nodata' && re.test(msg) && msg.includes(file.name), `picking ${what}: refused with a message that names the file ("${msg.slice(0, 120)}")`);
        t.check((await starts(o4.page)) === 0 && keys(await cacheInfo(o4.page)).length === 0 && (await visible(o4.page, '#pickwrap')), '... not started, not cached, the picker is still there');
      }
      await o4.context.close();

      // "Use the download instead"
      reset();
      A.set('/doom1.wad', { body: DOOM1, etag: '"a"' });
      const o5 = await fresh(e);
      await load(e, o5.page, QUERY());
      await o5.page.setInputFiles('#pick', { name: 'mydata.wad', mimeType: 'application/octet-stream', buffer: FD1 });
      st = await t.waitState(o5.page, ['ready']);
      await o5.page.waitForFunction(() => window.dlData && window.dlData.source === 'local');
      t.check((await visible(o5.page, '#usedownload')) && !(await visible(o5.page, '#redownload')), 'with a picked file the page offers "Use the download instead"');
      c = await cacheInfo(o5.page);
      t.check(keys(c).length === 2 && keys(c).includes('local'), `the picked copy and the download are both cached (${keys(c)})`);
      A.reset();
      await o5.page.click('#usedownload');
      st = await t.waitState(o5.page, ['ready', 'nodata', 'error']);
      d = await dlData(o5.page);
      t.check(st === 'ready' && d.source === 'download' && d.name === 'doom1.wad', `"Use the download instead" switches back (${d && d.source}, ${d && d.name})`);
      c = await cacheInfo(o5.page);
      t.check(keys(c).join() === 'url:' + A.origin + '/doom1.wad' && c.meta.includes('source=url'), `the picked copy is forgotten (${keys(c)}, ${c.meta})`);
      t.check(A.count('/doom1.wad') === 0 && d.from === 'cache', 'the cached download was used (no request)');
      t.check((await work(o5.page)).join() === 'doom1.wad', 'the picked file is gone from the game\'s folder');
      await o5.page.reload();
      await t.waitState(o5.page, ['ready']);
      t.check((await dlData(o5.page)).source === 'download', 'a reload keeps the download');
      await o5.context.close();
    }

    // ---- 7. quota and no IndexedDB (AC7) -----------------------------------------------------------------------
    console.log('7. quota and no IndexedDB');
    {
      reset();
      A.set('/doom1.wad', { body: DOOM1 });
      // the hooks
      for (const [hook, re] of [['idb=quota', /no space left/], ['idb=off', /would not let the page keep the game data/]]) {
        A.reset();
        const o = await fresh(e);
        const st = await load(e, o.page, QUERY(hook));
        const d = await dlData(o.page);
        const notes = await o.page.evaluate(() => document.getElementById('notes').textContent);
        t.check(st === 'ready' && d.cached === false && re.test(notes) && /downloaded (again next time|each time)/.test(notes), `${hook}: the game data is there and the notice says it will be downloaded again ("${noSpace(notes).slice(0, 150)}")`);
        t.check((await play(o.page, 'IWAD recognized')) === recognized('Doom shareware'), '... the game starts');
        t.check(keys(await cacheInfo(o.page)).length === 0, '... nothing is in the cache');
        await o.page.reload();
        await t.waitState(o.page, ['ready']);
        t.check(A.count('/doom1.wad') === 2 && (await dlData(o.page)).from === 'network', '... and a reload downloads it again');
        await o.context.close();
      }
      // IndexedDB really missing (private windows of some browsers): no hook, the page's own storage fails too (IDBFS)
      A.reset();
      const none = () => { Object.defineProperty(window, 'indexedDB', { configurable: true, get() { return undefined; } }); };
      const o = await fresh(e, none);
      const st = await load(e, o.page, '?test=1&audio=dummy&args=' + ARGS);       // persist on: the game's /persist is IDBFS
      const d = await dlData(o.page);
      const notes = await o.page.evaluate(() => document.getElementById('notes').textContent);
      t.check(st === 'ready' && d.cached === false, `no IndexedDB at all (indexedDB is undefined): the page is ready (${st})`);
      t.check(/Saved games and settings will not be kept/.test(notes) && /would not let the page keep the game data/.test(notes), `... with both notices: the game's own (02) and the data's ("${noSpace(notes).slice(0, 200)}")`);
      const line = await play(o.page, 'IWAD recognized');
      t.check(line === recognized('Doom shareware'), '... the game starts');
      await o.page.waitForTimeout(1500);
      t.check((await o.page.evaluate(() => window.dlState)) === 'running' && o.errors.length === 0, '... and keeps running, no page error', o.errors.join(' | '));
      await o.context.close();

      // a real quota: the browser's own limit for the site, set through the devtools protocol
      A.reset();
      const o2 = await fresh(e);
      let real = 'not tried';
      try {
        const cdp = await o2.context.newCDPSession(o2.page);
        await cdp.send('Storage.overrideQuotaForOrigin', { origin: A.origin, quotaSize: 1024 * 1024 });
        const st2 = await load(e, o2.page, QUERY());
        const d2 = await dlData(o2.page);
        const notes2 = await o2.page.evaluate(() => document.getElementById('notes').textContent);
        real = `state ${st2}, cached ${d2 && d2.cached}, notes "${noSpace(notes2).slice(0, 100)}"`;
        t.check(st2 === 'ready' && d2.cached === false && /no space left|would not keep/.test(notes2), `a real quota of 1 MB (the 4 MB file does not fit): the game starts with the notice (${real})`);
        t.check((await play(o2.page, 'IWAD recognized')) === recognized('Doom shareware'), '... the game starts');
      } catch (err) { t.check(false, 'a real quota through the devtools protocol', err.message); }
      await o2.context.close();
    }

    // ---- 8. a changed configuration (AC8) ----------------------------------------------------------------------
    console.log('8. changed configuration');
    {
      reset();
      A.set('/doom1.wad', { body: DOOM1 });
      A.set('/doom1-v2.wad', { body: DOOM1 });
      A.set('/game.wad', () => ({ body: A.game }));
      A.game = DOOM1;
      let cfg = doomConfig();
      A.set('/config.js', () => ({ body: Buffer.from(configJs(cfg)), type: 'text/javascript' }));
      const o = await fresh(e);
      const reload = async () => { await o.page.goto(e.base + QUERY()); return t.waitState(o.page, ['ready', 'nodata', 'error']); };
      await reload();
      t.check(A.count('/doom1.wad') === 1 && keys(await cacheInfo(o.page)).join() === 'url:' + A.origin + '/doom1.wad', 'the configured URL: downloaded, one entry');
      await reload();
      t.check(A.count('/doom1.wad') === 1, 'unchanged config: no second download');
      // a different URL
      cfg = doomConfig({ url: 'doom1-v2.wad' });
      await reload();
      let c = await cacheInfo(o.page);
      t.check(A.count('/doom1-v2.wad') === 1 && keys(c).join() === 'url:' + A.origin + '/doom1-v2.wad', `a changed URL downloads again and the old entry is gone (${keys(c)})`);
      // a different declared hash and size: the server now serves Freedoom under the same URL
      cfg = doomConfig({ url: 'game.wad', name: 'doom1.wad' });
      await reload();
      t.check(A.count('/game.wad') === 1 && keys((c = await cacheInfo(o.page))).join() === 'url:' + A.origin + '/game.wad' && c.records[0].sha256 === DOOM1_SHA, 'a new URL again: one entry');
      A.game = FD1;
      cfg = doomConfig({ url: 'game.wad', name: 'freedoom1.wad', size: FD1.length, sha256: FD1_SHA });
      await reload();
      c = await cacheInfo(o.page);
      const d = await dlData(o.page);
      t.check(A.count('/game.wad') === 2 && c.records.length === 1 && c.records[0].sha256 === FD1_SHA && c.records[0].size === FD1.length && d.from === 'network' && d.name === 'freedoom1.wad',
              `a changed declared size and SHA-256 (same URL) downloads again and replaces the entry (${A.count('/game.wad')} requests, ${c.records.length} entry, ${c.records[0].sha256.slice(0, 8)})`);
      // the same URL and the hash in capitals is the same configuration; a changed name is another one
      cfg = doomConfig({ url: 'game.wad', name: 'freedoom1.wad', size: FD1.length, sha256: FD1_SHA.toUpperCase() });
      await reload();
      t.check(A.count('/game.wad') === 2 && (await dlData(o.page)).from === 'cache', `the hash written in capitals: the same signature, from the cache, no request (${A.count('/game.wad')} requests in all)`);
      // an ?iwad= visit keeps the configured entry; a later plain visit removes the visit's own entry
      A.set('/other.wad', { body: DOOM1 });
      await o.page.goto(e.base + QUERY('iwad=' + encodeURIComponent('/other.wad')));
      await t.waitState(o.page, ['ready']);
      c = await cacheInfo(o.page);
      t.check(keys(c).join() === ['url:' + A.origin + '/game.wad', 'url:' + A.origin + '/other.wad'].join(), `an ?iwad= visit keeps the configured copy and adds its own (${keys(c)})`);
      await reload();
      c = await cacheInfo(o.page);
      t.check(keys(c).join() === 'url:' + A.origin + '/game.wad', `the next plain visit removes the entry of a URL no longer in use (${keys(c)})`);
      await o.context.close();
    }

    // ---- 9. more ---------------------------------------------------------------------------------------------------
    console.log('9. more');
    {
      // "Download again"
      reset();
      A.set('/doom1.wad', { body: DOOM1 });
      const o = await fresh(e);
      await load(e, o.page, QUERY());
      const first = (await cacheInfo(o.page)).records[0].storedAt;
      t.check(await visible(o.page, '#redownload'), '"Download again" is offered');
      await o.page.waitForTimeout(30);
      await o.page.click('#redownload');
      await o.page.waitForFunction(() => window.dlData && window.dlData.from === 'network' && window.dlState === 'ready');
      const second = (await cacheInfo(o.page)).records[0].storedAt;
      t.check(A.count('/doom1.wad') === 2 && second > first && keys(await cacheInfo(o.page)).length === 1, `"Download again" asks the server again and replaces the copy (${A.count('/doom1.wad')} requests)`);
      await o.context.close();

      // a conditional request, opt-in
      reset();
      let etag = '"one"';
      A.set('/doom1.wad', () => ({ body: DOOM1, etag, lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' }));
      A.set('/config.js', () => ({ body: Buffer.from(configJs(doomConfig({ revalidate: true }))), type: 'text/javascript' }));
      const o2 = await fresh(e);
      const rl = async () => { await o2.page.goto(e.base + QUERY()); return t.waitState(o2.page, ['ready', 'nodata', 'error']); };
      await rl();
      A.reset();
      await rl();
      const rq = A.requests('/doom1.wad');
      t.check(rq.length === 1 && rq[0].headers['if-none-match'] === '"one"', `revalidate: true: a reload sends If-None-Match (${rq.length} request, ${rq[0] && rq[0].headers['if-none-match']})`);
      t.check((await dlData(o2.page)).from === 'revalidated', 'a 304 answer: the cached copy is used (from revalidated)');
      A.reset();
      etag = '"two"';
      await rl();
      t.check((await dlData(o2.page)).from === 'network' && (await cacheInfo(o2.page)).records[0].etag === '"two"', 'a changed ETag: the file is downloaded again and replaced');
      A.set('/doom1.wad', { status: 500 });
      await rl();
      const d2 = await dlData(o2.page);
      t.check(d2.from === 'cache' && d2.notes.some((n) => /could not be reached|answered 500/.test(n)), `a server error (500) while revalidating: the cached copy is used, with a notice (${d2.from}: ${d2.notes})`);
      await o2.context.close();

      // a stalled download
      reset();
      A.set('/doom1.wad', { body: DOOM1, stallAfter: 1000000 });
      const o3 = await fresh(e);
      const t0 = Date.now();
      const st3 = await load(e, o3.page, QUERY('stall=800'));
      const msg3 = noSpace(await status(o3.page));
      t.check(st3 === 'nodata' && /stalled/.test(msg3) && (Date.now() - t0) < 15000, `a download that stops: it ends with a message (${(Date.now() - t0)} ms: "${msg3.slice(0, 110)}")`);
      await o3.context.close();

      // the JavaScript SHA-256 (a page served over plain http from a LAN address has no crypto.subtle)
      reset();
      A.set('/doom1.wad', { body: DOOM1 });
      const o4 = await fresh(e);
      await load(e, o4.page, QUERY('sha=js'));
      const d4 = await dlData(o4.page);
      t.check(d4.hashHow === 'js' && d4.sha256 === DOOM1_SHA, `sha=js: the plain JavaScript SHA-256 gives the same value (${d4.hashMs.toFixed(0)} ms for ${DOOM1.length} bytes)`);
      const same = await o4.page.evaluate(async () => {
        const b = new Uint8Array(await (await fetch('/doom1.wad')).arrayBuffer());
        const sizes = [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000];
        let ok = true;
        for (const n of sizes) { const x = b.subarray(0, n); const a = await DlData.sha256(x, true), s = await DlData.sha256(x, false); if (a.hex !== s.hex) { ok = false; } }
        return ok;
      });
      t.check(same, 'both agree on short inputs and on every padding boundary (0, 1, 55, 56, 63, 64, 65, 119, 120, 1000 bytes)');
      await o4.context.close();

      // hooks need ?test=1; text only through textContent
      reset();
      A.set('/doom1.wad', { body: DOOM1 });
      const o5 = await fresh(e);
      const st5 = await load(e, o5.page, '?idb=off&sha=js&stall=1&raw=1&iwad=/doom1.wad');
      const d5 = await dlData(o5.page);
      t.check(st5 === 'ready' && d5.cached === true && d5.hashHow === 'subtle' && d5.notes.length === 0, 'the hooks (idb, sha, stall, raw) do nothing without ?test=1');
      await o5.context.close();
      reset();
      const o6 = await fresh(e);
      const evil = '<img src=x onerror=alert(1)>.wad';
      A.set('/doom1.wad', { status: 404 });
      await load(e, o6.page, QUERY());
      await o6.page.setInputFiles('#pick', { name: evil, mimeType: 'text/plain', buffer: Buffer.from('some text, not a WAD') });
      await t.waitState(o6.page, ['nodata']);
      const msg6 = await status(o6.page);
      const imgs = await o6.page.evaluate(() => document.querySelectorAll('#overlay img, #overlay script').length);
      t.check(msg6.includes(evil) && imgs === 0 && o6.errors.length === 0, `a file name with markup in it is shown as text and nothing is injected ("${msg6.slice(0, 70)}")`);
      await load(e, o6.page, QUERY('iwad=' + encodeURIComponent('/x<img src=x onerror=alert(1)>.wad')));
      const msg7 = await status(o6.page);
      t.check(/404/.test(msg7) && /img%20src=x/.test(msg7) && (await o6.page.evaluate(() => document.querySelectorAll('#overlay img').length)) === 0 && o6.errors.length === 0, 'the same for a URL with markup in it');
      await o6.context.close();
    }

    // ---- 10. fix round 1 -----------------------------------------------------------------------------------------
    console.log('10. fix round 1');
    const iwad = (names) => {
      const data = Buffer.alloc(names.length * 4, 1);
      const dir = Buffer.alloc(names.length * 16);
      names.forEach((n, i) => { dir.writeInt32LE(12 + i * 4, i * 16); dir.writeInt32LE(4, i * 16 + 4); dir.write(n, i * 16 + 8, 'latin1'); });
      const h = Buffer.alloc(12); h.write('IWAD'); h.writeInt32LE(names.length, 4); h.writeInt32LE(12 + data.length, 8);
      return Buffer.concat([h, data, dir]);
    };
    const guard = async (what, fn) => { try { await fn(); } catch (err) { t.check(false, what + ': the test itself failed', String(err.message || err).split('\n')[0]); } };
    const pickNamed = async (page, name, buffer) => {
      await page.setInputFiles('#pick', { name, mimeType: 'application/octet-stream', buffer });
      await page.waitForFunction((n) => window.dlData && (window.dlData.fileName === n || window.dlData.error) && window.dlState !== 'loading', name, { timeout: 20000 });
      return dlData(page);
    };
    await guard('names of the other games', async () => {
      reset();
      A.set('/doom1.wad', { status: 404 });
      const o = await fresh(e);
      await load(e, o.page, QUERY());
      const cases = [
        ['a registered Heretic (E1M1 E2M2 E3M9 E4M1 TITLE) called unrelated.wad', ['E1M1', 'E2M2', 'E3M9', 'E4M1', 'TITLE', 'PLAYPAL'], 'unrelated.wad', 'heretic.wad'],
        ['a shareware Heretic (E1M1 TITLE) called zz.wad', ['E1M1', 'TITLE', 'PLAYPAL'], 'zz.wad', 'heretic1.wad'],
        ['a file with Heretic lumps called Heretic.WAD keeps its name (the engine knows it)', ['E1M1', 'TITLE', 'PLAYPAL'], 'Heretic.WAD', 'heretic.wad'],
        ['a Hexen (MAP01 MAP40 TITLE) called h.wad', ['MAP01', 'MAP40', 'TITLE'], 'h.wad', 'hexen.wad'],
        ['a Strife (MAP01 MAP20 ENDSTRF) called s.wad', ['MAP01', 'MAP20', 'ENDSTRF'], 's.wad', 'strife.wad'],
        ['Doom II lumps (MAP01, no TITLE) called mine.wad are still Doom II', ['MAP01', 'PLAYPAL', 'TITLEPIC'], 'mine.wad', 'doom2.wad'],
      ];
      for (const [what, lumps, name, expect] of cases) {
        const d = await pickNamed(o.page, name, iwad(lumps));
        t.check(d && d.name === expect && !d.error, `${what}: the game gets "${d && d.name}" (expected ${expect})`);
      }
      const files = await o.page.evaluate(() => window.dlTest.listFiles('/work'));
      t.check(files.includes('doom2.wad') && !files.includes('heretic.wad'), `the game's folder holds the last pick only (${files})`);
      await o.context.close();
    });
    await guard('legacy.wad', async () => {
      reset();
      A.set('/doom1.wad', { status: 404 });
      const o = await fresh(e);
      await load(e, o.page, QUERY());
      const before = await o.page.evaluate(() => window.dlTest.readFile('legacy.wad').length);
      const d = await pickNamed(o.page, 'LEGACY.WAD', iwad(['FOO', 'BAR']));
      const after = await o.page.evaluate(() => window.dlTest.readFile('legacy.wad').length);
      const c = await cacheInfo(o.page);
      t.check(d && d.name === 'game.wad' && before === after && before > 100000, `an IWAD picked as LEGACY.WAD gets a neutral name (${d && d.name}) and /work/legacy.wad is untouched (${before} then ${after} bytes)`);
      t.check(c.records.length === 1 && c.records[0].name === 'game.wad', 'the cached record has the neutral name too');
      await o.context.close();
    });
    await guard('override over a picked file', async () => {
      reset();
      A.set('/doom1.wad', { status: 404 });
      A.set('/other.wad', { body: FD1 });
      const o = await fresh(e);
      await load(e, o.page, QUERY());
      await pickNamed(o.page, 'doom1.wad', DOOM1);
      await o.page.goto(e.base + QUERY('iwad=' + encodeURIComponent('/other.wad')));
      await t.waitState(o.page, ['ready', 'nodata']);
      let d = await dlData(o.page);
      t.check(d.source === 'download' && d.name === 'freedoom1.wad' && A.count('/other.wad') === 1, `?iwad= wins over a remembered picked file (${d.source}, ${d.name})`);
      let c = await cacheInfo(o.page);
      t.check(c.meta.includes('source=local') && keys(c).includes('local'), `... and the remembered choice is left as it was (${c.meta})`);
      await o.page.goto(e.base + QUERY());
      await t.waitState(o.page, ['ready', 'nodata']);
      d = await dlData(o.page);
      t.check(d.source === 'local' && d.name === 'doom1.wad', `a plain visit afterwards uses the picked file again (${d.source}, ${d.name})`);
      await o.context.close();
    });
    await guard('abort', async () => {
      reset();
      A.set('/doom1.wad', { body: DOOM1 });
      const o2 = await fresh(e);
      await load(e, o2.page, QUERY('idb=off'));          // a page whose own cache is not in the way
      const kind = await o2.page.evaluate(async (args) => {
        const ctl = new AbortController();
        try {
          await DlData.load({ url: '/doom1.wad', name: 'doom1.wad', size: args.size, sha256: args.sha, signal: ctl.signal, hooks: {}, onStatus: (s) => { if (/Checking/.test(s)) { ctl.abort(); } } });
          return 'loaded';
        } catch (err) { return err.kind || String(err); }
      }, { size: DOOM1.length, sha: DOOM1_SHA });
      const c = await cacheInfo(o2.page);
      t.check(kind === 'cancelled' && c && c.records.length === 0 && c.meta.length === 0, `a load replaced after the download (aborted while the file is checked) stores nothing: ${kind}, ${c && c.records.length} records, meta ${c && c.meta}`);
      await o2.context.close();
      // a pick during a slow download: only the picked file ends up in the cache
      reset();
      A.set('/doom1.wad', { body: DOOM1, chunk: 128 * 1024, gap: 40 });
      const o3 = await fresh(e);
      await o3.page.goto(e.base + QUERY());
      await o3.page.waitForFunction(() => window.dlProgress && window.dlProgress.length > 2);
      await o3.page.setInputFiles('#pick', { name: 'mine.wad', mimeType: 'application/octet-stream', buffer: FD1 });
      await o3.page.waitForFunction(() => window.dlData && window.dlData.source === 'local');
      await o3.page.waitForTimeout(1500);
      const c3 = await cacheInfo(o3.page);
      t.check(keys(c3).join() === 'local' && c3.meta.join() === 'source=local' && (await dlData(o3.page)).name === 'freedoom1.wad', `a file picked during a slow download replaces it; only the picked file is cached (${keys(c3)}, ${c3.meta})`);
      await o3.context.close();
    });
    await guard('keep old entries', async () => {
      reset();
      A.set('/doom1.wad', { body: DOOM1 });
      A.set('/doom1-v3.wad', { body: DOOM1 });
      let cfg = doomConfig();
      A.set('/config.js', () => ({ body: Buffer.from(configJs(cfg)), type: 'text/javascript' }));
      const o = await fresh(e);
      const go = async () => { await o.page.goto(e.base + QUERY()); return t.waitState(o.page, ['ready', 'nodata', 'error']); };
      await go();
      cfg = doomConfig({ url: 'missing.wad' });
      const st = await go();
      let c = await cacheInfo(o.page);
      t.check(st === 'nodata' && keys(c).join() === 'url:' + A.origin + '/doom1.wad', `a configuration that points at a missing file shows the error and leaves the visitor's copy (${st}, ${keys(c)})`);
      cfg = doomConfig({ url: 'doom1-v3.wad' });
      await go();
      c = await cacheInfo(o.page);
      t.check(keys(c).join() === 'url:' + A.origin + '/doom1-v3.wad', `a working URL then replaces it (${keys(c)})`);
      await o.context.close();
    });
    await guard('revalidate fallback', async () => {
      reset();
      const flipped = Buffer.from(DOOM1); flipped[1000000] ^= 0xff;
      let spec = { body: DOOM1, etag: '"one"' };
      A.set('/doom1.wad', () => spec);
      A.set('/config.js', () => ({ body: Buffer.from(configJs(doomConfig({ revalidate: true }))), type: 'text/javascript' }));
      const o = await fresh(e);
      const go = async () => { await o.page.goto(e.base + QUERY()); return t.waitState(o.page, ['ready', 'nodata', 'error']); };
      await go();
      for (const [what, s] of [['a damaged 200', { body: flipped, etag: '"two"' }], ['a cut-off 200', { body: DOOM1, etag: '"three"', cutTo: DOOM1.length - 5000 }], ['a 200 that is no IWAD', { body: Buffer.from('<html>oops</html>'), etag: '"four"', type: 'text/html' }]]) {
        spec = s;
        const st = await go();
        const d = await dlData(o.page);
        const c = await cacheInfo(o.page);
        t.check(st === 'ready' && d.from === 'cache' && d.sha256 === DOOM1_SHA && d.notes.some((n) => /failed the checks/.test(n)) && c.records.length === 1 && c.records[0].sha256 === DOOM1_SHA && c.records[0].etag === '"one"',
                `revalidating, ${what}: the verified cached copy is used, with a notice, and stays in the cache (${st}, ${d && d.from}: ${d && d.notes})`);
      }
      await o.context.close();
    });
    await guard('picker limit', async () => {
      reset();
      const o = await fresh(e);
      await load(e, o.page, QUERY());
      const r = await o.page.evaluate(async () => {
        const calls = [];
        const out = {};
        const big = { name: 'big.wad', size: 600 * 1048576, slice() { calls.push('slice'); return new Blob([]); }, arrayBuffer() { calls.push('all'); return Promise.reject(new Error('read')); } };
        try { await DlData.load({ url: '/x.wad', file: big, hooks: { idb: 'off' } }); out.big = 'loaded'; } catch (err) { out.big = err.kind + ': ' + err.message; }
        out.bigCalls = calls.splice(0).join();
        const text = new Blob([new Uint8Array(20 * 1048576).fill(65)]);
        const fake = { name: 'text.wad', size: text.size, slice(a, b) { calls.push('slice'); return text.slice(a, b); }, arrayBuffer() { calls.push('all'); return text.arrayBuffer(); } };
        try { await DlData.load({ url: '/x.wad', file: fake, hooks: { idb: 'off' } }); out.text = 'loaded'; } catch (err) { out.text = err.kind + ': ' + err.message; }
        out.textCalls = calls.join();
        return out;
      });
      t.check(/^size: .*512/.test(r.big) && r.bigCalls === '', `a file over 512 MB is refused with a message and not read (${r.big.slice(0, 90)}; calls: ${r.bigCalls || 'none'})`);
      t.check(/^notiwad: /.test(r.text) && r.textCalls === 'slice', `a 20 MB text file is refused after reading its first 12 bytes only (calls: ${r.textCalls})`);
      await o.context.close();
    });
  } finally {
    await A.close(); await B.close();
    await browser.close().catch(() => {});
  }
  return t.summary('data');
}
main().then((c) => process.exit(c), (err) => { console.error(err); process.exit(2); });
