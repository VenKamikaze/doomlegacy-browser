#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// A demo played by the page itself, at the page's normal pace (one yield per display frame), in
// headless Chromium (brief 02: AC3, AC4 third item, AC5).
//
//   node tests/web/demo-page.js                  # d1demo3 (2,134 tics, about a minute)
//   DEMO_PAGE_SABOTAGE=other node tests/web/demo-page.js   # compares with another demo's native dump: the determinism check must FAIL
//   DEMO_PAGE_SABOTAGE=block node tests/web/demo-page.js   # the page blocks for 400 ms now and then: AC3 must FAIL
//   DEMO_PAGE_SABOTAGE=noyield node tests/web/demo-page.js  # the game yields only every 5 s (test pacing): AC3 must FAIL, which shows it is the yields that keep the page alive
//   DEMO_PAGE_DEMO=fd1demo1 ...                  # another demo (longer; its IWAD is chosen by name)
//   DEMO_PAGE_LOCK=1 ...                         # let the page lock the pointer, as a player's click does: information only (see below)
//
// What it checks:
//  - the native build plays the demo with -timedemo -testdump (the reference) and so does another
//    demo (for the negative check);
//  - the page plays the demo with -playdemo -testdump at normal pacing, and its file is identical to
//    the native one, record for record (the yields change when the page gets control back, not the
//    simulation);
//  - the page stays responsive while it does: a timer and a requestAnimationFrame callback of the
//    page run all the time, and no gap between two calls is over 250 ms once the game is running;
//  - the frame intervals (the game's presented frames, and the page's own animation frames).
// Needs scripts/build-native.sh, scripts/build-wasm.sh, scripts/fetch-test-data.sh.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const t = require('./lib.js');

const SABOTAGE = process.env.DEMO_PAGE_SABOTAGE || '';
const DEMO = process.env.DEMO_PAGE_DEMO || 'd1demo3';
const OTHER = DEMO === 'fd1demo4' ? 'd1demo3' : 'fd1demo4';
const NATIVE = path.join(t.root, 'build', 'native', 'bin', 'doomlegacy');
const DIFF = path.join(t.root, 'tests', 'tools', 'testdump-diff.py');
const iwadOf = (d) => (d.startsWith('fd2') ? 'freedoom2.wad' : d.startsWith('fd1') ? 'freedoom1.wad' : 'doom1.wad');

