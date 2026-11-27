#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The page's table of known IWADs (web/iwads.js) agrees with scripts/fetch-test-data.sh (brief 03: AC9), and
// the default configuration (web/config.js) is the shareware entry of that table. No browser, no build needed.
//
//   node tests/web/iwad-table.js
//   IWAD_TABLE_SABOTAGE=1 node tests/web/iwad-table.js     # a digit of one hash is changed in the table: the checks must FAIL
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const t = require('./lib.js');

const root = t.root;
let iwadsSrc = fs.readFileSync(path.join(root, 'web', 'iwads.js'), 'utf8');
if (process.env.IWAD_TABLE_SABOTAGE) { iwadsSrc = iwadsSrc.replace('1d7d43be', '1d7d43bf'); }
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
process.exit(t.summary('iwad-table'));
