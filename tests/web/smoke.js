#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Browser smoke test for the Emscripten build (brief 02: AC2, and the input and sound parts of AC9
// that a headless browser can show).
//
//   node tests/web/smoke.js
//   SMOKE_SABOTAGE=blank node tests/web/smoke.js    # hides the canvas after the game drew: the picture checks must FAIL
//   SMOKE_SABOTAGE=nokey node tests/web/smoke.js    # sends no key: the keyboard checks must FAIL
//   SMOKE_SABOTAGE=noesc node tests/web/smoke.js    # the pointer is released the way the game does it: the Escape check must FAIL
//   SMOKE_SABOTAGE=nosound node tests/web/smoke.js  # silences the audio output: the sound check must FAIL
//   SMOKE_SABOTAGE=lateaudio node tests/web/smoke.js  # SDL makes the AudioContext, as before the fix: the in-the-click check must FAIL
//   SMOKE_SABOTAGE=nomouse node tests/web/smoke.js  # the mouse does not move: the mouse-look check must FAIL
//   SMOKE_SHOT=file.png                             # also save a screenshot of the page
//
// Serves the build and testdata/freedoom1.wad, loads the page with ?test=1, clicks to start, reaches the
// title, and checks that the canvas is not blank, that a key reaches the game (Escape opens the menu, Down
// moves its skull), that frames keep coming, that the audio device is open and sound reaches it, that
// the keys the game uses are kept from the browser, that a click locks the pointer, that Escape still
// reaches the game when the browser takes the pointer, and that nothing threw. The picture is read as the
// browser composites it (an element screenshot): reading a WebGL canvas directly would give a blank picture.
// The blank check is proved on pictures that are known to be blank, and by SMOKE_SABOTAGE=blank.
'use strict';
const t = require('./lib.js');

const SAB = process.env.SMOKE_SABOTAGE || '';

// Where the menu skull is in the canvas: the grey pixels (bone) in a column left of the menu. Returns the y of
// their centre as a fraction of the canvas height, or null if there are fewer than 150 (no skull drawn).
async function skullY(page, decoder) {
  const png = await page.locator('#canvas').screenshot({ type: 'png' });
  return decoder.evaluate(async (data) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const x0 = Math.floor(c.width * 0.17), x1 = Math.floor(c.width * 0.32), y0 = Math.floor(c.height * 0.30), y1 = Math.floor(c.height * 0.85);
    const px = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let n = 0, sum = 0;
    for (let y = 0; y < y1 - y0; y++) {
      for (let x = 0; x < x1 - x0; x++) {
        const i = (y * (x1 - x0) + x) * 4, r = px[i], gg = px[i + 1], b = px[i + 2];
        if (Math.min(r, gg, b) > 110 && Math.max(r, gg, b) - Math.min(r, gg, b) < 70) { n++; sum += y + y0; }
      }
    }
    return n >= 150 ? sum / n / c.height : null;
  }, png.toString('base64'));
}

// Is the menu drawn in a level? Its skull (grey pixels left of the items) and its red lettering both.
async function menuOpen(page, decoder) {
  if ((await skullY(page, decoder)) === null) { return false; }
  const png = await page.locator('#canvas').screenshot({ type: 'png' });
  const red = await decoder.evaluate(async (data) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const px = g.getImageData(Math.floor(c.width * 0.3), Math.floor(c.height * 0.3), Math.floor(c.width * 0.35), Math.floor(c.height * 0.5)).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) { if (px[i] > 150 && px[i + 1] < 60 && px[i + 2] < 60) n++; }
    return n;
  }, png.toString('base64'));
  return red > 2500;
}

