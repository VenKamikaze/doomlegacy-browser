#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Browser netplay (brief 04): Chromium pages (Playwright; never run `playwright install`) and native games play
// network games through a local vnet relay, and every machine's -testdump file is compared with the host's.
//
//   node tests/web/netplay.js --list                   # the scenarios
//   node tests/web/netplay.js ws wt                    # these, one after the other
//   node tests/web/netplay.js --runs 3 impaired        # 3 runs of each named scenario (default 1)
//   node tests/web/netplay.js                          # every scenario once
//   NETPLAY_SABOTAGE=name node tests/web/netplay.js ...   # a failure proof of the test itself (below)
//
// Failure proofs of the test's own checks (AC9; a source change is proved by a build with it reverted, see the Outcome):
//   NETPLAY_SABOTAGE=nowt      a WebTransport scenario's pages are given no relay_wt and relay_cert: they use the WebSocket, and the
//                              transport check must fail
//   NETPLAY_SABOTAGE=flip      one byte of the last machine's dump is changed before the comparison: it must see the difference
//   NETPLAY_SABOTAGE=short     the last machine's dump is cut to its first half: the length check must fail
//   NETPLAY_SABOTAGE=noerrpage (errors) the page's network bar is not read: the "failure visible on the page" checks must fail
//
// Needs build/wasm/bin (scripts/build-wasm.sh), the native build/native/bin/doomlegacy (scripts/build-native.sh),
// testdata/freedoom1.wad (scripts/fetch-test-data.sh) and the relay (scripts/build-relay.sh, built here if it is
// missing). Run one scenario at a time on a machine that is not busy: the games run in real time and each takes a core.
//
// How a game is checked. Every machine plays Freedoom 1 E1M1 at normal pace (the pages are not given the test
// pacing: lockstep runs in real time) with -testdump, one 28-byte record of the state per game tic
// (doco/browser/building.md section 10). The test snapshots every file at one moment, after the last machine has
// played PLAY seconds since it joined, and compares each machine's file with the host's for every tic both have
// (tests/tools/testdump-diff.py --common). A joiner's file starts at its join tic.
//
// The relay is started per game, on ports it picks (UDP for the native players, the WebSocket for the pages, WebTransport
// with -dev-cert for the pages), with -origins the page's exact host:port. A page takes the relay from the test-only
// knobs of the address (?test=1&relay=ws://...&relay_wt=https://...&relay_cert=HASH&impair=SPEC).
'use strict';
const { chromium } = require('playwright');
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serve } = require('../tools/serve.js');
const L = require('./lib.js');

const root = L.root;
const GAME = process.env.NETPLAY_GAME || path.join(root, 'build', 'native', 'bin', 'doomlegacy');
const RELAY_BIN = process.env.NETPLAY_RELAY || path.join(root, 'build', 'relay', 'vnet-relay');
const IWAD = L.IWAD;
const DIFF = path.join(root, 'tests', 'tools', 'testdump-diff.py');
const REC = 28;                       // bytes per tic in a -testdump file
const TICRATE = 35;
const check = L.check;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const SABOTAGE = process.env.NETPLAY_SABOTAGE || '';
const GAPMAX = +(process.env.NETPLAY_GAPMAX || 5000);    // the longest allowed stretch without a poll of vnet, ms
const JOIN_RUNS = +(process.env.NETPLAY_JOIN_RUNS || 5);   // connect-spin: joins timed

// How long (seconds of game time) a game runs before a late joiner comes, and after the last join.
const JOIN_AFTER = +(process.env.NETPLAY_JOIN_AFTER || 10);
const PLAY = +(process.env.NETPLAY_PLAY || 30);
// The impairment of the impaired scenarios (every machine, its own seed): brief 04 §6.
const IMPAIR = 'lat=30,jit=10,loss=3,dup=2,reorder=3';

// What in a log is a fault: as tests/net/test-relay.sh, and what a page adds.
const FAULTS = /consistency (fault|failure)|desync|out of sync|Client repair|Report: gametic|Kick (node|player)|savegame failed|Can.t load the level|vnet: (cannot|the relay session ended|ending)|does not fit in a vnet datagram|pageerror|Something went wrong|The game crashed|The game stopped with an error/i;

// ---- relay ------------------------------------------------------------------------------------------------

function ensureRelay() {
  if (!fs.existsSync(RELAY_BIN)) { execFileSync(path.join(root, 'scripts', 'build-relay.sh'), { stdio: 'inherit' }); }
  if (!fs.existsSync(RELAY_BIN)) { throw new Error(RELAY_BIN + ' not found: run scripts/build-relay.sh'); }
}

// A relay on 127.0.0.1 with every port picked by the relay: UDP, the WebSocket (/vnet), WebTransport with a development
// certificate. The page's origin must be the exact host:port the pages are served from.
async function startRelay(origin, extra) {
  ensureRelay();
  const args = ['-udp', '127.0.0.1:0', '-http', '127.0.0.1:0', '-wt', '127.0.0.1:0', '-dev-cert', '-origins', origin, '-v'].concat(extra || []);
  const child = spawn(RELAY_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  const t0 = now();
  while (!/^LISTEN /m.test(text)) {
    if (child.exitCode !== null) { throw new Error('the relay exited: ' + text); }
    if (now() - t0 > 15000) { throw new Error('the relay did not start: ' + text); }
    await sleep(50);
  }
  const line = /^LISTEN .*$/m.exec(text)[0];
  const port = (key) => { const m = new RegExp(key + '=\\S*:(\\d+)').exec(line); return m ? m[1] : ''; };
  const relay = {
    child, args, log: () => text,
    udp: '127.0.0.1:' + port('udp'),
    ws: 'ws://127.0.0.1:' + port('http') + '/vnet',
    wt: 'https://127.0.0.1:' + port('wt') + '/vnet',
    cert: (/wt_cert_sha256=(\S+)/.exec(line) || [])[1] || '',
    stopped: false,
  };
  relay.stop = async () => {
    if (relay.stopped) { return; }
    relay.stopped = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* gone */ }
    await sleep(150);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
  };
  return relay;
}

// ---- the pages ----------------------------------------------------------------------------------------------

