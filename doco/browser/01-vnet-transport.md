# 01: vnet transport (native)

## Goal

Native players create and join network games through a vnet relay by room code, using Doom Legacy's own client/server networking unchanged on top. The room creator is the server (D4). Joining a game in progress works through the relay as it does over UDP (D2). Plain UDP (`i_tcp.c`) keeps working exactly as today.

## Read first

- [`README.md`](README.md): D2, D3, D4, D11, D12.
- [`code-facts.md`](code-facts.md) §2 (the driver table, nodes, packet sizes), §3 (start-up), §4 (the join), §5 (consistency), §11 (the state hash and the pause handling).
- [`bugs.md`](bugs.md): L21 (the joining client's pause), L29 (a slow joiner diverges), L31 (`PT_STATE` has no sequence number).
- The Outcome of [00](00-baseline.md).
- vnet `v0.5.0` at `ext/vnet` (read-only): `include/vnet.h`, `doco/integration.md` (the per-frame sequence, the status states, what to do on `FAILED`, impairment, "Vendoring without CMake"), `doco/relay-protocol.md` ("Rooms and virtual addresses": the creator is always `10.0.0.1`, joiners get `10.0.0.2` up; room codes; the member cap), `relay/README.md` (running the relay).
- jfsw-browser (read-only, `/home/user/jfsw-browser`, branch `claude`): `doco/browser/01-vnet-transport.md` and its Outcome, and `tests/net/lib.sh` (starting a local relay, reading the room code, stopping every process a test started). Same job for another game; reuse what was learnt, not its code.

## In scope

### 1. Build

- Native: all of `ext/vnet/src/*.c` compiled into the game, per "Vendoring without CMake", with vnet's own flags (`-std=c11 -D_POSIX_C_SOURCE=200809L`, `-Iext/vnet/include -Iext/vnet/src`) on vnet's files only. Through the native build's compiler wrapper, so vnet is also built without `-ffast-math`. Prefer new Makefile lines over changes to existing ones (D11).
- Wasm: `scripts/build-wasm.sh` must still build. Whether vnet and `i_vnet.c` are compiled into it now or in brief 04 is your call; if they are, they must not change what the wasm build does today.
- **The relay** for tests: `scripts/build-relay.sh` builds `ext/vnet/relay/cmd/vnet-relay` into `build/relay/` (Go 1.24 is installed; its modules download from the default Go proxy, which works here). Don't commit the binary.

### 2. `src/i_vnet.c` and `src/i_vnet.h`

- New files that fill the driver table (`d_net.c:107-113`) with vnet: open, get, send, can-send, make-node, free-node, close. The table, `doomcom` and the game's own reliability (acks, resends, timeouts in `d_net.c`) are unchanged on top. vnet is unreliable and unordered, like UDP.
- **Nodes.** Map node numbers to `vnet_addr` the way `i_tcp.c` maps them to `sockaddr_in`: node 0 is self, a packet from an unknown address gets a new node on the server, `I_NetFreeNode` frees one. Use `vnet_addr_equal`. Datagrams from `10.0.0.254` and `.255` are never a player (relay protocol).
- **Packet size.** `hardware_MAXPACKETLENGTH` = `VNET_MAX_DATAGRAM` (1,100) or less; say what you chose and check that nothing the game sends (tic packets, savegame fragments, server info) can exceed it (`software_MAXPACKETLENGTH`, `d_clisrv.c:415`, code-facts §2).
- **Polling.** `vnet_poll()` often enough in every state: from `I_NetGet` and `I_NetSend` at least, and check that the blocking loops (`CL_ConnectToServer`, the savegame download, the wait for players, level loading) keep calling one of them, so the relay's 15 s silence limit and vnet's keepalives are never missed. Drain the socket every frame (`I_NetGet` is called until it returns nothing: check).
- **The context.** `VNET_BACKEND_RELAY_AUTO` with `relay_udp` set (natively the relay over UDP; D3). One context per game process; on `FAILED`, as `doco/integration.md` says: report `vnet_strerror(st.error)` and end the network game. No reconnect in this brief.
- **What later briefs need** goes in `i_vnet.h`: the state (connecting, ready, failed), the room code, this machine's virtual address, the room's member cap, the last error text. Brief 05 builds its lobby on this; document each function.

### 3. Arguments

- `-relay HOST:PORT` selects the vnet driver for this run; without it nothing changes. The existing options keep their meaning:
  - `-relay R -server [N]` (and `-relay R -dedicated`): create a room. This machine is the server and `10.0.0.1`. `N` is the number of players to wait for, as today.
  - `-relay R -connect CODE`: join room `CODE` and connect to its server at `10.0.0.1` (vnet resolves `room-host:PORT`). The server's port is `-udpport` (default 5029) as today, carried as the vnet port.
  - `-connect` with no address (`connect any`, a LAN broadcast) is refused over the relay with a message.
- Resolve the relay's host name once (`vnet_resolve_host`), and pass the numeric form to `vnet_create`.
- **The room code** is printed where a player sees it (the console and stdout, flushed) as soon as the room exists, for example `vnet: room code ABC234 (you are 10.0.0.1; the room takes 8 players)`, and is available from `i_vnet.h`.
- **Player caps.** The relay's member cap (8 by default) and the game's `cv_maxplayers`: a joiner beyond either gets a clear refusal (the relay's `ROOM_FULL`, or the game's own "server is full"), never a hang. Say which applies when.
- Add the new options to the game's `-help` text if there is one.

### 4. Errors

Bad arguments, an unreachable relay, a bad room code, a full room and a relay that ends the session each end with a clear message (`vnet_strerror`) on stdout and the console, within a bounded time. Before you change anything, find out what a failed `-connect` over UDP does today (an unreachable address, a server that never answers), and make the relay failures end the same way (to the title screen, or an exit; say which). Host loss during a game behaves as it does over UDP (the node times out, `PT_NODE_TIMEOUT`); say what the client sees.

### 5. Determinism

The simulation does not change. The transport must not either: no packet is changed, reordered or dropped by `i_vnet.c` beyond what vnet does.

## Out of scope

- The browser build's networking, WebSocket and WebTransport (04).
- The page, the lobby, menu and console entries (`host`, `join`) (05).
- Reconnecting, host migration, the master server (`mserv.c`) and LAN search over vnet.
- Fixing L29 or L31, unless a test here can't pass without it (then stop and report first).
- Changes to vnet. If vnet has a bug, write it up with a reproduction and stop.

## Acceptance criteria

1. Native and wasm build from a fresh recursive clone; vnet's files are built without `-ffast-math`.
2. Without `-relay`, nothing changes: `tests/net/test-hot-join.sh` (all three modes), `tests/demo-hash.sh` and `tests/draw-independence.sh` still pass.
3. Three native instances play through a local relay: a server with `-server 2` and one client, and a third player joining the game in progress. Every machine's `-testdump` file agrees with the server's for every tic it covers, for at least 30 s of game time after the join, with no consistency fault logged.
4. The same with vnet's impairment on every process (`VNET_IMPAIR`, a different `seed=` per process): latency and jitter, loss, duplication and reordering at modest values (say `lat=30,jit=10,loss=3,dup=2,reorder=3`; choose and state them). The game's own resends must cope. If a join diverges here, diagnose it (it may be L29 or L31): a small fix inside this chunk is fine if you show it is needed; anything bigger, stop and report.
   **Narrowed by the user, 26 Nov 2026,** after the implementer stopped here: in 01, AC4 is latency only (`VNET_IMPAIR=lat=30`, three runs). With loss, duplication or reordering the join in progress diverges over plain UDP too (`bugs.md` L31, L35); fix chunk **F4** fixes that and restores this criterion at the values above, before brief 04.
5. The errors in §4 behave as described, each checked by a test within a bounded time.
6. `code-facts.md` gains a section on `i_vnet.c`: the node mapping, the polling points, the packet size, the arguments, the errors, and what `i_vnet.h` offers.
7. Each new test is shown to fail when what it checks is broken (throwaway patches): for example a driver that drops every tenth packet without telling the game's reliability layer (or a disabled resend) under impairment, a node mapping that swaps two peers, and the error tests against the build from before this brief.

## Tests

- `tests/net/test-relay.sh`: starts its own relay on free ports (never a fixed port another test might use), runs AC3, then AC4 with `--impair`. Bounded; stops every process it started, and fails if any is left (as jfsw's `lib.sh` does). Reuse `tests/net/test-hot-join.sh`'s comparison and log checks rather than writing new ones.
- `tests/net/test-relay-errors.sh`: AC5.
- `tests/net/test-relay.sh --dedicated` (or a case in it): a `-dedicated` server over the relay with two players, if it is cheap; otherwise say why not.
- Repeat: AC3 five times and AC4 three times; report the counts and times.
- Everything under 00 still passes (AC2), and `tests/sprite-column-oob.sh` 6/6.

## Dependencies

00 (done).

## Notes

- **Git:** work on `browser/01-vnet-transport` in `doomlegacy-browser`, from `claudeai`. Commit at each milestone and push only that branch. Never merge, never touch `claudeai` or `main`, never open a pull request, never force-push. `ext/vnet` and `jfsw-browser` are read-only.
- Commits end with the attribution lines the coordinator gives you. No model names in commits or docs.
- Builds use `-j4`. Each headless game uses 100% of a core (L7) and the container has 4 cores: three games and a relay are the most to run at once.
- Test-only options change nothing when absent and never travel on the wire.
- Report a blocked host; don't work around it.

## Outcome

Status: **done, 26 Nov 2026.** AC4 narrowed by the user to latency only; the full AC4 moved to F4. Three independent reviews (the last: merge), two fix rounds, coordinator verification below. The implementer's report as it stood when it stopped:

Status was: **stopped for a decision.** Everything in scope works and is tested, except that the impaired three-player game (AC4) does not pass reliably: at the brief's modest values the join in progress diverges in about 40% of the runs, and the cause is in the game's own join protocol (`bugs.md` L31, L35), reproduced over plain UDP with no vnet involved. The brief says to stop and report when that cause is bigger than a small fix; it is. Branch `browser/01-vnet-transport`, pushed, not merged.

**What landed** (commits on the branch; the hashes of the first four are `6be8c40`, `2759ff7`, `49290e0`, `fda5833`, then the documentation commit)

- `src/i_vnet.c`, `src/i_vnet.h`: the driver table on a vnet relay room (`code-facts.md` §13 has the details): `-relay HOST:PORT` with `-server [N]`, `-dedicated` or `-connect CODE`; nodes mapped to `vnet_addr`; polling in `I_NetGet`, `I_NetSend`, `I_NetMakeNode` and at open; 1,100-byte packets; the room code printed when the room is entered; every relay failure reports `vnet_strerror` and ends the network game; a joiner gives up after 20 s if the host says nothing. `i_vnet.h` offers a lobby the state, room code, virtual address, member cap, last error and transport.
- Hooks in upstream files (D11), each a few lines: `src/i_tcp.c` (`I_Init_TCP_Network` hands over when `-relay` is given), `src/d_net.c` (packet length after the driver's init, one line and one include), `src/d_main.c` (`-help`). New lines in `src/Makefile` (the vnet objects and `i_vnet.o`, two rules); `scripts/wasm.mk` and `CMakeLists.txt` list `i_vnet.c` (built as stubs that refuse `-relay`, so the browser build is as it was).
- `scripts/build-relay.sh`; `tests/net/lib.sh`, `tests/net/test-relay.sh`, `tests/net/test-relay-errors.sh`.
- Docs: `code-facts.md` §13 (and §2 corrected: the driver's 512-byte limit was never in force, `bugs.md` L34), `building.md` §3 and §9, `bugs.md` L32 to L35 and L31 rewritten, README status.
- No change to the simulation or to the game's net code beyond those hooks; the one candidate fix for L31 was tried and left out (below).

**Acceptance criteria**

1. **Builds.** Native: `scripts/build-native.sh` 11 s from scratch, no new warning; all 13 `ext/vnet/src/*.c` are compiled as `vnet-*.o` with `-std=c11 -D_POSIX_C_SOURCE=200809L -Iext/vnet/include -Iext/vnet/src -O2 -Wall -Wextra` through `cc-no-fast-math.sh` (the log shows `-fno-fast-math -ffp-contract=off` last on every vnet line). Wasm: `scripts/build-wasm.sh` builds (`doomlegacy.wasm` 2,010,426 bytes; was 2,007,709), `i_vnet.c` in stub mode; `tests/demo-hash.sh` native against wasm 11 of 11 identical on the final build. Fresh recursive clone: see the last section.
2. **Without `-relay` nothing changes.** On the final build: `tests/net/test-hot-join.sh` default PASS 56 s (1,443 identical records, tics 361 to 1,803), `--together` PASS 47 s (1,437, from tic 1), `--no-force` PASS 56 s (1,439); `tests/demo-hash.sh` 11 passed in 360 s; `tests/draw-independence.sh` PASS 93 s; `tests/sprite-column-oob.sh` 6 passed, 0 failed, 60 s.
3. **Three players through a relay, clean: 5 of 5 pass, 45 s each (224 s together).** Server `-server 2`, client A joins at the start, client B joins the game in progress at server tic about 360, plays at least 30 s: for example server 1,451 records, A 1,452, B 1,090 (tics 363 to 1,451); the server's file against A's and against B's identical on every tic they share; no consistency fault, repair or kick in any log; the game not idle (146 distinct `P_Random` states, 15 world states).
4. **Impairment: met as narrowed (latency only, `lat=30`); not met at the full values, which move to F4.** The narrowed runs are recorded under the coordinator's verification. At the full values: Values chosen (the brief's example): `VNET_IMPAIR=lat=30,jit=10,loss=3,dup=2,reorder=3,seed=N` on every process, seeds `10*run+1` (server), `+2` (A), `+3` (B). The counters at exit show the impairment really applied (about 160 lost, 100 duplicated and 160 reordered datagrams per game, all processes together). Results at these values, all builds with the same data path: **13 of 21 runs passed (62%)**, in streaks (4 of 4 passes after one rebuild, the last 3 runs of the final suite all failed): the pass rate moves with how busy the machine is, and with one extra busy process 1 of 2 failed. Every failure is the join: the joiner, or a player already in the game, parts from the server at the tic of the join or a few tics later. What I found:
   - **Not the driver.** The same divergence with the plain UDP driver: `tests/net/test-hot-join.sh` with 3% of the loopback datagrams dropped (`iptables -m statistic --probability 0.03`, rule removed afterwards, nothing committed) failed 5 of 7 runs, first difference at tic 392 to 401, the first tics after the join. A throwaway driver that drops every tenth datagram silently fails the same way (below).
   - **By kind of impairment** (3 runs each, final build): latency alone `lat=30` 3 of 3 pass; `lat=30,jit=10` 2 of 3; `loss=3` 1 of 3; `dup=2,reorder=3` 2 of 3; all together 0 of 3 on the last series. At `lat=50,jit=20,loss=5,dup=3,reorder=5` 1 of 3, at `lat=80,jit=30,loss=8,dup=5,reorder=8` 0 of 2.
   - **Three mechanisms**, two logged and understood (`bugs.md` L31): `PT_STATE` pause and unpause arriving in the wrong order, once as a pause for gametic 377 ignored because the unpause for 378 had overtaken it (joiner's `leveltime` 376 against the server's 375), once as a same-gametic pair swapped (a player in the game paused until the next `PT_STATE`); and one not understood (L35): the joiner's first tics run non-zero ticcmds for players that send none.
   - **The small fix for the first** is two lines in `state_handler` (`if( serv_gametic < pause_high_tic && serv_gametic < gametic )` to ignore, and raise `pause_high_tic` only). It removes that mechanism and the pass rate stayed about the same (4 of 10); it is not committed (patch in L31's row). A real fix is a sequence number in `PT_STATE` and a queue ordered by (gametic, sequence), a protocol change, and L35 needs a packet trace of the join: both are bigger than a small fix.
   - **What I would do** (your call): (a) fix L31 with the sequence number and look at L35, then AC4 at these values; (b) accept AC4 with latency only (`--impair lat=30`: 3 of 3), and keep L31 and L35 for brief 04, where the WebSocket is reliable and ordered and the relay's browser legs cannot reorder; (c) both. The test is left as the brief wrote it and fails when the game does.
5. **Errors: `tests/net/test-relay-errors.sh`, 40 checks, all pass, 121 s.** Each case has a time limit. Bad arguments (8 cases: `-relay` with no value, no port, a URL, an unresolvable name; `-connect` with no code, with `ABC23I`, with `127.0.0.1`; `-udpport` with no value): the message on stdout and exit status 255 in 4 s. A relay nobody listens on: server and joiner say "cannot create a room / cannot join room ABC234 on relay ...: timed out: the relay did not answer (is its UDP address right, and is it running?)" after 10 s (vnet's `relay_timeout_ms`), end the network game and stay at the title screen; a `-dedicated` server exits with status 255 after 13 s. A code that is not a room: "no such room" in under 1 s. Full room (`-max-members 2`): "room is full" in under 1 s, the first joiner plays on. The game's own limit (`+sv_maxplayers 1`): the joiner enters the room, the server refuses it (a menu message in the game, not on stdout), it leaves the network game in 2 s (`vnet: closed`), the server keeps playing. Relay killed during a game (`-keepalive 1s`): both players report "the relay session ended: timed out: the relay went silent" and leave the game 3 s later (3 keepalive intervals of 1 s; 15 s with the default 5 s). As first written this took 8 s: 5 s of it was a freeze in the driver, see the Fix round. A member silent for longer than the relay's `-session-timeout`: told "session closed by the relay" within 5 s of running again. Host killed: the client stalls about 15 s, "Server Timeout", leaves the network game, runs on at the title screen: the same as over UDP. Host that never answers: "the host did not answer within 20 s" after 20 s. Two of these bounds were close to what was measured (relay-drops within 5 s, measured 1 to 5; relay-dies within 10 s, measured 3 to 8): that was a 5 s freeze in the driver, fixed in the Fix round, where the bounds are now 2 s and 6 s.
   - **What a failed UDP `-connect` does today** (before any change, `strace`d): an address that does not resolve: "Network address error", `D_CloseConnection`, the title screen. An unreachable address or a server that never answers: `CL_ConnectToServer` sends `PT_ASKINFO` every 2 s for ever; only Q or ESC leaves ("Network game synchronization aborted"). The relay failures end like the first (title screen, `Command_ExitGame_f`); the silent host is bounded at 20 s where UDP is not.
6. **`code-facts.md` §13** covers the node mapping, polling points, packet size (with what the game sends, measured), arguments, errors and `i_vnet.h`.
7. **Each new test fails when what it checks is broken** (throwaway patches, none committed):
   - A driver that silently drops every tenth datagram (`if( ++cnt % 10 == 0 ) return NE_success;` in `vn_send`) under impairment: `FAIL server and A: ... first difference at tic 1`, `FAIL server and B ... first difference at tic 370`, `FAIL no consistency fault` (`Report: gametic 367 ...`), `FAIL the game was not idle`. The same plus the game's resend disabled (`HSendPacket` removed from `Net_AckTicker`): B never joins (`records: server 4118, A 3413, B 0`, `FAIL B joined in progress`, `FAIL B has at least 30 s`). The resend disabled alone did not fail the impaired run (the file transfer and the tic packets have resends of their own).
   - Node mapping swapped (`10.0.0.2` and `10.0.0.3` exchanged in `vn_get`): the game never starts (`records: server 0`), `FAIL server and A: no tics in common`, `FAIL no consistency fault` (both joiners "the host did not answer within 20 s").
   - Impairment not applied (`cfg.ignore_env = 1`): the game passes, `FAIL impairment was applied: datagrams were lost (0)`, `duplicated (0)`, `reordered (0)`.
   - The error tests against the build from before the brief (`69c84c3`, which does not know `-relay`): all 8 argument cases fail (the game ignores `-relay` and runs on: killed after 20 s; the `-udpport` case segfaults, `bugs.md` L32); the relay-unreachable case fails 5 of 5 checks and no-such-room 2 of 2; killed or timed out in every case.
   - Not done: a case where the hash comparison itself is shown to catch a one-tic offset in this test (it is the comparison `test-hot-join.sh` already proves, `testdump-diff.py --common`).

**The dedicated case.** `tests/net/test-relay.sh --dedicated` passes (44 s): a `-dedicated -server 2` server, two players, the three machines exchange tics through the relay (1,137 and 1,090 datagrams received by the players), A's and B's files identical, the server's identical apart from the game-state word. **No level is loaded**: a dedicated server of this build crashes when it loads one, also over UDP and before this brief (`bugs.md` L33), so a game with a dedicated host cannot be tested until that is fixed. The browser does not need it (D4).

**Other findings** (all in `bugs.md`): L32 `I_Error` during start-up with `-server` crashes (found by the argument tests; worked around in `i_vnet.c`); L33 the dedicated server above; L34 the UDP driver's 512-byte limit is overwritten, so UDP always ran at 1,450 (`code-facts.md` §2 corrected). The lockstep server stalls about 15 s when a client dies or freezes, then goes on: the same over UDP.

**For later briefs**
- 04 (browser): `i_vnet.c` is the driver for the browser too. Compile it with `-DUSE_VNET` and vnet (`-lwebsocket.js`), add `wake`, a timer-driven poll and the yields of 02 to the blocking loops (the driver polls from `I_NetGet`/`I_NetSend`, which every loop reaches); `vnet_resolve_host` and `vnet_wait` are not available there. The WebSocket legs are reliable and ordered, so L31 and L35 should not show for browser players; native UDP players in the same room still meet them. L19 first.
- 05 (lobby): **not as first written.** `I_VNet_Configure` only sets static state; the driver is installed (`I_NetOpenSocket = open_socket`) and the 1,100-byte limit applied only at start-up with `-relay`, so a lobby in a session started without `-relay` still gets the UDP driver and 1,450-byte packets. 05 must add the installing step (`code-facts.md` §13, "What a lobby can use today"). Then the game's own `-server`/`connect` paths open the driver; `I_VNet_State`, `I_VNet_Room_Code`, `I_VNet_Self_Address`, `I_VNet_Max_Members`, `I_VNet_Error_Text`. The driver ends the game itself on a failure.
- 04: `I_VNet_Configure` refuses `ws://` (any `://`) URLs and calls `vnet_resolve_host`, which the browser does not have: 04 has to change it.
- A joiner's `-udpport` must equal the host's (the vnet port is the game's server port).

**AC4 as narrowed (coordinator, 26 Nov 2026).** `tests/net/test-relay.sh --impair-only --runs 3` with the new default `lat=30`: 3 of 3 PASS, 52, 51 and 51 s (2 min 34 s). The new check "every process started with the impairment" fails when one process is started without `VNET_IMPAIR` (throwaway patch on B's environment: `FAIL every process started with the impairment (2 of 3)`, exit 1; reverted).

**Concerns and open questions**
- AC4, above: decided by the user, 26 Nov 2026: narrowed to latency only here, the rest is F4. The coordinator changed `tests/net/test-relay.sh`'s default to `lat=30` and added a check that every process started with the impairment (a latency-only spec leaves no counter).
- (The two tight bounds in `test-relay-errors.sh`: resolved in the Fix round.)
- The impaired runs depend on CPU headroom (three games and a relay on four cores); nothing else should run.
- A test run against a build that does not know `-relay` once filled the disk (a game flooded its output file); `lib.sh` now limits each game's files to 256 MB.
- `NE_refused_again` is returned for a datagram vnet refuses (UDP's choice); vnet's counters show 0 refused in every run.
- Not checked: Windows and macOS; upstream SVN for L32 to L34 (SourceForge can't be read from here).

## Fix round (independent review of the above)

Four findings and the nits, on branch `browser/01-vnet-transport`.

1. **A relay failure froze the game for 5 s.** `vn_end_game` now closes the connections itself and calls `D_CloseConnection()` (netgame false, driver closed) before `Command_ExitGame_f`, so the reliable `PT_CLIENTQUIT` or `PT_SERVERSHUTDOWN` of `D_Quit_NetGame` is never sent and no ack is waited for. A `-dedicated` server does the same before `I_Error`. `code-facts.md` §13 and the Outcome no longer say the pending acks were "dropped first" (they were, but the quit packet saved a new one) or that the game left after 8 s (it was 3 s of silence and 5 s of freeze). New case `relay-dies-dedicated` (a `-dedicated` server with a player, relay killed). Bounds now: relay-drops within 2 s (was 5), relay-dies within 6 s (was 10); measured 0 to 1 s and 3 s. With the `D_CloseConnection()` line commented out (the 5 s wait back) the three checks fail: relay-dies 8 s, the dedicated case 8 s, relay-drops 6 s. A `-dedicated` server also leaves at once; its process ends 3 s later because `I_Error` sleeps 3 s (upstream).
2. **"B joined in progress" could not fail.** The first tic is read with `s/.*tics \([0-9][0-9]*\)\.\..*/\1/p`. With `--join-after 0 --play 5`: `FAIL B joined in progress (its first record, tic 47, is after tic 100)`.
3. **AC4 did not prove vnet took the impairment.** `vn_log` passes on vnet's INFO line `impairment from VNET_IMPAIR="..."`, and the test needs `vnet: impairment from VNET_IMPAIR="lat=30,seed=` in all three logs. With `cfg.ignore_env = 1` in `open_socket`: `FAIL vnet took the impairment from VNET_IMPAIR on every process (0 of 3)`. With B started without `VNET_IMPAIR`: `(2 of 3)`.
4. **Lobby path documented as it is.** `i_vnet.h` and `code-facts.md` §13 say what `I_VNet_Configure` does (static state only), that `I_NetOpenSocket` and the 1,100-byte limit are set only at start-up with `-relay`, what 05 must add, and that 04 has to change `I_VNet_Configure` (it refuses URLs and calls `vnet_resolve_host`). No lobby code was written.

Nits: `building.md` §9 row (default `lat=30`, F4 for the full spec); `paksize_limit` is at `d_clisrv.c:2199` (the other §13 references were right); `vn_send` reports once when the 16-datagram queue overflows (and §13 says why it does not happen); `ending` is reset at the start of `open_socket`.

**Results** (one test at a time, final build): native build from clean 11 s, no warning in `i_vnet.c` or vnet; wasm build from clean 9 s, `doomlegacy.wasm` 2,010,426 bytes (unchanged). `test-relay.sh --runs 3`: 3 of 3 clean (44, 45, 45 s) and 3 of 3 impaired `lat=30` (51, 46, 51 s), B 1,092 to 1,108 records. `--dedicated`: PASS 44 s. `test-relay-errors.sh` three times: PASS each, 42 checks, 126 s; relay-dies 3, 3, 3 s; relay-dies-dedicated 3, 3, 3 s; relay-drops 1, 0, 1 s. `test-hot-join.sh` default: PASS 56 s (1,443 records, tics 355 to 1,797).

## Fix round 2

The first fix round had a regression. `vn_end_game` called `D_CloseConnection()` (netgame false) before `Command_ExitGame_f`, so `D_Quit_NetGame` returned at once and never set `network_state = NETS_shutdown`. A joiner whose relay failed while it was still in `CL_ConnectToServer` (relay unreachable, no such room, room full, host silent) never left that loop: it stayed on the connect screen until Q or ESC, though it printed "vnet: closed" and was alive. In-game failures and a waiting `-server` host were not affected.

- **Fix.** A small function in `d_clisrv.c`, `D_Quit_NetGame_Closed()` (declared in `d_clisrv.h`), sets `cl_server_state = NOS_idle` and `network_state = NETS_shutdown`; `vn_end_game` calls it after `D_CloseConnection()`. Nothing else upstream changed. The 5 s wait stays gone: no quit packet is sent.
- **Tests.** Every case that says the game is back at the title screen now checks that its `-testdump` file keeps growing 2 s after `vnet: closed` (a helper `title_screen`): relay-unreachable (server and joiner), no-such-room, room-full (the refused joiner), game-full, relay-dies (host and player), relay-dies-dedicated (the player), relay-drops and host-silent. With the call to `D_Quit_NetGame_Closed()` commented out (the state of the first fix round) these failed: relay-unreachable joiner, no-such-room, room-full and host-silent (4 checks `FAIL ...: back at the title screen (its tics go on)`); they pass with the fix.
- **Relay dying during the join, not covered.** I tried a case that kills the relay when the joiner has entered the room and before its first tic (it had written 0 tics): it passed on the broken build too, so it proves nothing about the regression and I removed it rather than keep a check that cannot fail. The savegame download itself is fast on loopback and has no marker in the log, so it cannot be hit reliably; the download state is in the same `CL_ConnectToServer` loop with the same exit condition, but this is not tested directly.

**Results** (one test at a time): native build from clean 11 s, the same 11 warnings as before, none in `i_vnet.c`, `d_clisrv.c` or vnet. `test-relay-errors.sh` three times: PASS each, 52 checks, 144 s; relay-dies 3, 3, 3 s; relay-dies-dedicated 3, 3, 3 s; relay-drops 0, 0, 0 s. `test-relay.sh --runs 2`: clean 45, 45 s and impaired (`lat=30`) 51, 51 s, all PASS (B 1,091 to 1,108 records). `--dedicated`: PASS 44 s. `test-hot-join.sh` default: PASS 56 s (1,442 records, tics 361 to 1,802).

## Review and coordinator verification (26 Nov 2026)

**Review.** An independent reviewer read the brief, the code and the tests in its own worktree, three times.
- Round 1, on `a2a5af6`: "merge after fixes". It found four problems:
  - a 5 s freeze on every relay failure;
  - a "joined in progress" check that could never fail;
  - an impairment check that did not show vnet took the impairment;
  - wrong notes on the lobby path.
- Round 2, on `f4306ab`: "do not merge". The first fix left a joiner whose relay failed stuck on the connect screen.
- Round 3, on `7268da8`: "merge". Fix round 2 added `D_Quit_NetGame_Closed`. The new title-screen checks fail without it, and the wasm build compiles.
- The original implementer could not be reached after a container restart, so a second implementer did both fix rounds from the review's findings.

**Coordinator verification** on `7268da8`. Builds from clean, everything run one at a time on an otherwise idle 4-core machine:

| Check | Result | Time |
|---|---|---|
| Native build from clean | built | 11 s |
| Wasm build from clean | built | 9 s |
| Relay build | built | 1 s |
| `tests/net/test-relay.sh --clean-only --runs 5` (AC3) | 5 of 5 PASS (for example server 1,460 records, B from tic 369) | 224 s |
| `tests/net/test-relay.sh --impair-only --runs 3` (AC4, `lat=30`) | 3 of 3 PASS | 153 s |
| `tests/net/test-relay.sh --dedicated` | PASS | 44 s |
| `tests/net/test-relay-errors.sh` | PASS, 52 checks | 144 s |
| `tests/net/test-hot-join.sh` default, `--together`, `--no-force` | PASS each | 56, 45, 57 s |
| `tests/sprite-column-oob.sh` | 6 of 6 | 60 s |
| `tests/draw-independence.sh` | PASS | 92 s |
| `tests/demo-hash.sh` (native against wasm) | 11 of 11 identical | 336 s |
| `tests/asan-demos.sh` | 53 known sites, 0 new | 234 s |
| Fresh `git clone --recurse-submodules` of the branch, native build | built | 13 s |

No game or relay process was left over. I read the code diff of each fix round myself.
