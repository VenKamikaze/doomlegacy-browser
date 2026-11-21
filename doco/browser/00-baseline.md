# 00: Baseline, state hash and code facts

## Goal

Give every later brief something it can trust:
- native and wasm builds of the game without `-ffast-math`;
- a per-tic game-state hash (`-testdump`) that is the same between native and wasm for every demo;
- a hot-join test between two native instances over plain UDP on loopback;
- an ASan build that keeps going after the first error, with its findings in `bugs.md`;
- a `code-facts.md` that checks the survey's claims with file:line refs.

The wasm build here only has to run headless (Node or headless Chromium). There is no page yet: that is brief 02.

## Read first

- [`README.md`](README.md): decisions D1-D12, the git rules.
- [`building.md`](building.md): set-up, builds, test data, headless run, Emscripten.
- [`bugs.md`](bugs.md): L1-L12. L2-L4 (demo name quirks), L7 (100% CPU), L8 (`finetangent` overread, which may draw differently native vs wasm) and L9 (zone alignment) matter here.
- [`survey.md`](survey.md): its "Doom Legacy (rank 1)" section is the list of claims `code-facts.md` must check.
- [`F1-sprite-column-oob.md`](F1-sprite-column-oob.md): the Outcome format, and the ASan command.
- jfsw-browser (read-only, `/home/user/jfsw-browser`, branch `claude`): `doco/browser/code-facts.md` §§ on `-testdump` and `-teststate` (search for `testdump`) and `doco/browser/02-emscripten-port.md`. Same idea here; don't copy its code.

## In scope

### 1. Builds without `-ffast-math`

- `src/Makefile:1357` and `CMakeLists.txt:86` add `-ffast-math` unconditionally.
- Native: `scripts/build-native.sh` builds without it by default. Prefer a way that changes no upstream file (for example `-fno-fast-math` through the make options, which land after `-ffast-math` on the command line: `src/Makefile:1357-1360`), and show with `make -n` or the compile line that it takes effect. Keep a way to build with it (`--fast-math` or similar) for the comparison in §3.
- Fix `CMakeLists.txt:86` the same way only if it's cheap; this project doesn't use the CMake build. Say what you did.

### 2. Wasm build (`scripts/build-wasm.sh`)

- Emscripten 6.0.13 from `scripts/setup-emsdk.sh --with-ports` (`~/.cache/doomlegacy-browser/emsdk`).
- Software renderer only (no `HWRENDER`, D5), SDL2 port, no IPX, no TCP master server if it gets in the way. Sound may be off in this brief (`-nosound -nomusic`), and so may `HAVE_MIXER`.
- Reuse the upstream Makefile with `emcc` if that's practical; otherwise a script that compiles the Makefile's object list. Say which, and why.
- Source changes: only what the build needs, each `#ifdef __EMSCRIPTEN__` (D11). Known one: the `strupr`/`strlwr` prototypes, `src/doomtype.h:183-186`.
- `D_DoomLoop` (`src/d_main.c:1085`) never returns. For a headless run under a browser, it must yield (ASYNCIFY and `emscripten_sleep(0)` once per pass, as D6 plans); under Node a plain blocking run may be enough. Pick whichever gives a working headless run with the least code; the other blocking loops (wipe, connect, savegame download, menu) are brief 02's.
- Files: the IWAD, `legacy.wad` and the demo go into MEMFS (preload or written by the runner). No IDBFS yet.
- `scripts/run-wasm-headless.sh` (or a Node/Playwright runner under `tests/`): runs a demo, collects the `-testdump` file and `log.txt`, and exits with the game's status. Chromium and Playwright are pre-installed (`require('playwright')`, `chromium.launch()`); don't install another Playwright.

### 3. The per-tic state hash (`-testdump FILE`)