let envState = null;    // { server, browser, base, origin }
async function env() {
  if (!envState) {
    if (!fs.existsSync(path.join(L.BUILD, 'doomlegacy.wasm'))) { throw new Error(L.BUILD + '/doomlegacy.wasm not found: run scripts/build-wasm.sh'); }
    if (!fs.existsSync(IWAD)) { throw new Error(IWAD + ' not found: run scripts/fetch-test-data.sh'); }
    const server = await serve(L.BUILD, {}, 0);
    const browser = await chromium.launch();
    const port = server.address().port;
    envState = { server, browser, base: `http://127.0.0.1:${port}/index.html`, origin: `127.0.0.1:${port}` };
  }
  return envState;
}
async function closeEnv() {
  if (!envState) { return; }
  try { await envState.browser.close(); } catch (e) { /* gone */ }
  await new Promise((r) => envState.server.close(r));
  envState = null;
}

// ---- machines -------------------------------------------------------------------------------------------------
// A machine is a page or a native game; both have: name, kind, text() (what the game printed), dumpTics(),
// dump() (the -testdump file as a Buffer, or null), alive(), quit() (a clean exit at the next tic), kill().

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-netplay-'));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
const everyMachine = new Set();

// o.relay: the relay; o.transport: 'wt' or 'ws'; o.args: the game's arguments; o.impair: a spec or ''; o.query: more page knobs
async function startBrowser(name, o) {
  const e = await env();
  const m = { name, kind: 'browser', lines: [], errors: [], dumpName: name + '.bin', ended: false };
  const q = new URLSearchParams({
    test: '1', persist: '0', home: '/work', audio: 'dummy', raw: '1', iwad: '/freedoom1.wad',
    relay: o.relay.ws, args: JSON.stringify(['-nosound', '-skill', '3'].concat(o.args, ['-testdump', m.dumpName])),
  });
  if (o.transport === 'wt' && SABOTAGE !== 'nowt') { q.set('relay_wt', o.relay.wt); q.set('relay_cert', o.relay.cert); }
  if (o.impair) { q.set('impair', o.impair); }
  for (const k of Object.keys(o.query || {})) { q.set(k, o.query[k]); }
  m.context = await e.browser.newContext({ viewport: { width: 800, height: 600 } });
  m.page = await m.context.newPage();
  m.page.on('console', (msg) => { m.lines.push(msg.text()); });
  m.page.on('pageerror', (err) => { m.errors.push('pageerror: ' + err.message); m.lines.push('pageerror: ' + err.message); });
  m.page.on('crash', () => { m.errors.push('the page crashed'); m.lines.push('pageerror: the page crashed'); });
  m.page.on('dialog', (d) => { m.errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  m.text = () => m.lines.join('\n');
  m.state = async () => { try { return await m.page.evaluate(() => window.dlState); } catch (err) { return 'gone'; } };
  m.alive = async () => (await m.state()) === 'running';
  m.dump = async () => {
    try {
      const b64 = await m.page.evaluate((n) => {
        const bytes = window.dlTest.readFile(n);
        if (!bytes) { return null; }
        let s = '';
        for (let i = 0; i < bytes.length; i += 32768) { s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); }
        return btoa(s);
      }, m.dumpName);
      return b64 === null ? null : Buffer.from(b64, 'base64');
    } catch (err) { return null; }
  };
  m.dumpTics = async () => {
    try { return await m.page.evaluate((n) => { const b = window.dlTest.readFile(n); return b ? Math.floor(b.length / 28) : 0; }, m.dumpName); } catch (err) { return 0; }
  };
  m.quit = async () => { try { await m.page.evaluate(() => window.dlTest.quit()); } catch (err) { /* gone */ } };
  m.waitEnd = async (ms) => {
    const t0 = now();
    while (now() - t0 < ms) { const s = await m.state(); if (s === 'ended' || s === 'error' || s === 'gone') { return s; } await sleep(100); }
    return 'timeout';
  };
  m.exitCode = async () => { try { const x = await m.page.evaluate(() => window.dlExit); return x ? x.code : undefined; } catch (err) { return undefined; } };
  m.status = async () => { try { return await m.page.evaluate(() => document.getElementById('status').textContent); } catch (err) { return ''; } };
  m.net = async () => { try { return await m.page.evaluate(() => ({ kind: window.dlNet.kind, text: window.dlNet.text, shown: !document.getElementById('netbar').hidden, bar: document.getElementById('netbar').textContent })); } catch (err) { return null; } };
  m.kill = async () => { try { await m.context.close(); } catch (err) { /* gone */ } };
  everyMachine.add(m);
  await m.page.goto(e.base + '?' + q);
  await L.waitState(m.page, ['ready', 'nodata', 'error'], 60000);
  const st = await m.state();
  if (st !== 'ready') { m.startError = 'the page is in state ' + st + ': ' + (await m.status()); return m; }
  await m.page.click('#start');
  m.startedAt = now();
  return m;
}

// A native game, as tests/net/lib.sh starts one: headless (SDL's dummy drivers), in a directory of its own.
function startNative(name, o) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const m = { name, kind: 'native', dir, buf: '', dumpPath: path.join(dir, name + '.bin') };
  const env = Object.assign({}, process.env, { SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' });
  delete env.VNET_IMPAIR;
  if (o.impair) { env.VNET_IMPAIR = o.impair; }
  const args = ['-home', dir, '-iwad', IWAD, '-nosound', '-nomusic', '-noendtext', '-skill', '3', '-relay', o.relay.udp]
    .concat(o.args, ['-testdump', m.dumpPath]);
  m.child = spawn(GAME, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  m.child.stdout.on('data', (d) => { m.buf += d; });
  m.child.stderr.on('data', (d) => { m.buf += d; });
  m.exited = new Promise((r) => m.child.on('exit', (code, sig) => { m.status = code === null ? 'signal ' + sig : code; r(); }));
  m.text = () => m.buf;
  m.alive = async () => m.child.exitCode === null && m.child.signalCode === null;
  m.dump = async () => (fs.existsSync(m.dumpPath) ? fs.readFileSync(m.dumpPath) : null);
  m.dumpTics = async () => (fs.existsSync(m.dumpPath) ? Math.floor(fs.statSync(m.dumpPath).size / REC) : 0);
  m.quit = async () => { try { process.kill(m.child.pid, 'SIGTERM'); } catch (err) { /* gone */ } };
  m.waitEnd = async (ms) => { await Promise.race([m.exited, sleep(ms)]); return m.child.exitCode === null && m.child.signalCode === null ? 'timeout' : 'ended'; };
  m.exitCode = async () => m.child.exitCode;
  m.kill = async () => { try { process.kill(-m.child.pid, 'SIGKILL'); } catch (err) { /* gone */ } };
  everyMachine.add(m);
  return m;
}

async function killAll() {
  for (const m of everyMachine) { try { await m.kill(); } catch (e) { /* gone */ } }
  everyMachine.clear();
}

// ---- helpers of the scenarios ---------------------------------------------------------------------------------

async function waitFor(fn, ms, what) {
  const t0 = now();
  for (;;) {
    const v = await fn();
    if (v) { return v; }
    if (now() - t0 > ms) { return null; }
    await sleep(250);
  }
}

function roomCode(m) { const r = /vnet: room code ([A-Z2-9]{6}) /.exec(m.text()); return r ? r[1] : ''; }

// Compare two dump files (Buffers) over the tics both have: { ok, text }.
function compareDumps(a, b, tag) {
  const fa = path.join(tmpRoot, tag + '-a.bin'), fb = path.join(tmpRoot, tag + '-b.bin');
  fs.writeFileSync(fa, a); fs.writeFileSync(fb, b);
  const r = spawnSync('python3', ['-I', DIFF, '--common', fa, fb], { encoding: 'utf8' });
  fs.rmSync(fa, { force: true }); fs.rmSync(fb, { force: true });
  return { ok: r.status === 0, text: (r.stdout + r.stderr).trim().split('\n')[0] };
}
function firstTic(buf) { return buf && buf.length >= REC ? buf.readUInt32LE(0) : 0; }
function records(buf) { return buf ? Math.floor(buf.length / REC) : 0; }
// How many distinct P_Random states and world states the file has: a game that was not idle.
function activity(buf) {
  const rand = new Set(), world = new Set();
  for (let i = 0; i + REC <= buf.length; i += REC) { rand.add(buf.readUInt32LE(i + 8)); world.add(buf.readUInt32LE(i + 20)); }
  return { rand: rand.size, world: world.size };
}

// The numbers of the "vnet: closed" and "vnet: polls" lines of a game's output.
function closedStats(text) {
  const c = /vnet: closed \(([^,]+), room ([A-Z2-9-]+)\): sent (\d+) datagrams \(impairment lost (\d+), duplicated (\d+), reordered (\d+);.*received (\d+);/.exec(text);
  const l = /largest datagram sent (\d+) bytes \(packet type (\d+)\)/.exec(text);
  const p = /vnet: polls: longest gap (\d+) ms \(game state (-?\d+) to (-?\d+)\); (\d+) gaps of 100 ms or more, (\d+) of 1 s, (\d+) of 5 s/.exec(text);
  return {
    transport: c ? c[1] : '', largest: l ? +l[1] : 0, largestType: l ? +l[2] : -1, sent: c ? +c[3] : 0, lost: c ? +c[4] : 0, dup: c ? +c[5] : 0, reordered: c ? +c[6] : 0, received: c ? +c[7] : 0,
    closed: !!c, gap: p ? +p[1] : -1, gapFrom: p ? +p[2] : -1, gapTo: p ? +p[3] : -1, gaps100: p ? +p[4] : -1, gaps1000: p ? +p[5] : -1, gaps5000: p ? +p[6] : -1,
  };
}

// ---- the scenarios --------------------------------------------------------------------------------------------
// machines: the host first; late: joins the game in progress (JOIN_AFTER seconds in).
// transport: what every page must log (wt: relay-wt, ws: relay-ws; a native player logs relay-udp).

const B = (extra) => Object.assign({ kind: 'browser' }, extra), N = (extra) => Object.assign({ kind: 'native' }, extra);
const SCENARIOS = {
  'ws': { desc: 'browser host, browser joiner at the start, WebSocket', transport: 'ws', machines: [B(), B()] },
  'wt': { desc: 'browser host, browser joiner at the start, WebTransport', transport: 'wt', machines: [B(), B()] },
  'browser-host-native': { desc: 'browser host, native joiner at the start, WebTransport', transport: 'wt', machines: [B(), N()] },
  'native-host': { desc: 'native host, browser joiner at the start, WebTransport', transport: 'wt', machines: [N(), B()] },
  'hot-join-browser': { desc: 'browser host and joiner, a second browser joins in progress, WebTransport', transport: 'wt', machines: [B(), B(), B({ late: true })] },
  'hot-join-native': { desc: 'native host, a browser joins in progress, WebTransport', transport: 'wt', machines: [N(), B({ late: true })] },
  'hot-join-into-browser': { desc: 'browser host, a native joins in progress, WebTransport', transport: 'wt', machines: [B(), N({ late: true })] },
  'impaired': { desc: 'browser host, browser, native (late), ' + IMPAIR + ', WebTransport', transport: 'wt', impair: IMPAIR, machines: [B(), B(), N({ late: true })] },
  'impaired-ws': { desc: 'the same over the WebSocket', transport: 'ws', impair: IMPAIR, machines: [B(), B(), N({ late: true })] },
  'bots': { desc: 'browser host with two bots, a browser joins in progress, WebTransport', transport: 'wt', bots: true, machines: [B(), B({ late: true })] },
};

// Plays one game of a scenario and checks it. run: 1, 2, ... (the seeds).
async function playGame(name, sc, run) {
  const e = await env();
  const t0 = now();
  console.log(`== ${name} run ${run}: ${sc.desc}`);
  const relay = await startRelay(e.origin);
  const machines = [];
  const labels = ['host', 'A', 'B'];
  const startAt = {};
  try {
    const startersAtStart = sc.machines.filter((d) => !d.late).length;
    const spec = (i) => (sc.impair ? sc.impair + ',seed=' + (run * 10 + i + 1) : '');
    const make = async (i, code) => {
      const d = sc.machines[i];
      const mname = `${name}-${run}-${labels[i]}`;
      const args = [];
      if (i === 0) {
        args.push('-server', String(startersAtStart), '-warp', '1', '1');
        if (sc.bots) { args.push('+botgen', '1', '+botrandseed', '136', '-testaddbots', '10', '2'); }
      } else { args.push('-connect', code); }
      const o = { relay, transport: sc.transport, args, impair: spec(i) };
      const m = d.kind === 'browser' ? await startBrowser(mname, o) : startNative(mname, o);
      m.label = labels[i]; m.late = !!d.late;
      machines.push(m);
      startAt[i] = now();
      return m;
    };
    const host = await make(0);
    if (host.startError) { check(false, 'the host started', host.startError); return; }
    const code = await waitFor(() => roomCode(host), 60000);
    if (!check(!!code, 'the host printed a room code within 60 s', host.text().split('\n').slice(-4).join(' | '))) { return; }
    console.log(`  room ${code} on relay ${relay.udp}`);
    for (let i = 1; i < sc.machines.length; i++) {
      if (sc.machines[i].late) { continue; }
      const m = await make(i, code);
      if (m.startError) { check(false, labels[i] + ' started', m.startError); return; }
    }
    const lateIdx = sc.machines.map((d, i) => (d.late ? i : -1)).filter((i) => i > 0);
    if (lateIdx.length) {
      // let the game run: the host JOIN_AFTER seconds in, every player that joined at the start with it
      const early = machines.slice();
      const ok = await waitFor(async () => {
        for (const m of early) { if (!(await m.alive())) { return true; } }
        if ((await host.dumpTics()) <= JOIN_AFTER * TICRATE) { return false; }
        for (const m of early) { if ((await m.dumpTics()) <= TICRATE) { return false; } }
        return true;
      }, 90000);
      let allAlive = true;
      for (const m of early) { if (!(await m.alive())) { allAlive = false; } }
      if (!check(!!ok && allAlive, 'the game was running when the late joiner was due', early.map((m) => m.label).join(',') )) { return; }
      console.log(`  the late joiner comes at host tic about ${await host.dumpTics()}`);
      for (const i of lateIdx) {
        const m = await make(i, code);
        if (m.startError) { check(false, labels[i] + ' started', m.startError); return; }
      }
    }
    // play until the last machine has PLAY seconds of game time
    const last = machines[machines.length - 1];
    const need = PLAY * TICRATE;
    await waitFor(async () => {
      for (const m of machines) { if (!(await m.alive())) { return true; } }
      return (await last.dumpTics()) >= need;
    }, (PLAY + 120) * 1000);
    await sleep(500);
    const alive = [];
    for (const m of machines) { alive.push(await m.alive()); }
    // snapshot every file at one moment, then leave (joiners first)
    const dumps = [];
    for (const m of machines) { dumps.push(await m.dump()); }
    if (SABOTAGE === 'flip' && dumps[dumps.length - 1]) { const d = Buffer.from(dumps[dumps.length - 1]); d[Math.floor(d.length / 2 / REC) * REC + 9] ^= 0x40; dumps[dumps.length - 1] = d; }
    if (SABOTAGE === 'short' && dumps[dumps.length - 1]) { dumps[dumps.length - 1] = dumps[dumps.length - 1].subarray(0, Math.floor(dumps[dumps.length - 1].length / 2 / REC) * REC); }
    for (const m of machines.slice().reverse()) {
      await m.quit();
      await m.waitEnd(25000);
    }
    await sleep(300);
    await relay.stop();
    const secs = Math.round((now() - t0) / 1000);

    // ---- the checks
    check(alive.every(Boolean), 'every machine was still running at the end', machines.map((m, i) => m.label + (alive[i] ? '' : ' (stopped)')).join(', '));
    const recs = dumps.map(records);
    console.log('  records: ' + machines.map((m, i) => `${m.label} ${recs[i]}`).join(', '));
    const codes = machines.filter((m) => new RegExp(`vnet: (room code|joined room) ${code} `).test(m.text())).length;
    check(codes === machines.length, `all ${machines.length} machines logged the room code ${code}`, `${codes} did`);
    for (const m of machines) {
      const want = m.kind === 'native' ? 'relay-udp' : sc.transport === 'wt' ? 'relay-wt' : 'relay-ws';
      const got = (/vnet: transport (\S+)/.exec(m.text()) || [])[1];
      check(got === want, `${m.label} (${m.kind}) logged the transport ${want}`, `it logged ${got}`);
    }
    const lastRec = recs[machines.length - 1];
    check(lastRec >= need, `the last machine has at least ${PLAY} s of game time (${lastRec} >= ${need})`);
    machines.forEach((m, i) => {
      if (m.late) {
        const ft = firstTic(dumps[i]);
        check(ft > 100, `${m.label} joined in progress (its first record is tic ${ft})`);
      }
    });
    for (let i = 1; i < machines.length; i++) {
      if (!dumps[0] || !dumps[i]) { check(false, `${machines[i].label}: a dump file to compare`, 'missing'); continue; }
      const r = compareDumps(dumps[0], dumps[i], `${name}-${run}-${i}`);
      console.log(`  compare host and ${machines[i].label}: ${r.text}`);
      check(r.ok, `host and ${machines[i].label}: every tic both files have is identical`, r.text);
    }
    if (dumps[machines.length - 1]) {
      const act = activity(dumps[machines.length - 1]);
      check(act.rand >= 20 && act.world >= 3, `the game was not idle (${act.rand} P_Random states, ${act.world} world states)`);
    }
    const bad = machines.filter((m) => FAULTS.test(m.text()));
    check(bad.length === 0, 'no consistency fault, repair, kick, vnet failure or page error in any log',
      bad.map((m) => m.label + ': ' + (FAULTS.exec(m.text()) || [''])[0]).join('; '));
    for (const m of machines) {
      if (m.kind !== 'browser') { continue; }
      const ec = await m.exitCode();
      check(ec === 0 && m.errors.length === 0, `${m.label}'s page: the game exited with status 0 and the page saw no error`, `status ${ec} ${m.errors.join('; ')}`);
    }
    console.log('  largest datagram sent: ' + machines.map((m) => `${m.label} ${closedStats(m.text()).largest} bytes (type ${closedStats(m.text()).largestType})`).join(', '));
    check(machines.every((m) => { const c = closedStats(m.text()); return c.largest > 0 && c.largest <= 1100; }), 'no datagram over the 1,100 bytes vnet carries, and none refused for its size');
    // polling: the longest stretch without a call into vnet must stay well under the relay's keepalive (5 s)
    const stats = machines.map((m) => closedStats(m.text()));
    console.log('  polls: ' + machines.map((m, i) => `${m.label} longest gap ${stats[i].gap} ms (state ${stats[i].gapFrom} to ${stats[i].gapTo}), ${stats[i].gaps100} gaps over 100 ms, ${stats[i].gaps1000} over 1 s`).join('; '));
    check(machines.every((m, i) => stats[i].closed && stats[i].gap >= 0 && stats[i].gap < GAPMAX), `every machine left the room and polled vnet at least every ${GAPMAX / 1000} s (the relay's keepalive is 5 s)`,
      machines.map((m, i) => `${m.label} ${stats[i].closed ? stats[i].gap + ' ms' : 'no "vnet: closed" line'}`).join(', '));
    if (sc.impair) {
      let named = 0, lost = 0, dup = 0, reo = 0;
      machines.forEach((m, i) => {
        if (m.text().includes(`vnet: impairment from VNET_IMPAIR="${sc.impair},seed=`)) { named++; }
        lost += stats[i].lost; dup += stats[i].dup; reo += stats[i].reordered;
      });
      console.log(`  impairment applied (${sc.impair}): ${lost} lost, ${dup} duplicated, ${reo} reordered (all machines together)`);
      check(named === machines.length, `vnet took the impairment from VNET_IMPAIR on every machine (${named} of ${machines.length})`);
      check(lost > 0 && dup > 0 && reo > 0, `datagrams were lost, duplicated and reordered (${lost}, ${dup}, ${reo})`);
    }
    if (sc.bots) {
      for (const m of machines) { check(/TEST: bots in game: 2 /.test(m.text()), `${m.label}: the log says there were 2 bots in the game`); }
    }
    console.log(`  ${name} run ${run}: ${secs} s`);
  } finally {
    await killAll();
    await relay.stop();
  }
}

// ---- errors (brief 04 section 5) ---------------------------------------------------------------------------------
// Each case: what is done, then within a bound (seconds from the trigger) the page shows the failure (window.dlNet and the
// bar under the picture), is not left on "connecting", and the game is at its title screen (still running, still writing its
// dump) or, for a bad argument, has ended with the message on the overlay.

// True while the machine's dump file grows over 1.5 s: the game is running (at the title screen, after a failed network game).
async function growing(m) {
  const a = await m.dumpTics();
  return !!(await waitFor(async () => (await m.dumpTics()) > a, 6000));
}

// What the page shows: { kind, text, shown } (the sabotage reads nothing).
async function pageNet(m) {
  if (SABOTAGE === 'noerrpage') { return { kind: 0, text: '', shown: false, bar: '' }; }
  return m.net();
}

// Waits until the page shows a failed network game (kind 3); returns the seconds it took from t0, or -1.
async function waitFailed(m, t0, boundSecs) {
  const ok = await waitFor(async () => { const n = await pageNet(m); return n && n.kind === 3; }, (boundSecs + 5) * 1000);
  return ok ? (now() - t0) / 1000 : -1;
}

async function checkFailure(label, m, t0, bound, textRe) {
  const secs = await waitFailed(m, t0, bound);
  const n = await pageNet(m);
  check(secs >= 0 && secs <= bound, `${label}: the page shows the failure within ${bound} s (${secs >= 0 ? secs.toFixed(1) + ' s' : 'never'})`, n && n.text);
  check(!!n && n.kind === 3 && n.shown && textRe.test(n.bar), `${label}: the bar under the picture says why ("${(n && n.bar || '').replace(/\n/g, ' ').slice(0, 110)}")`, `expected ${textRe}`);
  check(!!n && !/Creating a room|Joining a room/.test(n.bar), `${label}: no stale "connecting" state`);
  check((await m.state()) === 'running', `${label}: the game is still running (at the title screen), not stuck on a dead page`, await m.state());
  check(await growing(m), `${label}: the game goes on at the title screen (its dump keeps growing)`);
  console.log(`  ${label}: ${secs >= 0 ? secs.toFixed(1) : 'never'} s`);
}

// The game ends at once with the message on the overlay (a bad argument): state error, status text.
async function checkRefused(label, m, textRe, boundSecs) {
  const t0 = now();
  const st = await m.waitEnd((boundSecs || 15) * 1000);
  const text = await m.status();
  check(st === 'error' || st === 'ended', `${label}: the page ends within ${boundSecs || 15} s (${((now() - t0) / 1000).toFixed(1)} s, ${st})`);
  check(textRe.test(text), `${label}: the overlay says why ("${text.replace(/\n/g, ' ').slice(0, 130)}")`, `expected ${textRe}`);
  check((await m.exitCode()) !== 0, `${label}: the game's exit status is not 0 (${await m.exitCode()})`);
}

async function errorsScenario() {
  const e = await env();
  const dead = { ws: 'ws://127.0.0.1:1/vnet', wt: '', cert: '', udp: '127.0.0.1:1' };
  const base = ['-warp', '1', '1'];

  console.log('== errors: the relay is not listening (a game creates a room)');
  {
    const m = await startBrowser('err-unreach', { relay: dead, transport: 'ws', args: ['-server', '1'].concat(base) });
    const t0 = now();
    const seenConnecting = await waitFor(async () => { const n = await pageNet(m); return n && n.kind === 1; }, 8000);
    check(!!seenConnecting || SABOTAGE === 'noerrpage', 'the page showed "connecting" first');
    await checkFailure('relay not listening', m, t0, 20, /cannot create a room on relay ws:\/\/127\.0\.0\.1:1\/vnet/);
    await m.kill();
  }

  console.log('== errors: no such room');
  {
    const relay = await startRelay(e.origin);
    const m = await startBrowser('err-noroom', { relay, transport: 'ws', args: ['-connect', 'ZZZZZZ'] });
    await checkFailure('no such room', m, now(), 10, /cannot join room ZZZZZZ.*no room with that code|no such room|no room/i);
    await m.kill(); await relay.stop();
  }

  console.log('== errors: the room is full (the relay allows 2 members)');
  {
    const relay = await startRelay(e.origin, ['-max-members', '2']);
    const host = await startBrowser('err-full-host', { relay, transport: 'ws', args: ['-server', '2'].concat(base) });
    const code = await waitFor(() => roomCode(host), 60000);
    const a = await startBrowser('err-full-a', { relay, transport: 'ws', args: ['-connect', code] });
    await waitFor(async () => (await a.dumpTics()) > 35, 60000);
    const b = await startBrowser('err-full-b', { relay, transport: 'ws', args: ['-connect', code] });
    await checkFailure('room full', b, now(), 10, /room.*full|full/i);
    check((await host.alive()) && (await a.alive()), 'room full: the two players already in the room were not disturbed');
    await b.kill(); await a.kill(); await host.kill(); await relay.stop();
  }

  console.log('== errors: the relay is lost during a game (killed; it was started with -keepalive 1s)');
  {
    const relay = await startRelay(e.origin, ['-keepalive', '1s']);
    const host = await startBrowser('err-rl-host', { relay, transport: 'ws', args: ['-server', '2'].concat(base) });
    const code = await waitFor(() => roomCode(host), 60000);
    const a = await startBrowser('err-rl-a', { relay, transport: 'ws', args: ['-connect', code] });
    await waitFor(async () => (await a.dumpTics()) > 5 * TICRATE && (await host.dumpTics()) > 5 * TICRATE, 60000);
    const t0 = now();
    try { process.kill(-relay.child.pid, 'SIGKILL'); } catch (err) { /* gone */ }
    await checkFailure('relay killed (host)', host, t0, 15, /relay session ended/);
    await checkFailure('relay killed (joiner)', a, t0, 15, /relay session ended/);
    await a.kill(); await host.kill(); await relay.stop();
  }

  console.log('== errors: the relay drops a member (-session-timeout 3s; the page is frozen for 6 s)');
  {
    const relay = await startRelay(e.origin, ['-keepalive', '1s', '-session-timeout', '3s']);
    const host = await startBrowser('err-rd-host', { relay, transport: 'ws', args: ['-server', '2'].concat(base) });
    const code = await waitFor(() => roomCode(host), 60000);
    const a = await startBrowser('err-rd-a', { relay, transport: 'ws', args: ['-connect', code] });
    await waitFor(async () => (await a.dumpTics()) > 5 * TICRATE && (await host.dumpTics()) > 5 * TICRATE, 60000);
    // block the joiner's main thread: no polls, no keepalives
    const freeze = a.page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 6000) { /* frozen */ } }).catch(() => {});
    await freeze;
    const t0 = now();
    await checkFailure('member dropped by the relay', a, t0, 10, /relay session ended/);
    await a.kill(); await host.kill(); await relay.stop();
  }

  console.log('== errors: the host is gone during a game (its page is closed)');
  {
    const relay = await startRelay(e.origin);
    const host = await startBrowser('err-hg-host', { relay, transport: 'ws', args: ['-server', '2'].concat(base) });
    const code = await waitFor(() => roomCode(host), 60000);
    const a = await startBrowser('err-hg-a', { relay, transport: 'ws', args: ['-connect', code] });
    await waitFor(async () => (await a.dumpTics()) > 5 * TICRATE && (await host.dumpTics()) > 5 * TICRATE, 60000);
    const t0 = now();
    await host.kill();
    await checkFailure('host gone', a, t0, 30, /Server (Timeout|has Shutdown)/);
    await a.kill(); await relay.stop();
  }

  console.log('== errors: -relay is not a valid URL (the game refuses it; the page shows the message)');
  const bad = [
    ['ws://', /-relay ws:\/\/: it has no host name/],
    ['127.0.0.1:7777', /-relay 127\.0\.0\.1:7777: it does not start with ws:\/\/ or wss:\/\//],
    ['http://127.0.0.1/vnet', /does not start with ws:\/\/ or wss:\/\//],
    ['ws://127.0.0.1:99999/vnet', /the port is not a number from 1 to 65535/],
    ['ws://127.0.0.1:8080', /it has no path/],
    ['ws://a b/vnet', /space or a control character/],
    ['ws://' + 'h'.repeat(200) + '/vnet', /characters long \(at most 159\)/],
  ];
  for (const [value, re] of bad) {
    const m = await startBrowser('err-badurl', { relay: dead, transport: 'ws', args: ['-server', '1'], query: { relay: value, relayraw: '1' } });
    await checkRefused(`-relay ${value.length > 40 ? value.slice(0, 20) + '...' : value}`, m, re);
    await m.kill();
  }
  {
    const m = await startBrowser('err-norelay', { relay: dead, transport: 'ws', args: ['-relay', 'ws://127.0.0.1:1/vnet', '-server', '1'], query: { relay: '' } });
    await checkRefused('-relay on a page with no relay configured', m, /this page has no relay configured/);
    await m.kill();
  }
  {
    // no -relay at all: a network game needs one in the browser
    const m = await startBrowser('err-nonet', { relay: dead, transport: 'ws', args: ['-server', '2'], query: { relay: '' } });
    await checkRefused('-server on a page with no relay', m, /relay|network/i);
    await m.kill();
  }
}

// ---- knobs (brief 04 section 3 and AC7) ---------------------------------------------------------------------------

async function knobsScenario() {
  const e = await env();
  const relay = await startRelay(e.origin);
  console.log('== knobs: the address bar has no effect without ?test=1');
  {
    const ctx = await e.browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await ctx.newPage();
    const lines = [];
    page.on('console', (msg) => lines.push(msg.text()));
    const q = new URLSearchParams({ relay: relay.ws, relay_wt: relay.wt, relay_cert: relay.cert, impair: 'loss=50', relayraw: '1',
      args: JSON.stringify(['-server', '1', '-warp', '1', '1', '-testdump', 'k.bin']), iwad: '/freedoom1.wad', persist: '0', home: '/work' });
    await page.goto(e.base + '?' + q);
    await L.waitState(page, ['ready', 'nodata', 'error'], 60000);
    check((await page.evaluate(() => window.dlState)) === 'ready', 'a page without ?test=1 loads and offers the game', await page.evaluate(() => window.dlState));
    check(await page.evaluate(() => typeof window.dlTest === 'undefined'), 'it has no test hooks (window.dlTest)');
    await page.click('#start');
    await sleep(6000);
    const r = await page.evaluate(() => ({ state: window.dlState, env: Object.keys(window.Module.ENV || {}).filter((k) => /^(DL_|VNET)/.test(k)), net: window.dlNet.kind }));
    const text = lines.join('\n');
    check(r.env.length === 0, 'the game was given none of DL_RELAY, DL_RELAY_WT, DL_RELAY_CERT and VNET_IMPAIR', r.env.join(','));
    check(!/vnet:/.test(text), 'the game printed nothing about vnet: no relay, no room, no -relay (its arguments are the page\'s own)');
    check(!/relay-ws|relay-wt|room code/.test(text) && r.net === 0, 'no network game, nothing shown about one');
    check(!/room/i.test(relay.log().replace(/LISTEN.*/, '')) , 'the relay saw no room and no member', relay.log().split('\n').slice(-3).join(' | '));
    check(r.state === 'running', 'the game runs single player (the page does not stop at the unknown arguments)', r.state);
    await ctx.close();
  }

  console.log('== knobs: a page whose config.js names a relay offers it; the address bar cannot change it');
  {
    const cfg = path.join(tmpRoot, 'config-relay.js');
    fs.writeFileSync(cfg, fs.readFileSync(path.join(L.BUILD, 'config.js'), 'utf8').replace("relay: ''", "relay: '" + relay.ws + "'"));
    const server2 = await serve(L.BUILD, { '/config.js': cfg }, 0);
    const base2 = `http://127.0.0.1:${server2.address().port}/index.html`;
    const ctx = await e.browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await ctx.newPage();
    const lines = [];
    page.on('console', (msg) => lines.push(msg.text()));
    await page.goto(base2 + '?' + new URLSearchParams({ relay: 'ws://127.0.0.1:2/vnet', relay_wt: 'https://127.0.0.1:2/vnet', iwad: '/freedoom1.wad', persist: '0', home: '/work' }));
    await L.waitState(page, ['ready', 'nodata', 'error'], 60000);
    await page.click('#start');
    await sleep(5000);
    const r = await page.evaluate(() => ({ state: window.dlState, relay: window.Module.ENV.DL_RELAY, wt: window.Module.ENV.DL_RELAY_WT }));
    check(r.relay === relay.ws, `the game was given config.js's relay (not the address bar's): ${r.relay}`);
    check(r.wt === undefined, 'the address bar\'s WebTransport address was not passed on');
    check(/vnet: relay .* selected; use -server/.test(lines.join('\n')), 'the game took -relay and waits for -server or -connect (no game started)');
    check(r.state === 'running', 'the game runs single player');
    await ctx.close();
    await new Promise((r2) => server2.close(r2));
  }

  console.log('== knobs: with ?test=1 they act, and a bad value is refused with a message');
  {
    const good = await startBrowser('knob-good', { relay, transport: 'wt', args: ['-server', '1', '-warp', '1', '1'], impair: 'lat=5,seed=3' });
    const ok = await waitFor(() => /vnet: transport relay-wt/.test(good.text()), 30000);
    check(!!ok, 'on a test page relay, relay_wt and relay_cert took effect: the game logs relay-wt');
    check(/vnet: impairment from VNET_IMPAIR="lat=5,seed=3"/.test(good.text()), 'and impair reached vnet (it says so)');
    await good.kill();
    const cases = [
      ['relay_wt', 'http://127.0.0.1:1/vnet', /relay_wt= is not valid/],
      ['relay_wt', 'https://' + 'x'.repeat(200), /relay_wt= is 208 characters long \(at most 190\)/],
      ['relay_cert', 'abcd', /relay_cert= is not valid/],
      ['relay_cert', 'z'.repeat(64), /relay_cert= is not valid/],
      ['impair', 'loss=3;drop table', /impair= is not valid/],
      ['impair', 'loss=' + '1'.repeat(130), /impair= is 135 characters long \(at most 120\)/],
      ['relay', 'ws://', /relay= is not valid/],
      ['relay', 'ws://127.0.0.1:1/vnet' + 'x'.repeat(200), /relay= is 221 characters long \(at most 150\)/],
    ];
    for (const [k, v, re] of cases) {
      const ctx = await e.browser.newContext();
      const page = await ctx.newPage();
      const q = new URLSearchParams({ test: '1', persist: '0', home: '/work', raw: '1', iwad: '/freedoom1.wad', relay: relay.ws, args: '-server 1' });
      q.set(k, v);
      await page.goto(e.base + '?' + q);
      await L.waitState(page, ['ready', 'nodata', 'error'], 30000);
      const st = await page.evaluate(() => ({ state: window.dlState, text: document.getElementById('status').textContent, starts: window.dlStarts }));
      check(st.state === 'error' && re.test(st.text) && st.starts === 0, `${k}=${v.length > 30 ? v.slice(0, 20) + '...(' + v.length + ')' : v}: refused with a message, the game did not start`, `${st.state} ${st.text}`);
      await ctx.close();
    }
    // the game's own checks (the page's passed on as they are: relayraw)
    const gcases = [
      ['relay_wt', 'http://127.0.0.1:1/vnet', /the WebTransport address must be https/],
      ['relay_cert', 'abcd', /the relay certificate hash must be 64 hex digits, it is 4 characters/],
      ['impair', 'loss=3;drop', /the impairment spec "loss=3;drop" is not valid/],
    ];
    for (const [k, v, re] of gcases) {
      const m = await startBrowser('knob-raw', { relay, transport: 'ws', args: ['-server', '1'], query: { [k]: v, relayraw: '1' } });
      await checkRefused(`the game refuses ${k}=${v}`, m, re);
      await m.kill();
    }
  }
  await relay.stop();
}

// ---- connect-spin (brief 04 section 4, AC8) ------------------------------------------------------------------------
// A joiner waits in CL_ConnectToServer for a host that does not answer (a native host stopped with SIGSTOP right after it
// printed its room code). -testconnectpasses makes the loop print its passes a second.

function connectPasses(text) {
  const out = [];
  const re = /TEST: connect passes: (\d+) in (\d+) tics \((\d+) a second\)/g;
  let r;
  while ((r = re.exec(text))) { out.push(+r[3]); }
  return out;
}

async function spinScenario() {
  const e = await env();
  const relay = await startRelay(e.origin);
  console.log('== connect-spin: a joiner waits for a host that does not answer');
  const host = startNative('spin-host', { relay, args: ['-server', '1', '-warp', '1', '1'] });
  const code = await waitFor(() => roomCode(host), 30000);
  check(!!code, 'the native host printed a room code');
  await sleep(1500);
  process.kill(host.child.pid, 'SIGSTOP');
  const j = await startBrowser('spin-joiner', { relay, transport: 'ws', args: ['-connect', code, '-testconnectpasses'] });
  await waitFor(() => /vnet: joined room/.test(j.text()), 30000);
  await sleep(10000);
  const rates = connectPasses(j.text());
  const st = await j.state();
  console.log(`  connect loop passes a second, every 2 s: ${rates.join(', ')}`);
  const steady = rates.slice(1);       // the first window includes the start
  const worst = steady.length ? Math.max.apply(null, steady) : -1;
  check(steady.length >= 3, `the loop reported its passes (${steady.length} windows)`);
  check(worst >= 0 && worst <= 1000, `the waiting joiner's loop runs at most 1,000 passes a second (most: ${worst})`);
  check(st === 'running', 'the joiner waits in the connect loop (still running)', st);
  // Escape: the connect loop answers it
  const t0 = now();
  await j.page.keyboard.down('Escape');
  await sleep(200);
  await j.page.keyboard.up('Escape');
  const left = await waitFor(() => /vnet: closed/.test(j.text()), 5000);
  const secs = (now() - t0) / 1000;
  check(!!left && secs <= 3, `Escape ends the connect loop: the game left the room ${secs.toFixed(1)} s later`);
  check((await j.state()) === 'running' && (await growing(j)), 'and goes on at the title screen');
  process.kill(host.child.pid, 'SIGCONT');
  await j.kill(); await host.kill(); await relay.stop();

  // The same joiner against a host that answers, with a savegame to download: how long the join takes.
  console.log('== connect-spin: a join in progress with a savegame to download (how long the join takes)');
  const times = [];
  for (let r = 1; r <= JOIN_RUNS; r++) {
    const relay2 = await startRelay(e.origin);
    const h = startNative('spin2-host', { relay: relay2, args: ['-server', '1', '-warp', '1', '1', '+botgen', '1', '+botrandseed', '136', '-testaddbots', '10', '6'] });
    const code2 = await waitFor(() => roomCode(h), 30000);
    await waitFor(async () => (await h.dumpTics()) > 25 * TICRATE, 60000);
    const t1 = now();
    const jj = await startBrowser('spin2-joiner', { relay: relay2, transport: 'ws', args: ['-connect', code2, '-testconnectpasses'] });
    const joined = await waitFor(() => /vnet: joined room/.test(jj.text()), 30000);
    const tJoined = now();
    const got = await waitFor(async () => (await jj.dumpTics()) > 0, 60000);
    const tFirst = now();
    await sleep(3000);
    const same = (await jj.dumpTics()) > 40;
    times.push((tFirst - tJoined) / 1000);
    console.log(`  run ${r}: joined the room ${((tJoined - t1) / 1000).toFixed(1)} s after the start of the page; first record ${((tFirst - tJoined) / 1000).toFixed(2)} s after that; passes ${connectPasses(jj.text()).join(',')}`);
    check(!!joined && !!got && same, `run ${r}: the join in progress completed and the game runs`);
    await jj.quit(); await jj.waitEnd(15000);
    const hd = await h.kill();
    await jj.kill(); await relay2.stop();
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  console.log(`  join time (room entered to first record): ${times.map((t) => t.toFixed(2)).join(', ')} s, median ${med.toFixed(2)} s`);
  check(med <= 8, `the median join takes at most 8 s (${med.toFixed(2)} s)`);
}

// ---- main -------------------------------------------------------------------------------------------------------

const SPECIAL = {
  'errors': { desc: 'section 5: relay unreachable, no such room, room full, relay lost, member dropped, host gone, bad -relay', run: errorsScenario },
  'knobs': { desc: 'section 3: the address bar has no effect without ?test=1; the knobs act with it; bad values are refused', run: knobsScenario },
  'connect-spin': { desc: 'section 4: the passes a second of a waiting joiner, Escape, and the time of a join with a savegame', run: spinScenario },
};
const ALL = Object.assign({}, SCENARIOS, SPECIAL);

async function main() {
  const argv = process.argv.slice(2);
  let runs = 1;
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') {
      for (const k of Object.keys(ALL)) { console.log(k.padEnd(24) + ALL[k].desc); }
      return 0;
    } else if (argv[i] === '--runs') { runs = +argv[++i]; }
    else if (argv[i] === '-h' || argv[i] === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
    else { names.push(argv[i]); }
  }
  const todo = names.length ? names : Object.keys(ALL);
  for (const n of todo) { if (!ALL[n]) { console.error('unknown scenario ' + n + ' (--list)'); return 2; } }
  const t0 = now();
  try {
    for (const n of todo) {
      for (let r = 1; r <= runs; r++) {
        const s0 = now();
        if (SPECIAL[n]) { if (r === 1) { await SPECIAL[n].run(); } else { await SPECIAL[n].run(); } }
        else { await playGame(n, ALL[n], r); }
        console.log(`  (${n} run ${r} took ${Math.round((now() - s0) / 1000)} s)`);
      }
    }
  } finally {
    await killAll();
    await closeEnv();
  }
  console.log(`total ${Math.round((now() - t0) / 1000)} s`);
  return L.summary('netplay');
}

main().then((c) => process.exit(c), (e) => { console.error(e && e.stack || e); killAll().then(() => closeEnv()).then(() => process.exit(1)); });
