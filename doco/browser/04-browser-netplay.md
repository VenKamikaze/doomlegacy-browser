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

Status: not started.