function native(dir, demo) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(t.root, 'testdata', 'demos', demo + '.lmp'), path.join(dir, demo + '.lmp'));
  const r = spawnSync(NATIVE, ['-home', dir, '-iwad', path.join(t.root, 'testdata', iwadOf(demo)), '-nosound', '-nomusic', '-noendtext',
    '-timedemo', demo + '.lmp', '-testdump', 'o.bin'], { cwd: dir, env: Object.assign({}, process.env, { SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' }), timeout: 240000, encoding: 'utf8' });
  return { status: r.status, file: path.join(dir, 'o.bin') };
}
function compare(a, b) {
  const r = spawnSync('python3', ['-I', DIFF, a, b], { encoding: 'utf8' });
  return { same: r.status === 0, text: (r.stdout || r.stderr || '').trim() };
}

async function main() {
  if (!fs.existsSync(NATIVE)) { throw new Error('no native build: run scripts/build-native.sh'); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-page-'));
  try {
    const ref = native(path.join(work, 'ref'), DEMO);
    const ref2 = native(path.join(work, 'other'), OTHER);
    t.check(ref.status === 0 && ref2.status === 0, `native plays ${DEMO} and ${OTHER} with -timedemo -testdump (status ${ref.status}, ${ref2.status})`);

    const env = await t.start();
    try {
      const q = new URLSearchParams({
        ...(SABOTAGE === 'noyield' ? { fast: '1', fastms: '5000' } : {}),
        persist: '0', home: '/work', audio: 'dummy', nolock: process.env.DEMO_PAGE_LOCK ? '0' : '1', iwad: '/' + iwadOf(DEMO), files: '/demos/' + DEMO + '.lmp',
        args: JSON.stringify(['-nosound', '-playdemo', DEMO + '.lmp', '-testdump', 'o.bin']),
      });
      // The page's own work, while the game plays: a timer and an animation-frame callback record when they run.
      const o = await t.open(env, '?test=1&' + q);
      await o.page.evaluate((sabotage) => {
        window.beats = { timer: [], raf: [], blocked: 0 };
        setInterval(() => { window.beats.timer.push(performance.now()); }, 20);
        const loop = (ts) => { window.beats.raf.push(ts); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        if (sabotage === 'block') {      // a page that does not respond: 400 ms of work every 5 s
          setInterval(() => { const s = performance.now(); while (performance.now() - s < 400) { /* busy */ } window.beats.blocked++; }, 5000);
        }
      }, SABOTAGE);
      await t.waitState(o.page, 'ready');
      const t0 = await o.page.evaluate(() => performance.now());
      // The page is told not to lock the pointer (nolock=1). With the lock, headless Chromium in this container stalls even a
      // bare WebGL page for 100 ms to 2 s at a time (a page that only uploads a texture and draws it, measured: median 16.7 ms,
      // p95 167, p99 583, max 2,166), so the pacing could not be measured; DEMO_PAGE_LOCK=1 starts with a real click, which
      // is granted the lock, to show it with the game.
      await o.page.click('#start');
      const state = await t.waitState(o.page, ['ended', 'error'], 300000);
      const res = await o.page.evaluate(() => ({
        exit: window.dlExit, status: document.getElementById('status').textContent, beats: window.beats, frames: Module.dlFrameLog,
        out: window.dlOut.join('\n'),
      }));
      t.check(state === 'ended' && res.exit && res.exit.code === 0, `the page plays ${DEMO} to its end and the game exits 0 (${state}, ${JSON.stringify(res.exit)})`, res.status);
      t.check(o.errors.length === 0, 'no uncaught page error or dialog', o.errors.join(' | '));

      // --- determinism ---
      const bytes = await o.page.evaluate(() => { const b = window.dlTest.readFile('/work/o.bin'); return b ? btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')) : null; });
      const mine = path.join(work, 'page.bin');
      fs.writeFileSync(mine, bytes ? Buffer.from(bytes, 'base64') : Buffer.alloc(0));
      // (DEMO_PAGE_SABOTAGE=other compares with the other demo's file here: this check must then FAIL)
      const same = compare(SABOTAGE === 'other' ? ref2.file : ref.file, mine);
      t.check(same.same, `the page's -testdump equals the native one (${same.text})`);
      const other = compare(ref2.file, mine);
      t.check(!other.same, `against another demo's native dump (${OTHER}) it differs, as it should (${other.text.split('\n')[0]})`);

      // --- responsiveness: gaps between calls of the page's own timer and animation frames, once the game runs ---
      const frames = res.frames;
      const firstFrame = frames.length ? frames[0] : 0;
      const from = Math.max(firstFrame, t0) + 1000;      // a second after the game's first picture: start-up is over
      const gaps = (arr) => { const g = []; for (let i = 1; i < arr.length; i++) { if (arr[i] >= from) g.push(arr[i] - arr[i - 1]); } return g; };
      const timerGaps = gaps(res.beats.timer), rafGaps = gaps(res.beats.raf);
      if (process.env.DEMO_PAGE_GAPS) { const arr = res.beats.raf; const big = []; for (let i = 1; i < arr.length; i++) { if (arr[i] >= from && arr[i] - arr[i - 1] > 100) big.push(((arr[i] - from) / 1000).toFixed(1) + 's:' + (arr[i] - arr[i - 1]).toFixed(0)); } console.log('  gaps over 100 ms (time after start: length ms): ' + big.join(' ')); }
      const maxOf = (g) => g.reduce((m, x) => Math.max(m, x), 0);
      console.log(`  info the game ran ${((frames[frames.length - 1] - firstFrame) / 1000).toFixed(1)} s; first picture ${(firstFrame - t0).toFixed(0)} ms after the click; ${timerGaps.length} timer calls, ${rafGaps.length} animation frames after the first second`);
      t.check(timerGaps.length > 1000 && Math.max(0, maxOf(timerGaps)) <= 250, `no gap over 250 ms between the page's timer calls (${timerGaps.length} calls, largest gap ${maxOf(timerGaps).toFixed(0)} ms)`);
      t.check(rafGaps.length > 1000 && maxOf(rafGaps) <= 250, `no gap over 250 ms between the page's animation frames (${rafGaps.length} frames, largest gap ${maxOf(rafGaps).toFixed(0)} ms)`);

      // --- frame time ---
      const stat = (g) => { const s = g.slice().sort((a, b) => a - b); return { n: s.length, median: t.pct(s, 0.5), p95: t.pct(s, 0.95), p99: t.pct(s, 0.99), max: s[s.length - 1] }; };
      const fmt = (s) => `n=${s.n} median ${s.median.toFixed(1)} ms, p95 ${s.p95.toFixed(1)}, p99 ${s.p99.toFixed(1)}, max ${s.max.toFixed(1)}`;
      const pres = [];
      for (let i = 1; i < frames.length; i++) { if (frames[i] >= from) pres.push(frames[i] - frames[i - 1]); }
      const seconds = (frames[frames.length - 1] - from) / 1000;
      const ps = stat(pres), rs = stat(rafGaps);
      console.log(`  info game frames presented (35 a second by design): ${fmt(ps)} over ${seconds.toFixed(0)} s`);
      console.log(`  info the page's animation frames: ${fmt(rs)}`);
      t.check(seconds >= 30, `the measurement covers at least 30 s of play (${seconds.toFixed(1)} s)`);
      // A median near one display frame is the target for the page; the game itself draws 35 a second (a tic), so
      // its presented frames come 28.6 ms apart on average, one or two display frames.
      t.check(rs.median < 20, `the page's animation frames keep their pace while the game plays: median ${rs.median.toFixed(1)} ms (target about 16.7)`);
      t.check(ps.median > 14 && ps.median < 36, `the game presents about every tic: median ${ps.median.toFixed(1)} ms (35 a second is 28.6)`);
      t.check(ps.max <= 100, `no game frame stall over 100 ms after the start-up (largest ${ps.max.toFixed(0)} ms, p99 ${ps.p99.toFixed(0)} ms)`);
      await o.context.close();
    } finally { await t.stop(env); }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  return t.summary('demo-page');
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
