# 04: Browser netplay

## Goal

The browser build plays network games through a vnet relay. Over WebTransport, falling back to WebSocket (`VNET_BACKEND_RELAY_AUTO`, D3), it can:
- host a room, as the server (D4);
- join a room from the start of a game;
- join a game in progress (D2).

Browser and native players share rooms in every combination. Every machine plays the same game, tic for tic. A failure ends the network game the way it does natively, with the message visible on the page.

This brief puts the transport, play, the join and failures in the browser, all with visible tabs. **Hidden and slow tabs are brief 04b:**
- L59, a hidden tab runs about 1 tic a second;
- L29, L63 and L64, a joiner that is slow or far behind.

Room codes, invite links and a lobby are brief 05. Here a game is started with test arguments.

## Read first

- `README.md` (D2, D3, D4, D6), `building.md`, `bugs.md`:
  - L59 and L60;
  - L29, L63 and L64 (04b's, but they can show up here);
  - L32, L33 and L34;
  - L55 to L58, L61 and L62.
- `code-facts.md`:
  - §2 (the driver table), §3 (start-up), §4 (the join);
  - §6 (the blocking loops and where each yields in the browser);
  - §13 (the vnet driver: arguments, nodes, polling points, packet size, failure, what the host and client see).
- The Outcomes of [01](01-vnet-transport.md) (the native vnet driver and `test-relay.sh`), [02](02-emscripten-port.md) (the page, the yields, `run-wasm.js`, the test pacing `?test=1&fast=1`), [03](03-data-download.md) (the page's states and the `?test=1&raw=1` path) and [F4](F4-hot-join-lossy.md) (the join over a lossy link, `-testimpair`, the tests).
- vnet:
  - `ext/vnet/README.md`;
  - `ext/vnet/doco/integration.md` ("Emscripten", "Hidden browser tabs", "Vendoring without CMake": all of `src/*.c`, `-lwebsocket.js`);
  - `ext/vnet/include/vnet.h` (`vnet_config`: `relay`, `relay_wt`, `relay_cert_sha256`, `wake`);
  - `ext/vnet/relay/README.md` (`-http`, `-wt`, `-dev-cert`, `-origins`, `-session-timeout`, the `LISTEN` line).
- The reference port: `/home/user/jfsw-browser/doco/browser/04-browser-netplay.md` and its Outcome, read-only. It did the same for Shadow Warrior. Its `tests/web/netplay.js` shows how it ran several Chromium pages and native players against a local relay with WebSocket and WebTransport. That covers the certificate by hash from `-dev-cert` (no Chromium flags on loopback), `-origins` with the page's exact `host:port`, and the test-only knobs behind `?test=1`. jfSW is a different engine with a different netcode: take the method, not the code.
- `src/i_vnet.c`, `src/i_vnet.h`, `scripts/wasm.mk`, `src/sdl/i_web.c`, `src/i_web.h`, `web/page.js`, `web/config.js`, `tests/tools/run-wasm.js`, `tests/web/lib.js`, `tests/net/lib.sh`, `tests/net/test-relay.sh`.

## In scope

### 1. vnet in the wasm build

- Build `ext/vnet/src/*.c` into the wasm build and `i_vnet.c` with `USE_VNET`, the way `src/Makefile` does natively. Link `-lwebsocket.js`.
  - `relay_udp.c` and `udp.c` compile to stubs under Emscripten, and that is expected.
  - Keep `scripts/wasm.mk`'s flags stamp right, so changing the build forces a rebuild.
- In the browser, `-relay` takes the relay's WebSocket URL (`ws://` or `wss://HOST[:PORT]/vnet`). The native `HOST:PORT` form, and its refusal of a URL, stay as they are natively. Refuse a malformed value with a clear message, as natively.
- WebTransport:
  - vnet derives the WebTransport URL from a `wss://` relay URL.
  - Tests on `http://127.0.0.1` use `ws://`. They need an explicit WebTransport URL (`relay_wt`) and the relay's `-dev-cert` hash (`relay_cert_sha256`). These are test-only knobs (§3).
- **Where the relay URL comes from.** `web/config.js` gets a `relay` entry (empty by default: the page offers no netplay until someone sets it). The page passes it to the game.
  - Only a test page may take a relay from the address bar (`?test=1`), so a crafted link cannot send visitors to another relay.
  - Document the entry in `config.js`'s comments and in `data-hosting.md`, or a short new section of `building.md`. Brief 06 writes the deployment.
- The game logs which transport the session uses (vnet's `relay-wt` or `relay-ws`). The tests check that line.

### 2. Play in the browser

These must work, with every machine's `-testdump` file identical for every tic it has:
- a browser host (`-server`) with browser joiners and native joiners;
- a native host with browser joiners;
- joins at the start (`-server 2`);
- **a join in progress**: a browser joining a running game, the host browser or native, and a native player joining a browser host's game in progress.

Settle these and record them in `code-facts.md` §13:
- **Polling.** §13 lists where the game reaches `vn_get`. Check that every state reached in the browser (the connect loop, the savegame download, the wait for players, a level in play, the screen wipe, a level load) polls often enough for the relay's keepalive and silence limits.
- **The wake.** Decide whether this brief needs `vnet_config.wake`. With visible tabs, the frame-paced yields may be enough. If it is used, it only arranges a poll: it must not call vnet, which `integration.md` forbids. 04b will need it for hidden tabs, so say what you found.
- **The 1,100-byte limit** (§13) holds in the browser. Every packet type that the clean runs of 01 measured fits.

### 3. Test-only knobs (only with `?test=1`)

- The relay URL, the WebTransport URL, the `-dev-cert` hash, and an impairment spec for vnet. A browser has no environment, so `VNET_IMPAIR` does not reach it; e.g. `?impair=lat=30,jit=10,loss=3,dup=2,reorder=3,seed=N`.
- Follow 02's `?args=` and 03's hooks.
- Refuse an over-long or malformed value with a message.
- Without `?test=1` none of them has any effect. Show that in a test.

### 4. L60: the connect and repair loops spin between tics

`CL_ConnectToServer` (`d_clisrv.c:3273`, its once-per-tic block at `:3478`) and the repair download loop (its once-per-tic block at `:2790`) poll the network and go round again between tics without yielding. A joining tab burns a core.
- Give them a yield between tics in the browser, through `i_web.h` (`I_Web_Idle` or a new call), natively a no-op.
- Show the number of passes a second, before and after, from a browser joiner that waits in the connect loop (e.g. a join to a host that is slow to answer, or a long download).
- Make sure the connect still answers `Q`/`ESC`, and that a large savegame download is not slower than before.

### 5. Failures end visibly

Natively a vnet failure ends the network game and returns to the title screen with a `vnet: ...` message (`code-facts.md` §13, "Failure"). The browser does the same, and the message is visible on the page, not only in the game's console. Cases:
- the relay unreachable;
- no such room;
- the room full;
- the relay lost during a game (relay killed, or a short `-session-timeout`);
- the host gone during a game, which gives the game's "Server Timeout";
- `-relay` without a valid URL.

None leaves the page stuck, or on a stale "connecting" state.

### 6. Tests: `tests/web/netplay.js`

Several Chromium pages (one context each) and native players (`build/native`), against a local relay (`scripts/build-relay.sh`, started with `-udp`, `-http`, `-wt` and `-dev-cert` on loopback, `-origins` the page's `host:port`, free ports). Scenarios are run one at a time and listed with `--list`. Each compares every machine's `-testdump` file with the host's, as `test-relay.sh` does, for every tic both have, with at least 30 s after the last join. Each also checks that no log has a consistency fault, a repair or a kick.

| Scenario | Machines | Transport | Notes |
|---|---|---|---|
| `ws` | browser host, browser joiner at the start | WebSocket | |
| `wt` | the same | WebTransport | each page logs `relay-wt` |
| `browser-host-native` | browser host, native joiner at the start | WebTransport | |
| `native-host` | native host, browser joiner at the start | WebTransport | |
| `hot-join-browser` | browser host and joiner, a second browser joins in progress | WebTransport | |
| `hot-join-native` | native host, a browser joins in progress | WebTransport | |
| `hot-join-into-browser` | browser host, a native joins in progress | WebTransport | |
| `impaired` | three machines (browser host, browser, native; one joins in progress) | WebTransport | `lat=30,jit=10,loss=3,dup=2,reorder=3` on every machine, a seed each; at least 3 runs |
| `impaired-ws` | the same | WebSocket | at least 3 runs |
| `bots` | browser host with two bots (`-testaddbots`), a browser joins in progress | WebTransport | |
| `errors` | §5's cases | — | each ends with the message on the page and the game at the title screen, within a bound |
| `knobs` | — | — | §3's knobs have no effect without `?test=1` |
| `connect-spin` | — | — | §4's measurement |

The browser runs at normal pace: not `fast=1`, since lockstep runs in real time.

## Out of scope

- Hidden and throttled tabs (L59), a frozen tab, a slow joiner (L29, L63, L64): brief 04b. Record anything found that bears on them.
- Lag and pacing measurements: later, if the play-test asks for them.
- A lobby, room codes on screen, an invite link, menu entries: brief 05.
- The deployment, real certificates, Apache: brief 06.
- Music (M1).
- Changing vnet (`ext/vnet` is read-only).

## Acceptance criteria

1. **AC1, the build.**
   - The wasm build links vnet; a fresh clone with an empty `EM_CACHE` builds it.
   - The native build and every native test are unchanged.
   - `demo-hash.sh` is 11 of 11 (native against wasm), and the browser tests of 02 and 03 pass.
2. **AC2, play** (`ws`, `wt`, `browser-host-native`, `native-host`): each passes 3 runs out of 3, with the files identical and each transport the one asked for.
3. **AC3, a join in progress** (`hot-join-browser`, `hot-join-native`, `hot-join-into-browser`): each passes 3 runs out of 3.
   - If a browser join fails for L29, L63 or L64 even at normal speed, stop and report: whether it is fixed here or in 04b is the coordinator's call.
4. **AC4, impairment** (`impaired`, `impaired-ws`): 3 of 3 each, at the full spec.
5. **AC5, bots** (`bots`): 3 of 3.
6. **AC6, failures** (`errors`): every case of §5 ends as described, within a stated bound.
7. **AC7, test-only knobs** (`knobs`): the relay URL and the other knobs act only with `?test=1`. Without a `relay` in `config.js` the page offers no netplay, and the game refuses `-relay` with a message.
8. **AC8, L60** (`connect-spin`): the passes a second of a waiting joiner before and after, and the connect still answers `Q` or `ESC`.
9. **AC9, failure proofs:** each new test fails when its change is reverted (the knobs' gate, the spin's yield, the transport check, etc.): show each, then restore. A check of the dump comparison itself, e.g. a page whose dump is truncated or altered on purpose, shows it would see a difference. No test is loosened.
10. **AC10, nothing else breaks:**
    - every test in `tests/`, as `building.md` lists them, one multi-process test at a time;
    - the six browser tests;
    - `asan-demos.sh` with no new site.

## Dependencies

01, 02, 03, F4 (all merged). Brief 04b follows; then 05.

## Notes

- Git: the branch `browser/04-browser-netplay`, from `claudeai`. Push after each commit. Never merge, never touch `claudeai` or `main`, never open a pull request, never force-push.
- The machine has 4 cores. A browser page uses at least one core, and a native game one. Run one multi-process scenario at a time, and say how long each takes. Three machines and a relay is the most a scenario should run.
- Never commit game data or built binaries. The relay binary lives in `build/`.
- Chromium and Playwright are preinstalled: never run `playwright install`.
- Upstream-style, small changes in the engine: `#ifdef __EMSCRIPTEN__` or new files, no reformatting (D11).
- Estimate: about half of brief 01.

## Outcome

Status: **done by the implementer, 28 Nov 2026 (review pending)**. Branch `browser/04-browser-netplay`, commits `9d16b0d`, `44647c9`, `bf0da7b`, `9ab1de8`, `1eca701`, `c0ddd89` and the docs commit after it, all pushed; nothing merged, no pull request. Not tested: a person playing, a hidden tab, Firefox or Safari, a real certificate, a repair download in a browser (needs a consistency fault).

**What changed**

- *Build.* `scripts/wasm.mk` builds `ext/vnet/src/*.c` (vnet's flags) and `i_vnet.c` with `-DUSE_VNET`, links `-lwebsocket.js`; `flags.stamp` has `VNET=`. 25 s from scratch with an empty cache; `doomlegacy.wasm` 2.85 MB. Native: 11 warnings, as before.
- *`i_vnet.c`.* In the browser `-relay` is a `ws://`/`wss://` URL (validated, each fault named; no host lookup); the transport is logged (`vnet: transport relay-wt|relay-ws|relay-udp`); the test knobs `DL_RELAY_WT`, `DL_RELAY_CERT` and `VNET_IMPAIR` come from the environment (checked again by the game); the driver measures the gaps between its polls and prints them on leaving the room; it tells the page what the network game is doing (`I_Web_NetStatus`). `d_clisrv.c`: the two handlers that show "Server Timeout" and "Server has Shutdown" do the same; `I_Web_Idle` in the connect and repair loops (L60). `i_tcp.c`: a network game with no relay is refused in the browser (L69). `test_dump.c`: `-testconnectpasses`, and the page can ask the game to quit.
- *The page.* `config.js` has `relay`; only a `?test=1` page takes `relay=`, `relay_wt=`, `relay_cert=`, `impair=` from the address; a line under the picture shows the network state and why a game ended (`window.dlNet`). `data-hosting.md` says what the relay needs.
- *Tests.* `tests/web/netplay.js` (13 scenarios, `building.md` §12).

**Acceptance criteria**

| AC | Result |
|---|---|
| 1 build | the wasm build links vnet; with `EM_CACHE=/tmp/em-cache-clean` seeded by `scripts/setup-emsdk.sh --with-ports` and an empty build directory, `scripts/build-wasm.sh BUILD=/tmp/wasm-clean` builds with no download in 32 s (`doomlegacy.wasm` 2.85 MB); with the cache warm, 24 to 25 s. Native build and tests unchanged: `demo-hash.sh` **11 of 11** (289 s), `test-relay.sh` clean and impaired, `--bots`, `--dedicated`, `test-relay-errors.sh`, `test-hot-join.sh`, `pause-order`, `servertic-sections`, `test-drone`, `test-two-joiners`, `draw-independence`, `sprite-column-oob`, `bots-native-wasm`, `savegame-malformed`, `savegame-f3`, `savegame-old` (12 of 12, after test_dump.c was made to compile in the old build again), `savegame-portable` (117 passed, 576 s) all pass. Browser tests: `smoke` 36/0, `persist` 12/0, `exits` 18/0, `data` 159/0, `iwad-table` 40/0, `demo-page` 11/0 (**once 10/1**: the 100 ms stall check, "largest 177 ms", run straight after other work; it passed on the re-run). **Exception: `test-hot-join.sh --lossy loss=3,dup=2,reorder=3` fails at its default seed 1 (4 of 5 with seeds 1 to 5), also on a build of `ba8a7a5`, before this brief: `bugs.md` L70.** |
| 2 play | `ws`, `wt`, `browser-host-native`, `native-host`: **3 of 3 each**, files identical (1,070 to 1,078 records), each transport the one asked for (34 to 41 s a game). |
| 3 join in progress | `hot-join-browser`, `hot-join-native`, `hot-join-into-browser`: **3 of 3 each** (45 to 47 s). No case of L29, L63 or L64: a joiner in a page at normal pace loaded the savegame in about 0.5 s and was identical from its first record. |
| 4 impairment | `impaired` (WebTransport) and `impaired-ws`: **3 of 3 each** at `lat=30,jit=10,loss=3,dup=2,reorder=3`, a seed per machine (about 150 lost, 80 to 105 duplicated, 135 to 155 reordered per game; vnet logged the spec on every machine). |
| 5 bots | `bots`: **3 of 3**; both machines logged 2 bots. |
| 6 failures | `errors`, 64 checks, 100 s (a bound, then the measured time): relay not listening 20 s, 6.4 s; no such room 10 s, 0.6 s; room full 10 s, 0.9 s; relay killed 15 s, host 0.0 s and joiner 1.7 s; member dropped by the relay 10 s, 2.1 s after it thawed; host gone 30 s, 15.3 s ("Server Timeout"). Each: the bar under the picture says why, not stuck on "connecting", the game running at the title screen with its dump growing. 7 bad `-relay` values, `-relay` on a page with no relay and `-server 2` on a page with no relay: the overlay shows the message, status not 0. |
| 7 knobs | `knobs`, 30 checks, 18 s: no effect without `?test=1` (no `DL_*` or `VNET_IMPAIR` in the game's environment, no relay contact, no hooks); config.js's relay is passed, the address bar's is not; with `?test=1` they act; 8 bad values refused by the page and 3 by the game. |
| 8 L60 | `connect-spin`: a waiting joiner made **350 to 366 passes a second** (about 450,000 to 550,000 without the yield). Escape ends the loop (the room is left in under 3 s). A join in progress of a 6-bot game: median **0.51 s** after, **0.52 s** before (5 runs each). |
| 9 failure proofs | below. |
| 10 | the list above; `asan-demos.sh`: 53 sites, 0 new (206 s). |

Whole batch of the ten game scenarios, 3 runs each: **30 games, 453 checks, 21 minutes, 0 failed.**

**Failure proofs** (each change reverted, or the test's own switch, then restored)

| Reverted | Test | Result |
|---|---|---|
| the yield in the two loops (a build without them, `build/wasm-before`) | `connect-spin` | 450,000 to 530,000 passes a second: 1 failed |
| the page's test gate (`return` when not `?test=1`) | `knobs` | all four knobs reach the game without `?test=1`: 4 failed |
| `I_Web_NetStatus` in `vn_failed` | `errors` | the bar stays on "Creating/Joining a room" or "Hosting room": 15 failed (including the stale-connecting checks) |
| the page's network bar not read (`NETPLAY_SABOTAGE=noerrpage`) | `errors` | 14 failed |
| the game's `DL_RELAY` check and the no-relay refusal in `i_tcp.c` | `errors` | both cases run to the 15 s bound with no message: 4 failed |
| the transport log line, and the page's quit request | `ws` | the transport check, the exit status and the "left the room" checks: 5 failed |
| no `relay_wt`/`relay_cert` in a `wt` game (`NETPLAY_SABOTAGE=nowt`) | `wt` | both pages log `relay-ws`: 2 failed |
| one byte of the last machine's dump changed (`flip`) | `wt` | "first difference at tic 535 ... random": 1 failed |
| that dump cut in half (`short`) | `wt` | "535 >= 1050": 1 failed |
| the poll bound lowered to 1 s (`NETPLAY_GAPMAX=1000`) | `ws` | the 2 s screen wipe's gap, 1.49 s: 1 failed |
| the `savegame-old.sh` regression I caused (`#include "i_web.h"` in `test_dump.c`) | `savegame-old.sh` | "the old build failed": fixed, 12 of 12 |

**Decisions**

- *The page gives the relay to the game*: `config.js` `relay` (or `relay=` on a test page) becomes `-relay URL` and `DL_RELAY` in the game's environment; the game refuses `-relay` without `DL_RELAY`. The knobs go through the environment (`preRun`), so the engine reads them with `getenv`, and `VNET_IMPAIR` is vnet's own variable.
- *The wake is not used*: with visible tabs the game polls every pass and yields once a frame; `impaired` 3 of 3 without it. 04b needs it (`code-facts.md` §13 says how).
- *Failures on the page*: a line under the picture (`window.dlNet`), set by the game through `I_Web_NetStatus`; the game's own menu box stays too. A game that ends with `I_Error` is the existing overlay.
- *Idle only when nothing came*: the first version idled in every non-tic pass and made a 6-bot join 0.2 s slower on a small savegame; now a pass that received a datagram goes round at once (`net_packets_got`).
- *A network game with no relay is refused* in the browser (L69), where it used to hang.
- *Tests stop a page with `window.dlTest.quit()`*, a flag the game reads at its tic, so it leaves the room and prints vnet's counters.

**New bugs:** L69 (fixed here), L70 (not investigated).

**Concerns**

- L70, above: a lossy hot join at seed 1 fails on the tip of `claudeai` as well; I did not look at it. The browser impaired runs did not show it.
- `demo-page.js`'s stall check failed once (177 ms) and passed on the re-run: timing-sensitive on a busy machine.
- The repair-download loop got the same yield but no test runs it.
- The longest stretch without a poll was 1.5 to 2.0 s in every game, the level-start wipe, natively too. Under 5 s here, but a slower machine or a long level load on a real device may get closer to the relay's limits.
- Headless Chromium has all pages visible; nothing here says what a real hidden tab does (04b).
- A hot join is only 0.5 s because the savegame is small; large mods are not measured.
