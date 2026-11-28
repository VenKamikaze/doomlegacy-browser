#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The page's table of known IWADs (web/iwads.js) agrees with scripts/fetch-test-data.sh (brief 03: AC9), and
// the default configuration (web/config.js) is the shareware entry of that table. No browser, no build needed.
//
//   node tests/web/iwad-table.js
//   IWAD_TABLE_SABOTAGE=1 node tests/web/iwad-table.js     # a digit of one hash is changed in the table: the checks must FAIL
//   IWAD_TABLE_SABOTAGE=names|classify node tests/web/iwad-table.js   # a name dropped from DL_ENGINE_NAMES / the Heretic rules of
//                                                                     # classify() removed: the checks must FAIL
//
// Also (fix round 1): the engine's IWAD file names (web/iwads.js DL_ENGINE_NAMES) equal the ones in src/d_main.c's game_desc_table,
// and data.js's classify() agrees with the table's own key, required and rejected lumps: for every game of the table, the lumps
// that make the engine accept it give a file name under which the engine (simulated here, in table order) accepts the same game.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const t = require('./lib.js');

const root = t.root;
let iwadsSrc = fs.readFileSync(path.join(root, 'web', 'iwads.js'), 'utf8');
const SAB = process.env.IWAD_TABLE_SABOTAGE || '';
if (SAB === '1') { iwadsSrc = iwadsSrc.replace('1d7d43be', '1d7d43bf'); }
if (SAB === 'names') { iwadsSrc = iwadsSrc.replace("'heretic.wad', ", ''); }
const sh = fs.readFileSync(path.join(root, 'scripts', 'fetch-test-data.sh'), 'utf8');

// What the script verifies: lines "member|file name|SHA-256|MD5|SHA-1" inside the FD_WADS and D1_WADS blocks.
const script = {};
for (const block of ['FD_WADS', 'D1_WADS']) {
  const m = new RegExp(block + '="\\n([^"]*)"').exec(sh);
  t.check(!!m, `scripts/fetch-test-data.sh has a ${block} block`);
  if (!m) { continue; }
  for (const line of m[1].split('\n').filter(Boolean)) {
    const [, name, sum] = line.split('|');
    script[name] = sum;
  }
}

function sandbox(src, name) {
  const win = {};
  vm.runInNewContext(src, { window: win }, { filename: name });
  return win;
}
const table = sandbox(iwadsSrc, 'iwads.js').DL_IWADS || [];
const cfg = sandbox(fs.readFileSync(path.join(root, 'web', 'config.js'), 'utf8'), 'config.js');

t.check(table.length === Object.keys(script).length && table.length === 3, `the page's table has ${table.length} entries, the script verifies ${Object.keys(script).length}`);
for (const [name, sum] of Object.entries(script)) {
  const e = table.find((x) => x.file === name);
  t.check(!!e && e.sha256 === sum, `${name}: SHA-256 in the table equals the script's (${e && e.sha256.slice(0, 12)}... / ${sum.slice(0, 12)}...)`);
}
for (const e of table) {
  t.check(e.size > 0 && /^[0-9a-f]{64}$/.test(e.sha256) && /\.wad$/.test(e.file) && !!e.game, `${e.file}: a size, a 64-digit lower-case hash, a name for the game`);
}
// The sizes against the real files, when they are there (the script does not list sizes: it checks hashes).
for (const e of table) {
  const f = path.join(root, 'testdata', e.file);
  if (!fs.existsSync(f)) { t.check(false, `testdata/${e.file} is missing: run scripts/fetch-test-data.sh`); continue; }
  const b = fs.readFileSync(f);
  t.check(b.length === e.size && crypto.createHash('sha256').update(b).digest('hex') === e.sha256, `${e.file}: the file in testdata/ has the table's size (${e.size}) and SHA-256`);
}
// Published values for the shareware file (README.md Q2, doomwiki.org): size 4,196,020; MD5 and SHA-1 are in the script.
const d1 = table.find((x) => x.file === 'doom1.wad');
t.check(d1 && d1.size === 4196020, 'doom1.wad is 4,196,020 bytes, the published size of the shareware 1.9 file');
t.check(/DOOM1\.WAD\|doom1\.wad\|[0-9a-f]{64}\|f0cefca49926d00903cf57551d901abe\|5b2e249b9c5133ec987b3ea77596381dc0d6bc1d/.test(sh), 'the script checks doom1.wad against the published MD5 and SHA-1 as well');
// The configuration: the default is the shareware file, the example is Freedoom, both as the table has them.
const ex = cfg.DL_CONFIG_EXAMPLES || {};
for (const [k, file] of [['doom1', 'doom1.wad'], ['freedoom1', 'freedoom1.wad']]) {
  const e = table.find((x) => x.file === file);
  const c = ex[k];
  t.check(c && e && c.url === file && c.name === file && c.size === e.size && c.sha256 === e.sha256, `config.js's ${k} entry is the table's ${file} (url, name, size, SHA-256)`);
}
t.check(cfg.DL_CONFIG && cfg.DL_CONFIG.data === ex.doom1 && ex.doom1.revalidate === false, 'the default configuration is the shareware entry, without revalidation');

