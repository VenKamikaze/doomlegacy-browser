#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Run the wasm build of the game in headless Chromium (Playwright), with the data
// in MEMFS, and bring back files and the exit status.
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
//   --wasm DIR         where doomlegacy.js is (default build/wasm/bin)
//   --timeout SECS     give up after SECS (default 600): exit status 124
//
// The game gets -home /work -iwad /work/<iwad> -nosound -nomusic -noendtext, then
// GAME ARGS. Its output is copied to stdout. The exit status is the game's own.
//
// Why a browser and not Node: the SDL2 port's only video driver is the one for a web
// page (a canvas, `screen`, gamepad events); under Node SDL_Init fails. The game's
// main loop does not return (no ASYNCIFY yet, brief 02), so it runs in one blocking
// callMain on the page's main thread.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
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
  else { console.error('unknown option ' + a); process.exit(2); }
}
if (!opts.iwad) { console.error('--iwad is required'); process.exit(2); }

const dataFiles = [opts.iwad, opts.legacy, ...opts.demos].map((f) => ({ src: f, name: path.basename(f) })).concat(opts.puts);
const page_html = `<!doctype html><meta charset=utf-8><title>doomlegacy test</title>
<canvas id=canvas width=320 height=200></canvas>
<script src="/doomlegacy.js"></script>`;

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') { res.setHeader('content-type', 'text/html'); res.end(page_html); return; }
  let file = null;
  if (u.startsWith('/data/')) { const d = dataFiles.find((f) => f.name === u.slice(6)); if (d) file = d.src; }
  else if (u === '/doomlegacy.js' || u === '/doomlegacy.wasm') file = path.resolve(opts.wasm, u.slice(1));
  if (!file) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', u.endsWith('.wasm') ? 'application/wasm' : u.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch();
  let status = 1;
  try {
    const page = await browser.newPage();
    page.on('console', (m) => process.stdout.write(m.text() + '\n'));
    page.on('pageerror', (e) => process.stdout.write('pageerror: ' + e.message + '\n'));
    page.on('crash', () => { process.stdout.write('run-wasm: the page crashed\n'); });
    await page.goto(`http://127.0.0.1:${port}/`);
    const job = {
      files: dataFiles.map((f) => f.name),
      iwad: path.basename(opts.iwad), gets: opts.gets.map((g) => g.split('=')[0]), game,
    };
    const run = page.evaluate(async (job) => {
      const mod = await createDoomLegacy({
        canvas: document.getElementById('canvas'),
        noInitialRun: true,
        print: (s) => console.log(s),
        printErr: (s) => console.log(s),
        // the environment is read when the runtime starts
        preRun: [(m) => { m.ENV.SDL_AUDIODRIVER = 'dummy'; }],
      });
      const FS = mod.FS;
      FS.mkdir('/work');
      for (const f of job.files) {
        const buf = new Uint8Array(await (await fetch('/data/' + f)).arrayBuffer());
        FS.writeFile('/work/' + f, buf);
      }
      FS.chdir('/work');
      let status;
      try {
        status = mod.callMain(['-home', '/work', '-iwad', '/work/' + job.iwad,
                               '-nosound', '-nomusic', '-noendtext', ...job.game]);
      } catch (e) {
        console.log('run-wasm: ' + (e && e.stack || e));
        status = 1;
      }
      const out = {};
      for (const g of job.gets) {
        try {
          const bytes = FS.readFile('/work/' + g);
          let s = '';
          for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
          out[g] = btoa(s);
        } catch (e) { out[g] = null; }
      }
      return { status: status === undefined ? 0 : status, out };
    }, job);
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
