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
//   NETPLAY_SABOTAGE=name node tests/web/netplay.js ...   # a failure proof: see SABOTAGE below
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

// How long (seconds of game time) a game runs before a late joiner comes, and after the last join.
const JOIN_AFTER = +(process.env.NETPLAY_JOIN_AFTER || 10);
const PLAY = +(process.env.NETPLAY_PLAY || 30);
// The impairment of the impaired scenarios (every machine, its own seed): brief 04 §6.
const IMPAIR = 'lat=30,jit=10,loss=3,dup=2,reorder=3';

// What in a log is a fault: as tests/net/test-relay.sh, and what a page adds.
const FAULTS = /consistency (fault|failure)|desync|out of sync|Client repair|Report: gametic|Kick (node|player)|savegame failed|Can.t load the level|vnet: (cannot|the relay session ended|ending)|pageerror|Something went wrong|The game crashed|The game stopped with an error/i;

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
  if (o.transport === 'wt') { q.set('relay_wt', o.relay.wt); q.set('relay_cert', o.relay.cert); }
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
  const p = /vnet: polls: longest gap (\d+) ms \(game state (-?\d+) to (-?\d+)\); (\d+) gaps of 100 ms or more, (\d+) of 1 s, (\d+) of 5 s/.exec(text);
  return {
    transport: c ? c[1] : '', sent: c ? +c[3] : 0, lost: c ? +c[4] : 0, dup: c ? +c[5] : 0, reordered: c ? +c[6] : 0, received: c ? +c[7] : 0,
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
    // polling: the longest stretch without a call into vnet must stay well under the relay's keepalive (5 s)
    const stats = machines.map((m) => closedStats(m.text()));
    console.log('  polls: ' + machines.map((m, i) => `${m.label} longest gap ${stats[i].gap} ms (state ${stats[i].gapFrom} to ${stats[i].gapTo}), ${stats[i].gaps100} gaps over 100 ms, ${stats[i].gaps1000} over 1 s`).join('; '));
    check(machines.every((m, i) => stats[i].closed && stats[i].gap >= 0 && stats[i].gap < 5000), 'every machine left the room and polled vnet at least every 5 s (the keepalive)',
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

// ---- main -------------------------------------------------------------------------------------------------------

const ALL = Object.assign({}, SCENARIOS);

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
        await playGame(n, ALL[n], r);
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
