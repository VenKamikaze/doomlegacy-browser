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
//  2. a missing IWAD URL: the page says which file it could not fetch
//  3. an IWAD the game cannot find (the launcher's "press ESC" loop, bugs.md L18): the game ends
//     with its messages instead of waiting for a key
//  4. a file that is no IWAD: I_Error, exit status not 0, its message on the page
//  5. a game that quits by itself in the middle of a level (-testquit)
// Needs scripts/build-wasm.sh, scripts/fetch-test-data.sh.
'use strict';
const t = require('./lib.js');

const SABOTAGE = process.env.EXITS_SABOTAGE === 'silent';

async function main() {
  const env = await t.start({ '/data/notawad.wad': t.root + '/README.md' });
  try {
    const base = 'persist=0&home=/work&audio=dummy&args=' + encodeURIComponent(JSON.stringify(['-nosound']));
    const ended = (r) => r.state === 'ended' && r.reloadVisible && r.overlayVisible;

    // 1. quit from the menu
    {
      const r = await t.runGame(env, base + '&iwad=/freedoom1.wad', {
        script: async (page) => {
          await t.waitState(page, 'running');
          await page.waitForTimeout(4000);
          if (SABOTAGE) { await page.evaluate(() => { Module.onExit = function () {}; }); }
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

    // 2. a missing IWAD URL: the page's own message
    {
      const r = await t.runGame(env, base + '&iwad=/nosuch.wad', { timeoutMs: 20000 });
      t.check(r.state === 'error' && r.reloadVisible && r.overlayVisible, `a missing IWAD URL: the page shows the error state (state ${r.state})`);
      t.check(/nosuch\.wad/.test(r.status) && /404/.test(r.status), `... and says which file and why: "${r.status.replace(/\n/g, ' / ')}"`);
      await r.context.close();
    }

    // 3. the IWAD is not where the game looks: soft errors, then the launcher in a normal build
    {
      const r = await t.runGame(env, base + '&iwad=/freedoom1.wad&nofetch=1', { timeoutMs: 30000 });
      t.check(r.state === 'error' && r.reloadVisible && r.overlayVisible, `a missing IWAD for the game: the game ends, the page shows the error state (state ${r.state}, ${r.seconds.toFixed(1)} s)`);
      t.check(/freedoom1\.wad not found/.test(r.status) && /Cannot start the game/.test(r.status), `... with the game's own words (what it could not find, and that it cannot start): "${r.status.replace(/\n/g, ' / ')}"`);
      t.check(r.exit && r.exit.code !== 0, `... and a status that is not 0 (${JSON.stringify(r.exit)})`);
      t.check(!/Fatal error display: \(press ESC/.test(r.out + r.err), 'the launcher\'s "press ESC" loop was not entered');
      await r.context.close();
    }

    // 4. a file that is not an IWAD
    {
      const r = await t.runGame(env, base + '&iwad=/data/notawad.wad', { timeoutMs: 30000 });
      t.check(r.state === 'error' && r.reloadVisible, `a file that is no IWAD: I_Error ends the game (state ${r.state}, ${r.seconds.toFixed(1)} s)`);
      t.check(r.exit && r.exit.code !== 0, `... status not 0 (${JSON.stringify(r.exit)})`);
      t.check(/Cannot start the game/.test(r.status) && /notawad|not found|IWAD/.test(r.status), `... with a message: "${r.status.replace(/\n/g, ' / ')}"`);
      await r.context.close();
    }

    // 5. a game that quits by itself while a level runs
    {
      const q = base.replace(/args=[^&]*/, 'args=' + encodeURIComponent(JSON.stringify(['-nosound', '-warp', '1', '1', '-testquit', '40'])));
      const r = await t.runGame(env, q + '&iwad=/freedoom1.wad', { timeoutMs: 30000 });
      t.check(ended(r) && r.exit && r.exit.code === 0, `-testquit ends a running level with status 0: the end state (${r.state}, ${JSON.stringify(r.exit)})`);
      await r.context.close();
    }
  } finally { await t.stop(env); }
  return t.summary('exits');
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
