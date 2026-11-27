#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Run the wasm build of the game in headless Chromium (Playwright), with the data in MEMFS,
// and bring back files and the exit status.
//
//   node tests/tools/run-wasm.js [options] -- GAME ARGS...
//
//   --iwad FILE        IWAD, put into MEMFS as /work/<name>
//   --demo FILE        a demo file, put into MEMFS as /work/<name> (repeatable; pass its
//                      bare name to the game)
//   --put FILE[=NAME]  any file (a savegame), put into MEMFS as /work/<NAME> (default: its
//                      base name; split at the last '=', so NAME has none) before the game starts (repeatable)
//   --get PATH=FILE    after the game exits, copy MEMFS file /work/PATH to FILE (repeatable)
//   --legacy FILE      legacy.wad (default common/legacy.wad), put into MEMFS as /work/legacy.wad
//   --wasm DIR         where the build is (default build/wasm/bin)
//   --timeout SECS     give up after SECS (default 600): exit status 124
//   --fastms N         with the test pacing, yield every N ms (default 20)
//   --paced            normal pacing (one yield per display frame) instead of the test pacing
//
// The runner drives the page that users get (web/, built into build/wasm/bin) with its test
// hooks (?test=1): it opens index.html with the data served from this process, clicks "Click to
// start", waits for the game to exit and reads the files out of /work. The game gets
// -home /work -iwad /work/<iwad> -nomusic -noendtext (the page's) and -nosound, then GAME ARGS. The video
// mode is left to the game (video=native: a canvas the size of the 1280x720 window, as before the page
// existed), so the tests' speed does not change with the page's 640x480 window.
// Its output is copied to stdout. The exit status is the game's own.
//
// Test pacing (the page's fast=1): the game yields to the page every 20 ms instead of once per
// display frame, so -timedemo runs as fast as the CPU allows, as it did before ASYNCIFY.
//
// Why a browser and not Node: the SDL2 port's only video driver is the one for a web page (a
// canvas, `screen`, gamepad events); under Node SDL_Init fails.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const opts = { iwad: null, demos: [], puts: [], gets: [], legacy: path.join(__dirname, '../../common/legacy.wad'), wasm: path.join(__dirname, '../../build/wasm/bin'), timeout: 600 };
let game = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { game = argv.slice(i + 1); break; }
  else if (a === '--iwad') opts.iwad = argv[++i];
  else if (a === '--demo') opts.demos.push(argv[++i]);
  else if (a === '--put') { const v = argv[++i], e = v.lastIndexOf('='); opts.puts.push(e > 0 ? { src: v.slice(0, e), name: v.slice(e + 1) } : { src: v, name: path.basename(v) }); }
  else if (a === '--get') opts.gets.push(argv[++i]);
  else if (a === '--legacy') opts.legacy = argv[++i];
  else if (a === '--wasm') opts.wasm = argv[++i];
  else if (a === '--timeout') opts.timeout = Number(argv[++i]);
  else if (a === '--paced') opts.paced = true;
  else if (a === '--fastms') opts.fastms = argv[++i];
  else { console.error('unknown option ' + a); process.exit(2); }
}
if (!opts.iwad) { console.error('--iwad is required'); process.exit(2); }

const dataFiles = [opts.iwad, ...opts.demos].map((f) => ({ src: f, name: path.basename(f) })).concat(opts.puts);
const { serve } = require('./serve.js');

// The page and the build come from --wasm; a build without the page (an old one) gets web/.
const mounts = { '/legacy.wad': path.resolve(opts.legacy) };
for (const f of ['index.html', 'page.js', 'page.css']) {
  if (!fs.existsSync(path.join(opts.wasm, f))) mounts['/' + f] = path.join(__dirname, '../../web', f);
}
for (const d of dataFiles) mounts['/data/' + d.name] = d.src;

async function main() {
  const server = await serve(path.resolve(opts.wasm), mounts, 0);
  const port = server.address().port;
  const browser = await chromium.launch();
  let status = 1;
  try {
    const page = await browser.newPage();
    page.on('console', (m) => process.stdout.write(m.text() + '\n'));
    page.on('pageerror', (e) => process.stdout.write('pageerror: ' + e.message + '\n'));
    page.on('crash', () => { process.stdout.write('run-wasm: the page crashed\n'); });
    const query = new URLSearchParams({
      test: '1', persist: '0', home: '/work', audio: 'dummy', video: 'native', nolock: '1', iwad: '/data/' + path.basename(opts.iwad),
      files: dataFiles.filter((f) => f.src !== opts.iwad).map((f) => '/data/' + encodeURIComponent(f.name)).join(','),
      args: JSON.stringify(['-nosound', ...game]),
    });
    if (!opts.paced) query.set('fast', '1');
    if (opts.fastms) query.set('fastms', opts.fastms);
    await page.goto(`http://127.0.0.1:${port}/index.html?${query}`);
    const job = { gets: opts.gets.map((g) => g.split('=')[0]) };
    const run = (async () => {
      await page.waitForFunction(() => window.dlState === 'ready' || window.dlState === 'error', null, { timeout: 0, polling: 50 });
      if (await page.evaluate(() => window.dlState) === 'error') {
        console.log('run-wasm: ' + await page.evaluate(() => document.getElementById('status').textContent));
        return { status: 1, out: {} };
      }
      // The page's own button, clicked from the page (not by a mouse: the audio is the dummy driver, and a build
      // without ASYNCIFY blocks inside the click until the game ends, which Playwright's click would wait for).
      await page.evaluate(() => { setTimeout(() => document.getElementById('start').click(), 0); });
      await page.waitForFunction(() => window.dlState === 'ended' || window.dlState === 'error', null, { timeout: 0, polling: 50 });
      return page.evaluate((job) => {
        const out = {};
        for (const g of job.gets) {
          const bytes = window.dlTest.readFile('/work/' + g);
          if (!bytes) { out[g] = null; continue; }
          let s = '';
          for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
          out[g] = btoa(s);
        }
        const code = window.dlExit ? window.dlExit.code : undefined;
        if (code === undefined) console.log('run-wasm: the game did not exit: ' + document.getElementById('status').textContent);
        return { status: code === undefined ? 1 : code, out };
      }, job);
    })();
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r('timeout'), opts.timeout * 1000); });
    const res = await Promise.race([run, timeout]);
    clearTimeout(timer);
    if (res === 'timeout') {
      process.stdout.write(`run-wasm: timeout after ${opts.timeout} s\n`);
      status = 124;
    } else {
      status = res.status;
      for (const g of opts.gets) {
        const [src, dst] = g.split('=');
        if (res.out[src] == null) console.error('run-wasm: cannot read /work/' + src);
        else fs.writeFileSync(dst, Buffer.from(res.out[src], 'base64'));
      }
    }
  } catch (e) {
    console.error('run-wasm: ' + (e && e.stack || e));
    status = 1;
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
    server.close();
  }
  process.exit(status);
}
main();
