#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The ways the game ends, in the page (brief 02: AC7). Each must leave the page in the "the game
// has ended" state: the overlay with a message and a reload button, not a frozen canvas.
//
//   node tests/web/exits.js
//   EXITS_SABOTAGE=silent node tests/web/exits.js   # the page ignores the game's exit: the checks must FAIL
//
//  1. a quit from the menu (F10, then Y): "The game has ended.", status 0
//  2. a missing IWAD URL: the page says which file it could not fetch (brief 03: the data state, with the picker and "Try again")
//  3. an IWAD the game cannot find (the launcher's "press ESC" loop, bugs.md L18): the game ends
//     with its messages instead of waiting for a key
//  4. a file that is no IWAD, handed to the game as it is (raw=1: the page's own loader would refuse it, tests/web/data.js):
//     I_Error, exit status not 0, its message on the page
//  5. a game that quits by itself in the middle of a level (-testquit)
//  6. an IWAD URL on another origin that does not answer: a data error with the CORS hint (brief 02 refused any other origin)
// Needs scripts/build-wasm.sh, scripts/fetch-test-data.sh.
'use strict';
const t = require('./lib.js');

const SABOTAGE = process.env.EXITS_SABOTAGE === 'silent';
// The sabotage, for every case: the page's Module.onExit does nothing (set as page.js assigns window.Module). The cases that
// end through onExit (1, 3, 4, 5) must then fail; the page's own errors (2, 6) do not go through it.
const INIT = SABOTAGE ? () => { let m; Object.defineProperty(window, 'Module', { configurable: true, get() { return m; }, set(v) { m = v; v.onExit = function () {}; } }); } : undefined;

async function main() {
  const env = await t.start({ '/data/notawad.wad': t.root + '/README.md' });
  try {
    const base = 'persist=0&home=/work&audio=dummy&args=' + encodeURIComponent(JSON.stringify(['-nosound']));
    const ended = (r) => r.state === 'ended' && r.reloadVisible && r.overlayVisible;

    // 1. quit from the menu
    {
      const r = await t.runGame(env, base + '&iwad=/freedoom1.wad', {
        init: INIT,
        script: async (page) => {
          await t.waitState(page, 'running');
          await page.waitForTimeout(4000);
          await t.tap(page, 'F10'); await page.waitForTimeout(700);
          await t.tap(page, 'y');
        },
        timeoutMs: SABOTAGE ? 15000 : 60000,
      });
      t.check(ended(r), `quit from the menu: the page shows the end state (state ${r.state}, reload button ${r.reloadVisible}, overlay ${r.overlayVisible})`);
      t.check(/The game has ended\./.test(r.status), `... with its message: "${r.status.replace(/\n/g, ' / ')}"`);
      t.check(r.exit && r.exit.code === 0, `... and exit status 0 (${JSON.stringify(r.exit)})`);
      t.check(r.errors.length === 0, 'no uncaught page error', r.errors.join(' | '));
      await r.context.close();
    }

    // 2. a missing IWAD URL: the page's own message, and the way out (brief 03: not the end state: the picker and "Try again")
    {
      const o = await t.open(env, '?test=1&' + base + '&iwad=/nosuch.wad');
      const st = await t.waitState(o.page, ['nodata', 'ready', 'error'], 20000);
      const status = await o.page.evaluate(() => document.getElementById('status').textContent);
      const vis = await o.page.evaluate(() => ['pickwrap', 'retry'].map((i) => !document.getElementById(i).hidden));
      t.check(st === 'nodata' && vis[0] && vis[1], `a missing IWAD URL: the page shows the data error with the picker and "Try again" (state ${st})`);
      t.check(/nosuch\.wad/.test(status) && /404/.test(status), `... and says which file and why: "${status.replace(/\n/g, ' / ')}"`);
      t.check(await o.page.evaluate(() => !document.getElementById('overlay').hidden), '... the overlay with the message is visible');
      t.check((await o.page.evaluate(() => window.dlStarts)) === 0, '... the game was not started');
      await o.context.close();
    }

    // 3. the IWAD is not where the game looks: soft errors, then the launcher in a normal build
    {
      const r = await t.runGame(env, base + '&iwad=/freedoom1.wad&nofetch=1', { timeoutMs: 30000, init: INIT });
      t.check(r.state === 'error' && r.reloadVisible && r.overlayVisible, `a missing IWAD for the game: the game ends, the page shows the error state (state ${r.state}, ${r.seconds.toFixed(1)} s)`);
      t.check(/freedoom1\.wad not found/.test(r.status) && /Cannot start the game/.test(r.status), `... with the game's own words (what it could not find, and that it cannot start): "${r.status.replace(/\n/g, ' / ')}"`);
      t.check(r.exit && r.exit.code !== 0, `... and a status that is not 0 (${JSON.stringify(r.exit)})`);
      t.check(!/Fatal error display: \(press ESC/.test(r.out + r.err), 'the launcher\'s "press ESC" loop was not entered');
      await r.context.close();
    }

    // 4. a file that is not an IWAD
    {
      const r = await t.runGame(env, base + '&raw=1&iwad=/data/notawad.wad', { timeoutMs: 30000, init: INIT });
      t.check(r.state === 'error' && r.reloadVisible, `a file that is no IWAD: I_Error ends the game (state ${r.state}, ${r.seconds.toFixed(1)} s)`);
      t.check(r.exit && r.exit.code !== 0, `... status not 0 (${JSON.stringify(r.exit)})`);
      t.check(/Cannot start the game/.test(r.status) && /notawad|not found|IWAD/.test(r.status), `... with a message: "${r.status.replace(/\n/g, ' / ')}"`);
      await r.context.close();
    }

    // 5. a game that quits by itself while a level runs
    {
      const q = base.replace(/args=[^&]*/, 'args=' + encodeURIComponent(JSON.stringify(['-nosound', '-warp', '1', '1', '-testquit', '40'])));
      const r = await t.runGame(env, q + '&iwad=/freedoom1.wad', { timeoutMs: 30000, init: INIT });
      t.check(ended(r) && r.exit && r.exit.code === 0, `-testquit ends a running level with status 0: the end state (${r.state}, ${JSON.stringify(r.exit)})`);
      await r.context.close();
    }

    // 6. an IWAD on another origin that does not answer: a clear message with the CORS hint, no game (brief 03 allows other origins)
    {
      const o = await t.open(env, '?test=1&' + base + '&iwad=' + encodeURIComponent('http://127.0.0.1:1/freedoom1.wad'));
      const st = await t.waitState(o.page, ['nodata', 'ready', 'error'], 20000);
      const status = await o.page.evaluate(() => document.getElementById('status').textContent);
      t.check(st === 'nodata' && /127\.0\.0\.1:1/.test(status) && /CORS/.test(status), `an IWAD URL on another origin that does not answer: a data error with the CORS hint (state ${st}): "${status.replace(/\n/g, ' / ').slice(0, 140)}"`);
      t.check((await o.page.evaluate(() => window.dlStarts)) === 0, '... the game was not started');
      await o.context.close();
    }
  } finally { await t.stop(env); }
  return t.summary('exits');
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
