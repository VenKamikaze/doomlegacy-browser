// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared helpers for the browser tests (Playwright + Chromium; never run `playwright install`).
// Helpers for reading the canvas and sending keys follow jfsw-browser's tests/web/lib.js (the user's own work).
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { serve } = require('../tools/serve.js');

const root = path.resolve(__dirname, '..', '..');
const BUILD = process.env.WASM_DIR ? path.resolve(process.env.WASM_DIR) : path.join(root, 'build', 'wasm', 'bin');
const IWAD = path.join(root, 'testdata', 'freedoom1.wad');

let checks = 0, failures = 0;
function check(ok, what, detail) {
  checks++;
  if (ok) { console.log('  ok   ' + what); } else { failures++; console.log('  FAIL ' + what + (detail ? ' (' + detail + ')' : '')); }
  return !!ok;
}
function summary(name) {
  console.log(`${name}: ${checks - failures} passed, ${failures} failed`);
  return failures === 0 ? 0 : 1;
}

// Serves the build and testdata/. `mounts` maps more URL paths to local files.
async function start(mounts) {
  if (!fs.existsSync(path.join(BUILD, 'doomlegacy.wasm'))) { throw new Error(`${BUILD}/doomlegacy.wasm not found: run scripts/build-wasm.sh`); }
  if (!fs.existsSync(IWAD)) { throw new Error(`${IWAD} not found: run scripts/fetch-test-data.sh`); }
  const server = await serve(BUILD, mounts || {}, 0);
  const browser = await chromium.launch();
  return { server, browser, base: `http://127.0.0.1:${server.address().port}/index.html` };
}
async function stop(env) {
  try { await env.browser.close(); } catch (e) { /* already gone */ }
  await new Promise((r) => env.server.close(r));
}

// Opens the page; collects uncaught page errors and dialogs. Returns { page, context, errors, console }.
async function open(env, query, opts, init) {
  const context = await env.browser.newContext(Object.assign({ viewport: { width: 1000, height: 800 } }, opts || {}));
  const page = await context.newPage();
  if (init) { await page.addInitScript(init); }
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(env.base + (query || ''));
  return { page, context, errors, consoleErrors };
}

async function waitState(page, states, timeout) {
  const list = [].concat(states);
  await page.waitForFunction((l) => l.indexOf(window.dlState) >= 0, list, { timeout: timeout || 60000, polling: 100 });
  return page.evaluate(() => window.dlState);
}

// What the canvas shows, as the browser composites it (an element screenshot: reading a WebGL canvas
// directly gives a blank picture). Returns { colors, pixels, width, height, hash }, colors being the number
// of distinct RGB values.
async function canvasStats(page) {
  const png = await page.locator('#canvas').screenshot({ type: 'png' });
  return analysePng(page, png);
}
async function analysePng(page, png) {
  const b64 = png.toString('base64');
  // Decode in a page of its own so the game page is not disturbed.
  const side = await page.context().newPage();
  try {
    return await side.evaluate(async (data) => {
      const blob = await (await fetch('data:image/png;base64,' + data)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      let hash = 2166136261;
      for (let i = 0; i < px.length; i += 4) {
        seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
        hash = Math.imul(hash ^ (px[i] | px[i + 1] << 8 | px[i + 2] << 16), 16777619);
      }
      return { colors: seen.size, pixels: c.width * c.height, width: c.width, height: c.height, hash: hash >>> 0 };
    }, b64);
  } finally { await side.close(); }
}
// Number of pixels that differ noticeably between two PNG screenshots (the comparison runs in a page of its own).
async function pixelDiff(page, a, b) {
  const side = await page.context().newPage();
  try {
    return await side.evaluate(async ({ da, db }) => {
      const load = async (d) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + d)).blob());
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const pa = await load(da), pb = await load(db);
      let n = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 60) { n++; }
      }
      return n;
    }, { da: a.toString('base64'), db: b.toString('base64') });
  } finally { await side.close(); }
}
// Pixels of the canvas that change between two moments: `action` runs between two screenshots.
async function changedPixels(page, action, waitMs) {
  const el = page.locator('#canvas');
  const a = await el.screenshot({ type: 'png' });
  if (action) { await action(); }
  await page.waitForTimeout(waitMs || 600);
  const b = await el.screenshot({ type: 'png' });
  return pixelDiff(page, a, b);
}

// A picture is "not blank" if it has several distinct colours.
const MIN_COLORS = 8;
function notBlank(stats) { return stats.colors >= MIN_COLORS; }

// A key press the game's polling is sure to see (a plain press() can be down and up between two polls).
async function tap(page, key, ms) { await page.keyboard.down(key); await page.waitForTimeout(ms || 150); await page.keyboard.up(key); }

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

// Plays the game once in a fresh context until it ends. `query` is the page's query string after test=1;
// returns { page, context, errors, state, exit, out, err, seconds }.
async function runGame(env, query, opts) {
  opts = opts || {};
  const o = await open(env, '?test=1&' + query, undefined, opts.init);
  await waitState(o.page, ['ready', 'nodata', 'error']);
  const started = Date.now();
  if ((await o.page.evaluate(() => window.dlState)) === 'ready') { await o.page.click('#start'); }
  if (opts.script) { await opts.script(o.page); }
  let state;
  try { state = await waitState(o.page, ['ended', 'error'], opts.timeoutMs || 120000); } catch (e) { state = 'timeout'; }
  const r = await o.page.evaluate(() => ({
    exit: window.dlExit, out: window.dlOut.join('\n'), err: window.dlErr.join('\n'),
    status: document.getElementById('status').textContent, reloadVisible: !document.getElementById('reload').hidden,
    overlayVisible: !document.getElementById('overlay').hidden,
  }));
  return Object.assign(o, r, { state, seconds: (Date.now() - started) / 1000 });
}

module.exports = { changedPixels, pixelDiff, tap, runGame, root, BUILD, IWAD, check, summary, start, stop, open, waitState, canvasStats, analysePng, notBlank, MIN_COLORS, pct };
