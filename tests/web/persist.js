#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Config and savegames survive a reload of the page (brief 02: AC6): IDBFS at /persist.
//
//   node tests/web/persist.js
//   PERSIST_SABOTAGE=nosync node tests/web/persist.js   # the page never writes to IndexedDB: the checks must FAIL
//
// Run 1: start E1M1 of Freedoom, walk a little, change a setting (the console variable `soundvolume`),
// save the game into slot 3 from the console, and open and close the menu (which writes the config: a page
// can be closed at any moment, so the game saves its config when the menu closes and not only at quit).
// Then reload the page (the same browser profile) and start the game again, with `-loadgame 3`, and check that
//   - config.cfg and the savegame are in /persist (read back from the game's files),
//   - the game uses them: `saveconfig` writes the value the game holds, which is the changed one, and the
//     picture after the load is the saved one (the place walked to), not the level's first view.
// The control run is the same with ?persist=0 (a test switch: no IDBFS): the reload loses both.
// Needs scripts/build-wasm.sh, scripts/fetch-test-data.sh.
'use strict';
const t = require('./lib.js');

const SABOTAGE = process.env.PERSIST_SABOTAGE === 'nosync';
const VOLUME = '7';          // the default is 15

// Types console commands: the console opens with the backquote key and slides down.
async function consoleCmds(page, cmds) {
  await t.tap(page, 'Backquote');
  await page.waitForTimeout(1200);
  for (const text of cmds) {
    await page.keyboard.type(text, { delay: 50 });
    await t.tap(page, 'Enter');
    await page.waitForTimeout(700);
  }
  await t.tap(page, 'Backquote');
  await page.waitForTimeout(1000);
}
const out = (page) => page.evaluate(() => window.dlOut.join('\n'));
const files = (page) => page.evaluate(() => {
  const FS = window.dlTest.FS, list = [];
  const walk = (d) => FS.readdir(d).forEach((n) => { if (n === '.' || n === '..') return; const p = d + '/' + n; (FS.isDir(FS.stat(p).mode) ? walk(p) : list.push(p)); });
  try { walk('/persist'); } catch (e) { /* no folder */ }
  return list;
});

async function session(env, context, persist, extra) {
  const q = '?test=1&audio=dummy&iwad=/freedoom1.wad&args=' + encodeURIComponent(JSON.stringify(['-nosound'].concat(extra || ['-warp', '1', '1', '-skill', '1']))) + (persist ? '' : '&persist=0');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(env.base + q);
  await t.waitState(page, 'ready');
  if (SABOTAGE) { await page.evaluate(() => { window.dlTest.FS.syncfs = function (populate, cb) { if (cb) cb(null); }; }); }   // the page never writes to IndexedDB
  await page.click('#start');
  await t.waitState(page, 'running');
  await page.waitForTimeout(6000);              // the level loads
  return { page, errors };
}

async function main() {
  const env = await t.start();
  try {
    for (const persist of [true, false]) {
      const label = persist ? 'with IndexedDB' : 'control run, no IDBFS';
      const context = await env.browser.newContext({ viewport: { width: 1000, height: 800 } });
      // --- run 1: change a setting, save a game ---
      let s = await session(env, context, persist);
      const fresh = await s.page.locator('#canvas').screenshot({ type: 'png' });      // the level's first view
      await t.tap(s.page, 'ArrowUp', 1200);         // walk, so that the saved view is not the level's first
      await s.page.waitForTimeout(500);
      await consoleCmds(s.page, ['soundvolume ' + VOLUME, 'save 3 persisttest']);
      await s.page.waitForTimeout(1500);
      const saved = await s.page.locator('#canvas').screenshot({ type: 'png' });      // what the player saw
      // Escape opens the menu and a second one closes it: the game writes its config.
      await t.tap(s.page, 'Escape'); await s.page.waitForTimeout(800);
      await t.tap(s.page, 'Escape'); await s.page.waitForTimeout(1500);
      const f1 = await files(s.page);
      const sav1 = f1.filter((p) => /\.dsg$/.test(p));
      t.check(f1.some((p) => /config\.cfg$/.test(p)) && sav1.length === 1, `${label}: run 1 wrote config.cfg and one savegame (${f1.map((p) => p.replace('/persist/', '')).join(', ')})`);
      await s.page.close();
      // --- reload (a new page in the same browser profile) ---
      s = await session(env, context, persist, ['-loadgame', '3']);     // the game loads slot 3 as it starts
      const f2 = await files(s.page);
      const hasCfg = f2.some((p) => /config\.cfg$/.test(p));
      const sav2 = f2.filter((p) => /\.dsg$/.test(p));
      const cfgText = await s.page.evaluate(() => { const b = window.dlTest.readFile('/persist/.doomlegacy/config.cfg'); return b ? new TextDecoder().decode(b) : ''; });
      const cfgOk = new RegExp('^soundvolume "' + VOLUME + '"', 'm').test(cfgText);
      const savText = await s.page.evaluate(() => { const b = window.dlTest.readFile('/persist/.doomlegacy/doomsav3.dsg'); return b ? new TextDecoder('latin1').decode(b) : ''; });
      // What the game itself holds: its config written to another file (the saveconfig command), and a load of slot 3
      const loaded = await s.page.locator('#canvas').screenshot({ type: 'png' });
      await consoleCmds(s.page, ['saveconfig check']);
      const dSaved = await t.pixelDiff(s.page, saved, loaded), dFresh = await t.pixelDiff(s.page, fresh, loaded);
      const held = await s.page.evaluate(() => { const b = window.dlTest.readFile('/work/check.cfg'); return b ? new TextDecoder().decode(b) : ''; });
      const heldVol = (/^soundvolume "(\d+)"/m.exec(held) || [])[1];
      const err = await s.page.evaluate(() => window.dlErr.join('\n'));
      const cantRead = /Couldn't read file/.test(err);
      const sameView = dSaved < 0.25 * dFresh;     // the load brought back the walked-to place: the picture is closer to the saved one than to the first view
      if (persist) {
        t.check(hasCfg && cfgOk, `${label}: after the reload config.cfg is still there with the changed setting (soundvolume "${VOLUME}": ${cfgOk})`);
        t.check(sav2.length === 1 && /persisttest/.test(savText), `${label}: after the reload the savegame is still there, with its name (${sav2.join(', ') || 'none'})`);
        t.check(heldVol === VOLUME, `${label}: the game uses the setting: it holds soundvolume ${heldVol} (saveconfig; default 15)`);
        t.check(!cantRead && sameView, `${label}: the game loads the saved game (-loadgame 3): the picture is the one saved (${dSaved} pixels differ) and not the level's first view (${dFresh} differ)`);
      } else {
        t.check(!hasCfg || !cfgOk, `${label}: the reload lost the setting (config.cfg ${hasCfg ? 'present' : 'absent'}, soundvolume ${VOLUME} in it: ${cfgOk})`);
        t.check(sav2.length === 0, `${label}: the reload lost the savegame (${sav2.join(', ') || 'none'})`);
        t.check(heldVol !== VOLUME, `${label}: the game holds soundvolume ${heldVol}, not ${VOLUME}`);
        t.check(!sameView, `${label}: -loadgame 3 finds nothing to load: the picture is not the saved one (${dSaved} pixels differ from it)`);
      }
      t.check(s.errors.length === 0, `${label}: no page error`, s.errors.join(' | '));
      await context.close();
    }
  } finally { await t.stop(env); }
  return t.summary('persist');
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