async function main() {
  const env = await t.start();
  try {
    // --- 1. The blank check must be able to fail ---------------------------------------------------------
    {
      const { page, context } = await t.open(env, '?test=1&persist=0&audio=dummy&iwad=/freedoom1.wad');
      await t.waitState(page, 'ready');
      await page.evaluate(() => { document.getElementById('overlay').hidden = true; });   // the overlay is not the canvas
      const before = await t.canvasStats(page);
      t.check(!t.notBlank(before), 'blank check: the canvas before the game starts counts as blank', JSON.stringify(before));
      const mk = async (n) => {         // a picture of n vertical bars of different colours
        const side = await context.newPage();
        const png = await side.evaluate((colors) => {
          const c = document.createElement('canvas'); c.width = 640; c.height = 480;
          const g = c.getContext('2d');
          for (let i = 0; i < colors; i++) { g.fillStyle = `rgb(${i * 20},${255 - i * 20},${i * 7})`; g.fillRect(i * 50, 0, 50, 480); }
          return c.toDataURL('image/png').split(',')[1];
        }, n);
        await side.close();
        return t.analysePng(page, Buffer.from(png, 'base64'));
      };
      t.check(!t.notBlank(await mk(1)), 'blank check: a single-colour picture counts as blank');
      t.check(!t.notBlank(await mk(2)), 'blank check: a two-colour picture counts as blank');
      t.check(t.notBlank(await mk(12)), 'blank check: a 12-colour picture is not blank');
      await context.close();
    }

    // --- 2. The game: title, menu, keys, frames, sound ---------------------------------------------------
    const o = await t.open(env, '?test=1&persist=0&iwad=/freedoom1.wad' + (SAB === 'lateaudio' ? '&noprime=1' : ''));      // the real audio device: no audio=dummy
    const { page, context, errors, consoleErrors } = o;
    // Sound that reaches the audio output: SDL feeds a ScriptProcessorNode; watch the loudest sample it writes.
    await page.addInitScript((silence) => {
      window.audioPeak = 0;
      // Where the AudioContext is made: inside the click on "Click to start" or not.
      window.audioCtxs = [];
      let inClick = false;
      window.addEventListener('click', (e) => { if (e.target && e.target.id === 'start') { inClick = true; setTimeout(() => { inClick = false; }, 0); } }, true);
      const RealAC = window.AudioContext;
      window.AudioContext = function (...a) { const c = new RealAC(...a); window.audioCtxs.push({ ctx: c, inClick }); return c; };
      window.AudioContext.prototype = RealAC.prototype;
      const real = AudioContext.prototype.createScriptProcessor;
      AudioContext.prototype.createScriptProcessor = function () {
        const node = real.apply(this, arguments);
        let handler = null;
        const nativeSet = Object.getOwnPropertyDescriptor(ScriptProcessorNode.prototype, 'onaudioprocess').set;
        Object.defineProperty(node, 'onaudioprocess', {
          get() { return handler; },
          set(h) {
            handler = h;
            nativeSet.call(node, function (e) {
              const r = h ? h.call(this, e) : undefined;
              for (let ch = 0; ch < e.outputBuffer.numberOfChannels; ch++) {
                const d = e.outputBuffer.getChannelData(ch);
                for (let i = 0; i < d.length; i++) { if (silence) d[i] = 0; if (Math.abs(d[i]) > window.audioPeak) window.audioPeak = Math.abs(d[i]); }
              }
              return r;
            });
          },
        });
        return node;
      };
    }, SAB === 'nosound');
    await page.reload();
    const decoder = await context.newPage();

    t.check((await t.waitState(page, 'ready')) === 'ready', 'the page loads the data and offers "Click to start"');
    t.check(await page.isVisible('#start'), 'the start button is visible');
    await page.click('#start');
    t.check((await page.evaluate(() => window.dlState)) === 'running', 'the click starts the game');

    // The first real picture (the title).
    let stats = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      stats = await t.canvasStats(page);
      if (t.notBlank(stats)) { break; }
      await page.waitForTimeout(500);
    }
    if (SAB === 'blank') { await page.evaluate(() => { document.getElementById('canvas').style.opacity = '0'; }); }
    stats = await t.canvasStats(page);
    t.check(t.notBlank(stats), `the canvas is not blank (${stats.colors} colours, ${stats.width}x${stats.height})`, JSON.stringify(stats));
    if (SAB === 'blank') { await page.evaluate(() => { document.getElementById('canvas').style.opacity = ''; }); }
    const size = await page.evaluate(() => [canvas.width, canvas.height]);
    t.check(size[0] === 640 && size[1] === 480, `the game runs in a 640x480 window (canvas ${size.join('x')})`);
    const box = await page.locator('#canvas').boundingBox();
    t.check(Math.abs(box.width / box.height - 4 / 3) < 0.02, `the canvas keeps the game's shape on the page (${Math.round(box.width)}x${Math.round(box.height)})`);

    // A key reaches the game: Escape opens the menu (a skull appears left of its items), Down moves the skull.
    await page.waitForTimeout(2000);
    const before = await skullY(page, decoder);
    if (SAB !== 'nokey') { await t.tap(page, 'Escape'); }
    await page.waitForTimeout(900);
    const open = await skullY(page, decoder);
    t.check(before === null && open !== null, `Escape opens the menu: its skull appears (none before, now at ${open === null ? 'nowhere' : open.toFixed(3)} of the height)`);
    if (SAB !== 'nokey') { await t.tap(page, 'ArrowDown'); }
    await page.waitForTimeout(700);
    const down = await skullY(page, decoder);
    t.check(open !== null && down !== null && down - open > 0.03 && down - open < 0.2, `Down moves the skull down (${open && open.toFixed(3)} to ${down && down.toFixed(3)})`);
    if (SAB !== 'nokey') { await t.tap(page, 'ArrowUp'); }
    await page.waitForTimeout(700);
    const up = await skullY(page, decoder);
    t.check(down !== null && up !== null && down - up > 0.03 && down - up < 0.2, `Up moves it up (${down && down.toFixed(3)} to ${up && up.toFixed(3)})`);
    t.check(t.notBlank(await t.canvasStats(page)), 'the menu is drawn');

    // Frames keep coming, at the display's pace for the page and the game's own for the picture.
    const f1 = await page.evaluate(() => Module.dlFrameLog.length);
    await page.waitForTimeout(1000);
    const f2 = await page.evaluate(() => Module.dlFrameLog.length);
    t.check(f2 - f1 > 20, `frames keep being presented (${f2 - f1} in a second)`);

    // Sound: the device is open, its clock runs and the menu's sound effects reach the output.
    const audio = () => page.evaluate(() => { const s = Module.SDL2; const c = s && s.audioContext; return c ? { state: c.state, time: c.currentTime, open: !!s.audio } : null; });
    const a1 = await audio();
    await page.waitForTimeout(800);
    const a2 = await audio();
    t.check(a1 && a1.open && a1.state === 'running', `the game opened its audio device and the AudioContext is running (${a1 && a1.state})`);
    t.check(a1 && a2 && a2.time > a1.time, 'the audio clock advances');
    const ac = await page.evaluate(() => ({ n: window.audioCtxs.length, inClick: window.audioCtxs.map((c) => c.inClick), same: !!(window.audioCtxs[0] && Module.SDL2 && Module.SDL2.audioContext === window.audioCtxs[0].ctx) }));
    t.check(ac.n === 1 && ac.inClick[0] === true, `the AudioContext was created inside the click on "Click to start" (${ac.n} created; inside the click: ${JSON.stringify(ac.inClick)})`);
    t.check(ac.same, 'SDL uses that context (Module.SDL2.audioContext is the one the page made)');
    if (SAB !== 'nokey') { await t.tap(page, 'ArrowDown'); }       // the menu moves with a sound
    await page.waitForTimeout(600);
    const peak = await page.evaluate(() => window.audioPeak);
    t.check(peak > 0.01, `sound effects reach the audio output (loudest sample ${peak.toFixed(3)})`);
    const log = await page.evaluate(() => window.dlOut.concat(window.dlErr).join('\n'));

    // Keys the browser would use: the game's are kept from it, the browser's own (reload, developer tools) are not.
    const prevented = await page.evaluate(() => {
      const r = {};
      const send = (type, code) => { const e = new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
      for (const code of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace', 'PageUp', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']) { r[code] = send('keydown', code); }
      // keys that type text: their keydown is left alone (SDL needs the keypress that follows), the keypress is stopped
      for (const code of ['Space', 'Quote', 'Slash']) { r[code] = send('keypress', code) && !send('keydown', code); }
      return r;
    });
    const mine = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Quote', 'Slash', 'Tab', 'Backspace', 'PageUp', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11'];
    const miss = mine.filter((k) => !prevented[k]);
    t.check(miss.length === 0, `the browser's default is prevented for the keys the game uses (${miss.length ? 'not for ' + miss.join(', ') : mine.length + ' keys'})`);
    t.check(!prevented.F12, 'F12 stays the browser\'s (developer tools)');

    t.check((await page.evaluate(() => window.dlState)) === 'running', 'the game is still running');
    t.check(errors.length === 0, 'no uncaught page error, dialog or alert', errors.join(' | '));
    t.check(consoleErrors.length === 0, 'no console.error', consoleErrors.slice(0, 3).join(' | '));
    t.check(/IWAD recognized: Ultimate FreeDoom/.test(log), 'the game recognised the IWAD');
    t.check(!/Error|ERROR/.test(log), 'no error text in the game output');
    if (process.env.SMOKE_SHOT) { await page.screenshot({ path: process.env.SMOKE_SHOT }); }
    await context.close();

    // --- 3. The mouse and Escape. In a level (E1M1), a click captures the mouse; when the browser takes the pointer
    // back (the user pressed Escape: the key itself never reaches the page) the game must still get an Escape and open
    // its menu. A release the game asks for itself must not.
    {
      const e = await t.open(env, '?test=1&persist=0&audio=dummy&iwad=/freedoom1.wad&args=' + encodeURIComponent('-warp 1 1 -skill 1'));
      await t.waitState(e.page, 'ready');
      await e.page.click('#start');
      await e.page.waitForTimeout(6000);
      const sk = await env.browser.newContext();
      const dec = await sk.newPage();
      const lock = async () => {
        for (let i = 0; i < 5 && !(await e.page.evaluate(() => !!document.pointerLockElement)); i++) { await e.page.mouse.click(500, 300); await e.page.waitForTimeout(500); }
        return e.page.evaluate(() => document.pointerLockElement === document.getElementById('canvas'));
      };
      t.check(await lock(), 'in a level, a click on the picture locks the pointer');
      await e.page.waitForTimeout(1500);
      const menuUp = () => menuOpen(e.page, dec);
      t.check(!(await menuUp()), 'no menu is open while playing');
      // Mouse motion while the pointer is locked turns the view; without moving the mouse it does not.
      // (Playwright's mouse.move gives a locked pointer no movement after the first event, so the page gets mousemove events
      // with movementX made here, as the browser makes them for a locked pointer.)
      const sweep = async () => {
        for (let i = 0; i < 20; i++) {
          await e.page.evaluate(() => document.getElementById('canvas').dispatchEvent(new MouseEvent('mousemove', { movementX: 40, movementY: 0, bubbles: true, cancelable: true })));
          await e.page.waitForTimeout(30);
        }
      };
      const still = await t.changedPixels(e.page, null, 800);
      const moved = await t.changedPixels(e.page, SAB === 'nomouse' ? null : sweep, 800);
      t.check(moved > 50000 && moved > 5 * still, `moving the mouse while the pointer is locked turns the view (${moved} pixels changed; ${still} when nothing moves)`);
      // (a) the game itself lets go of the pointer (document.exitPointerLock): no Escape is made up, no menu opens
      await e.page.evaluate(() => document.exitPointerLock());
      await e.page.waitForTimeout(1200);
      t.check(!(await e.page.evaluate(() => !!document.pointerLockElement)), 'the pointer was released');
      t.check(!(await menuUp()), 'a release the game asked for does not open the menu');
      // With the pointer released the mouse is not the game's: moving it over the picture must not turn the view.
      const swept = await t.changedPixels(e.page, SAB === 'unlockedmouse' ? () => e.page.evaluate(() => { window.dlTest.passMouse = true; }).then(sweep) : sweep, 800);
      t.check(swept < 20000, `moving the mouse while the pointer is released does not turn the view (${swept} pixels changed)`);
      t.check(await lock(), 'a click locks the pointer again');
      await e.page.waitForTimeout(1500);
      // (b) the browser takes the pointer (as it does for Escape): the page passes an Escape on and the menu opens
      await e.page.evaluate((real) => (real ? Document.prototype.exitPointerLock.call(document) : document.exitPointerLock()), SAB !== 'noesc');
      await e.page.waitForTimeout(1500);
      t.check(await menuUp(), 'when the browser takes the pointer (as Escape does) the game still gets an Escape: its menu opens');
      t.check(e.errors.length === 0, 'no page error in the level', e.errors.join(' | '));
      await sk.close();
      await e.context.close();
    }
  } finally {
    await t.stop(env);
  }
  return t.summary('smoke');
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