// ---- the engine's names and rules, from src/d_main.c ----
const dmain = fs.readFileSync(path.join(root, 'src', 'd_main.c'), 'utf8');
const region = dmain.slice(dmain.indexOf('game_desc_t  game_desc_table[ NUM_GDESC ] ='), dmain.indexOf('#ifdef LAUNCHER', dmain.indexOf('game_desc_table[ NUM_GDESC ] =')));
const LN = { LN_MAP01: 'MAP01', LN_E1M1: 'E1M1', LN_E2M2: 'E2M2', LN_TITLE: 'TITLE' };
const lumpsOf = (expr) => expr.split('+').map((s) => s.trim()).filter((s) => LN[s]).map((s) => LN[s]);
const entries = [];
const re = /\{\s*"([^"]*)"\s*,\s*(?:NULL|"[^"]*")\s*,\s*"[^"]*"\s*,\s*\{([^}]*)\}\s*,\s*NULL\s*,\s*\{([^}]*)\}\s*,\s*([^,]*),\s*([^,]*),/g;
for (let m; (m = re.exec(region));) {
  entries.push({ title: m[1], names: (m[2].match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1).toLowerCase()),
                 key: (m[3].match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)), need: lumpsOf(m[4]), reject: lumpsOf(m[5]) });
}
t.check(entries.length >= 20, `parsed ${entries.length} entries of game_desc_table in src/d_main.c`);
const engineNames = [...new Set([].concat(...entries.map((e) => e.names)))].sort();
const pageNames = ((sandbox(iwadsSrc, 'iwads.js').DL_ENGINE_NAMES) || []).slice().sort();
t.check(JSON.stringify(engineNames) === JSON.stringify(pageNames), `web/iwads.js DL_ENGINE_NAMES (${pageNames.length}) equal the IWAD file names in d_main.c's table (${engineNames.length})`,
        'only in d_main.c: ' + engineNames.filter((n) => !pageNames.includes(n)) + '; only in iwads.js: ' + pageNames.filter((n) => !engineNames.includes(n)));
// The engine, in table order: the first entry that lists the name and whose lumps pass.
function engineAccepts(name, has) {
  for (const e of entries) {
    if (!e.names.includes(name)) { continue; }
    if (e.need.every((l) => has[l]) && !e.reject.some((l) => has[l]) && e.key.every((k) => has[k])) { return e; }
  }
  return null;
}
let dataSrc = fs.readFileSync(path.join(root, 'web', 'data.js'), 'utf8');
if (SAB === 'classify') { dataSrc = dataSrc.replace("if (has.TITLE) {\n      if (has.MAP01)", "if (false) {\n      if (has.MAP01)"); }
const dwin = sandbox(iwadsSrc, 'iwads.js');
vm.runInNewContext(dataSrc, { window: dwin }, { filename: 'data.js' });
for (const e of entries) {
  if (/mode/i.test(e.title)) { continue; }          // the "... mode" entries repeat another game's names and rules
  const has = {};
  for (const l of e.key.concat(e.need)) { has[l] = 1; }
  const name = dwin.DlData.classify(has);
  const got = name && engineAccepts(name, has);
  t.check(!!got && got.title === e.title, `${e.title} (lumps ${Object.keys(has).join(' ') || 'none'}): classify gives "${name}", which the engine accepts as "${got && got.title}"`);
}
// The games that also hold Doom's lumps: the whole of a real Heretic, a Hexen, a Strife (lump names only; the engine's rules decide).
const heretic = { E1M1: 1, E2M2: 1, E3M9: 1, E4M1: 1, TITLE: 1, MAP01: 0 };
t.check(dwin.DlData.classify(heretic) === 'heretic.wad', 'a Heretic with E3M9 and E4M1 (the registered one) is heretic.wad, not a Doom');
t.check(dwin.DlData.classify({ E1M1: 1, TITLE: 1 }) === 'heretic1.wad', 'a shareware Heretic (no E2M2) is heretic1.wad');
t.check(dwin.DlData.classify({ MAP01: 1, MAP40: 1, TITLE: 1 }) === 'hexen.wad' && dwin.DlData.classify({ MAP01: 1, TITLE: 1 }) === 'hexen1.wad', 'Hexen and its demo are not doom2.wad');
t.check(dwin.DlData.classify({ ENDSTRF: 1, MAP01: 1, MAP20: 1 }) === 'strife.wad', 'Strife is not doom2.wad');
process.exit(t.summary('iwad-table'));