- New test-only option. With it, the game writes one fixed-size record per game tic, flushed: the tic number and a 32-bit FNV-1a (or similar) hash of the game state. Without it, nothing changes: no behaviour, no packet, no savegame byte.
- Taken at one fixed point of every tic on every node (say where, file:line), so two machines' files can be compared record for record.
- What goes in the hash, at least:
  - every random-number index or seed the simulation uses (`P_Random`, `B_Random` for the bots (`src/m_random.c:167`, used in `b_game.c`), and any other generator that touches game state; `M_Random`, `m_random.c:122`, should not);
  - every player in game: position, momentum, angle, view height, health, armour, ammo, weapons, the current weapon, powers, cheats;
  - every thinker that is a mobj: type, x, y, z, momentum, angle, health, state number, tics, flags, and the target and tracer as indices (never raw pointers);
  - every sector: floor and ceiling height, light level, special; the moving thinkers (doors, plats, floors, ceilings, lights) where they hold state the sectors don't show;
  - `leveltime`, `gamemap`/`gameepisode`, `gamestate`.
- An optional text dump (`-teststate` or a second file) of the same fields, one line per object, for finding *where* two runs part. Recommended, since the first mismatch will need it.
- The record must not depend on drawing. Check that rendering doesn't touch the simulation (`M_Random` vs `P_Random`, `R_PointInSubsector` callers, anything the renderer writes that `G_Ticker` reads): runs with and without `-nodraw`, and in real time against `-timedemo`, must give the same files. Record what you checked in `code-facts.md`.
- **Fast bounded runs.** Demos play in real time (63-206 s each). `-timedemo` (`src/g_game.c:4528`) runs them as fast as possible but drops to the title loop at the end (`G_CheckDemoStatus`, `src/g_game.c:4580`) instead of quitting. Add a test-only way to quit with status 0 at the end of a timed demo (a new option, or `-testdump` implying it; your call, documented).

### 4. Native against wasm

- `tests/demo-hash.sh`: plays all 11 demos (`testdata/demos/`, three IWADs) on the native build and on the wasm build, and compares the `-testdump` files record for record. The first differing tic is reported, with the `-teststate` lines that differ if you added it.
- Also report, as information (not a pass/fail): whether the `-ffast-math` native build gives the same hashes as the build without it. If they differ, say at which demo and tic.
- The 11 demos are vanilla demos played in compatibility mode, so they may never reach the floats in MBF friction (`p_enemy.c:993-1052`), pushers (`p_spec.c:4268`) or `p_user.c:856-912`. Find a bounded run that does reach Legacy-mode physics if one is cheap (a Legacy-format demo recorded natively, for example with bots: check whether bot ticcmds are recorded). If it isn't cheap, say what it would take, for brief 02.

### 5. Hot join over UDP on loopback

- `tests/net/test-hot-join.sh`: two native instances on one machine.
  - The server starts a game (`-server`, `src/d_net.c:1822`; `-warp`; `-udpport`, `src/i_tcp.c:1512`), with some activity: bots (`addbot`, `src/b_game.c:455`), monsters or both.
  - After some seconds of play, a client joins (`-connect 127.0.0.1`, `-clientport`, `src/i_tcp.c:1526`, `:1548`), receives the savegame (`SV_Send_SaveGame`, `src/d_clisrv.c:2348`; `CL_Load_Received_Savegame`, `:2385`) and plays on.
  - Both run with `-testdump`. Pass: the client's records, from its first tic, equal the server's for the same tics, for at least 30 s of game time after the join; both machines run the game the whole time (not stuck in a wait screen).
  - Bounded: the script stops both and exits by itself. Headless, under the dummy drivers; each instance uses 100% CPU (L7), and the container has 4 cores.
- Also a plain two-player game started together (`-server 2`), if it costs little, as the simpler baseline.
- Say in `code-facts.md` how the join works, step by step, with file:line, and what the client sees while it downloads.

### 6. ASan with recovery

- A build with `-fsanitize=address -fsanitize-recover=address` (and UBSan with `-fno-sanitize-recover` off, or UBSan left out if L9 floods it: your call, say which), run with `ASAN_OPTIONS=halt_on_error=0`, over all 11 demos and the hot-join test.
- Group the reports by site. Each new site goes in `bugs.md` as L13, L14, ..., with file:line, effect and status, following §5 of `PROMPT.md`: queue a fix only if it can crash, freeze or desync a multiplayer game. Don't fix anything in this brief unless the hash or the hot-join test can't work without it; then the smallest fix, said so in `bugs.md` and the Outcome.
- A script for it (`tests/asan-demos.sh` or a mode of `tests/demo-hash.sh`).

