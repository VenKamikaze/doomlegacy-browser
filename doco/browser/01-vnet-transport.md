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

(to be filled in)