### 7. `code-facts.md`

Check every claim in `survey.md`'s Doom Legacy section and mark each **confirmed**, **corrected** (with the right facts) or **not found**, with file:line at this tree. One known correction: the table entry is `I_NetFreeNode`, not `I_NetFreeNodenum` (`src/d_net.c:111`). Add what later briefs need:
- the network driver table and `doomcom`: who calls each function and with what; how nodes are numbered; packet sizes (`MAXPACKETLENGTH` 1450, `i_net.h:52`; `hardware_MAXPACKETLENGTH`; `software_MAXPACKETLENGTH`, `d_clisrv.c:414`) and what has to change for vnet's 1,100 bytes (01);
- the server/client start-up (`-server`, `-connect`, `-dedicated`, `cv_wait_players`), the connect loop, the join, and `Consistency()` (`d_clisrv.c:5614`) with what a consistency fault does (01, 04);
- every blocking loop with file:line, and what each waits on (02);
- every float and libm call reachable from `G_Ticker`, and which of them the demos reach (02, 04);
- whether a savegame (the hot-join payload) is portable between a 64-bit native build and wasm32: pointer-sized fields, `long`, struct dumps, endianness (04: a browser joining a native host);
- where the game looks for WADs and writes its config (03);
- the music path (`I_RegisterSong`, `I_PlaySong`, `qmus2mid.c`) as far as M1 needs it.

### 8. Docs

- `building.md`: the wasm build, the new scripts and tests, with copy-pasteable commands.
- `bugs.md`: new entries.
- `README.md`: the status row for 00 (the coordinator sets the final status).
- This brief's Outcome.

## Out of scope

- A page, the data download, IDBFS, sound and music in wasm (02, 03, M1).
- vnet (01). Any change to the network protocol.
- Fixing upstream bugs beyond the exception in §6.
- Asking upstream whether patches are accepted: SourceForge can't be read from here. Say so in the Outcome; the user can check.

## Acceptance criteria

1. `scripts/build-native.sh` builds without `-ffast-math` by default (shown by the compile line), and can still build with it.
2. `scripts/build-wasm.sh` builds from an empty `EM_CACHE` seeded by `setup-emsdk.sh --with-ports`, with no download.
3. `tests/demo-hash.sh`: all 11 demos give identical `-testdump` files on native and wasm, and every run exits 0 by itself.
4. `-nodraw` and real-time playback give the same files as the default timed run, on at least one demo per IWAD.
5. `tests/net/test-hot-join.sh` passes, and exits by itself.
6. Each new test is shown to fail when what it checks is broken: for example a one-line change to the simulation that runs only under wasm (`#ifdef __EMSCRIPTEN__`) makes `demo-hash.sh` fail at a named tic; a client that skips the savegame load (or loads it one tic late) makes the hot-join test fail. Use throwaway patches; don't commit them.
7. Without `-testdump`, the game behaves as before: the demos still play to their end with status 0 (`scripts/run-headless.sh`), and `tests/sprite-column-oob.sh` still passes 6/6.
8. ASan findings are in `bugs.md`, grouped by site.
9. `code-facts.md` covers every survey claim and the list in §7.
10. No game data in any commit.

## Tests

- New: `tests/demo-hash.sh`, `tests/net/test-hot-join.sh`, the ASan script.
- Existing: `tests/sprite-column-oob.sh` (6/6), `scripts/run-headless.sh` (exit 0).
- Report the counts and times of each.

## Dependencies

The set-up and F1 (done).

## Notes

- **Git:** work on `browser/00-baseline` in `doomlegacy-browser`. Commit at each milestone and push only that branch. Never merge, never touch `claudeai` or `main`, never open a pull request, never force-push. `ext/vnet` and `jfsw-browser` are read-only.
- **Commits** end with the attribution lines the coordinator gives you. No model names in commits or docs.
- Builds use `-j4`. Test data: `scripts/fetch-test-data.sh` (already fetched in the coordinator's container).
- Test-only options must change nothing when they are absent, and must not travel on the wire.
- Report a blocked host; don't work around it.

## Outcome

(to be filled in)
