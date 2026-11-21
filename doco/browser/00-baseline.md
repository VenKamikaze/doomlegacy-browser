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

Status: **implemented, awaiting review** (21 Nov 2026; branch `browser/00-baseline`).

**What landed** (commits on the branch; the three marked *fix* are in upstream's style, have a message written for upstream and touch no test code, so each can be cherry-picked)

- `dbcda88`: builds without `-ffast-math`; the wasm build; `src/test_dump.c` (`-testdump`, `-teststate`); the headless runner and the file comparers.
- `599febc` *fix* (L15): `P_LoadThings` clears `mapthings`.
- `20a1751`: `tests/demo-hash.sh`, `tests/draw-independence.sh`, `tests/net/test-hot-join.sh`, `tests/asan-demos.sh`, `code-facts.md`, `bugs.md` L13-L20.
- `7d0d491` *fix* (L21): a client applies the server's network pause at the server's gametic.
- `f4a09b7` *fix* (L22): the savegame keeps a mobj's `dropoffz` when it differs from `floorz`.
- `a5e9db4`, `d30b2b9`: the hot-join test finished, the hash settled, ASan sites and `bugs.md` L21-L29.
- Later commits on the branch are docs and the final numbers.

Files: new `scripts/cc-no-fast-math.sh`, `scripts/build-wasm.sh`, `scripts/wasm.mk`, `src/test_dump.c`, `src/test_dump.h`, `src/sdl/i_nohwr.c`, `tests/demo-hash.sh`, `tests/draw-independence.sh`, `tests/asan-demos.sh`, `tests/asan-known.txt`, `tests/net/test-hot-join.sh`, `tests/tools/{run-wasm.js,testdump-diff.py,state-diff.py,sanitizer-sites.py}`, `doco/browser/code-facts.md`. Changed: `scripts/build-native.sh`, `src/Makefile` (one object), `CMakeLists.txt` (one source), `src/doomtype.h`, `src/i_tcp.c`, `src/m_menu.c` (`__EMSCRIPTEN__`), `src/w_wad.c`, `src/v_video.c` (L13), `src/p_setup.c` (L15), `src/p_saveg.c` (L22), `src/d_clisrv.c` (L21 and two test hooks), `src/d_main.c` and `src/g_game.c` (one test hook each).

**The state hash, in short.** `-testdump FILE` writes 28 bytes per game tic: the tic and 32-bit FNV-1a hashes of the random state, the players, every mobj in thinker order (pointers as indices), the sectors, lines and sides, and the sector effects, plus one for all of them with `leveltime` and the game state. `-teststate FROM [TO]` writes the same as text. It is taken in `TryRunTics` right after `G_Ticker`, so every machine takes it at the same point. A timed demo under `-testdump` quits with status 0 at its end. Without the option nothing changes. What is in it, and what is left out and why, is `code-facts.md` section 11.

**Acceptance criteria**

1. **No `-ffast-math` by default.** The upstream Makefile adds it at `src/Makefile:1357` and nothing can come after it except the end of the command line, so `scripts/cc-no-fast-math.sh` (`CC_EXPLICIT_CMD`) appends `-fno-fast-math` to every compile and link. `CC_WRAP_ECHO=1 scripts/build-native.sh` prints `gcc -Wall -O3 -fomit-frame-pointer -ffast-math -fno-strict-aliasing ... -c m_random.c -o ... -fno-fast-math`; the objects differ from the `--fast-math` build (`cmp` on `p_enemy.o`) and `gcc -Q --help=optimizers -ffast-math -fno-fast-math` shows every fast-math option off again. `scripts/build-native.sh --fast-math` builds as upstream does, into `build/native-fastmath`. `CMakeLists.txt:86` is untouched (the project does not use CMake).
2. **Wasm from an empty `EM_CACHE`.** `EM_CACHE=/tmp/t/emcache scripts/setup-emsdk.sh --with-ports` seeds SDL2, SDL2_mixer, Ogg and Vorbis from the `emscripten-ports` branch; then `EM_CACHE=... scripts/build-wasm.sh` builds with no download in **30 s** (the log has no "download", "fetch" or "403"; it builds libogg, libvorbis, SDL2, SDL2_mixer and the Emscripten libraries into the cache first). `build/wasm/bin/doomlegacy.wasm` is 2,007,709 bytes, `doomlegacy.js` 180,178. The build is `scripts/wasm.mk` and not the upstream Makefile (why: `building.md` section 7).
3. **`tests/demo-hash.sh`: 11 of 11 identical, every run exits 0 by itself** (440 s with the fast-math runs, 3 demos at a time on 4 cores). Per demo, native against wasm, records compared:

   | Demo | Records | Native | Wasm |
   |---|---|---|---|
   | `d1demo1` | 5,026 | 28 s | 75 s |
   | `d1demo2` | 3,836 | 23 s | 59 s |
   | `d1demo3` | 2,134 | 12 s | 31 s |
   | `fd1demo1` | 7,117 | 34 s | 90 s |
   | `fd1demo2` | 7,089 | 37 s | 108 s |
   | `fd1demo3` | 6,042 | 27 s | 96 s |
   | `fd1demo4` | 3,136 | 15 s | 43 s |
   | `fd2demo1` | 2,664 | 13 s | 42 s |
   | `fd2demo2` | 5,444 | 28 s | 67 s |
   | `fd2demo3` | 2,743 | 16 s | 47 s |
   | `fd2demo4` | 4,662 | 26 s | 38 s |

   (Times include the start-up; the wasm runs shared the machine with two native runs each.) This took three fixes in the sources the hash exposed: the first run found that the shareware `DEMO1` parts at tic 4,898, the start of E1M5, where native spawned three extra voodoo dolls (L15, fixed); earlier, the hash itself had to learn to leave out fields the game never sets (L16).
4. **Draw and pacing independence: `tests/draw-independence.sh` PASS** (92 s): `d1demo3`, `fd2demo3` and `fd1demo4` (one per IWAD) give identical files with `-timedemo`, `-timedemo -nodraw` and `-playdemo` in real time. Its first version found the one thing the renderer writes that the hash had included: `ML_MAPPED` on lines (`r_segs.c:2750`), which differed at tic 2; it is out of the hash. `code-facts.md` section 11 says what else was checked (`M_Random`, `A_Random`, `N_Random` are drawing-side only).
5. **`tests/net/test-hot-join.sh` PASS in 56 s** and exits by itself: the server starts E1M1 of Freedoom 1, a client joins after 10 s over UDP on loopback, receives the savegame and plays 40 s; **1,441 records identical, tics 356 to 1,796** (the client's first record is the state as loaded, at the server's gametic), no consistency fault or repair in the logs, and the game was not idle (219 distinct `P_Random` states, 16 world states). `--together` (`-server 2`): 1,089 identical records from tic 1, 35 s. It also passes with the four cores busy (apart from one artefact that is now out of the hash). It needed two fixes in the game (L21, L22). With a bot (`--bots`) it fails, on purpose (L23), and bots crash the server on a long name (L24).
6. **Each test fails when what it checks is broken** (throwaway patches, none committed):
   - `demo-hash.sh`: a wasm-only change (`#ifdef __EMSCRIPTEN__`, one `P_Random` index bump at `leveltime` 300 in `P_Ticker`) on `fd2demo1`: `FAIL native != wasm: first difference at tic 300: total, random` and the state line `random prnd=84: prnd: 84 -> 85`.
   - `draw-independence.sh`: a `P_Random()` call in `R_RenderPlayerView` on `d1demo3`: `FAIL timed != nodraw: first difference at tic 2: total, random` (and `timed == real` passes because real time draws every tic too); the same call only when `!singletics`: `FAIL timed != real: first difference at tic 2: total, random` and `timed == nodraw` passes.
   - `test-hot-join.sh`: a client that runs `P_Ticker()` once after loading the savegame (one tic late): `FAIL every tic both files have is identical: first difference at tic 361: total`. Without the L21 fix the first version of the test failed at the first tic in the runs where the race happened (that is how L21 was found), but not in every run: the reviewer reverted the fix and it passed 2 of 3, and the claim made here that it fails "the same way" was too strong. The test now forces the race (a test-only server option `-testunpausedelay 5`) and requires the client's log to show the pause change applied at the server's tic: with the fix reverted it fails 3 of 3 (both that check and the file comparison, first difference at tic 362); see the Fix round.
   - `asan-demos.sh`: a new out-of-bounds read of a four-element static array in `P_Ticker`: `NEW 1x global-buffer-overflow p_tick.c:433 in P_Ticker`, `ubsan p_tick.c:433:58 index N out of bounds`, and exit status 1.
7. **Without `-testdump` the game behaves as before.** `scripts/run-headless.sh` plays all 11 demos to their end with status 0 and no error in the output (4 at a time): `d1demo1` 152 s, `d1demo2` 115 s, `d1demo3` 64 s, `fd1demo1` 207 s, `fd1demo2` 205 s, `fd1demo3` 175 s, `fd1demo4` 93 s, `fd2demo1` 78 s, `fd2demo2` 158 s, `fd2demo3` 81 s, `fd2demo4` 136 s: the same as before (F1's table). `tests/sprite-column-oob.sh`: **6 passed, 0 failed** (60 s).
8. **ASan findings are in `bugs.md`**, grouped by site (below).
9. **`code-facts.md`** covers every claim of the survey (verdict and file:line) and the list of section 7 of the brief: the driver table and `doomcom`, start-up, the join step by step, `Consistency()`, every blocking loop, the floats, savegame portability, file locations, the music path.
10. **No game data in any commit** (`git log --stat` shows only scripts, sources and docs; `testdata/` and `build/` are ignored).

**`-ffast-math` against none.** `tests/demo-hash.sh --fast-math` plays the 11 demos on a native build with upstream's `-ffast-math` as well: **all 11 files are identical to the build without it.** So nothing in the demos is sensitive to it (they reach only `FixedDiv2`'s `double` division of the float code, `code-facts.md` section 7). The flag stays out all the same: the friction, pusher and bot-aiming code that the demos do not reach is where it could matter.

**Reaching the float code.** The 11 demos are vanilla demos in compatibility mode and reach none of MBF friction, pushers or bot aiming. A bounded run that does needs a Legacy-format demo recorded natively (`-record`, version 144 or later, which writes bot ticcmds, `g_game.c:1776`) on a map with friction or pusher sectors and `+addbot` (which crashes on long names, L24: use one bot), or a `-server`/`-connect` pair with a wasm instance on the client side (brief 04). Not done here.

**ASan with recovery** (`tests/asan-demos.sh`: gcc 13.3, `-O3`, `-fsanitize=address,undefined -fsanitize-recover=all -fno-sanitize=alignment`, all 11 demos plus the hot-join test; **every demo exits 0; the script exits 0; 230 to 290 s**). UBSan's alignment check is left out: L9 would flood the logs. 64 sites in all (53 in the 11 demos, 11 more only in the hot-join logs: the savegame code and `p_user.c`), each in `tests/asan-known.txt` with its L number (a site that is not in the file fails the run):
- ASan, 2 sites: `R_RenderSegLoop` reading `finetangent` past its end (`r_segs.c:2448`, L8, all 11 demos) and `CV_monster_OnChange` reading one byte before `monbehav_to_infight` (`p_enemy.c:504`, new, **L26**, every demo at its end).
- UBSan, 62 sites: 47 left shifts of negative or too-large values (L10), 4 signed overflows that are meant to wrap (**L27**), 6 reads past the end of the generated sky's rows (`r_sky.c:189-201`, **L28**, shareware only), 2 more of the `monbehav_to_infight` read (L26) and 3 more of the `finetangent` read in `r_segs.c:2448` (L8).
- ASan cannot see the sprite pad-byte read of L1: the lumps live in the zone heap.
- Nothing in the list can crash, freeze or desync a game, so none is queued.

**Findings that need a decision or a chunk** (all in `bugs.md`)
- **L19, queued: the savegame is not portable between a 64-bit native build and wasm32.** The sector-effect structs are written as raw memory, tail padding included: `ceiling_t` is 40 bytes on x86_64 and 36 on wasm32, `vldoor_t` 32 and 28, `floormove_t` 32 and 28, `elevator_t` 24 and 20, `lightfader_t` 8 and 4 (`code-facts.md` section 8). A browser that joins a native host in progress reads the savegame shifted at the first door or lift. This breaks the case the project is for; it needs a fix chunk before brief 04.
- **L23, user to decide: bots and joining in progress do not mix.** The savegame holds part of a bot's state; the first tic after a join already differs and the client is kicked.
- **L24, queued: `Command_AddBot` overflows a 10-byte buffer** (names are up to 21): a stack-smashing abort on adding a bot with a long name. One-line fix.
- **L29, noted for 04: a much slower client diverges a second after it joins** (ASan builds on both machines; normal builds pass, also under load).
- **L20, noted for 04: bot aiming uses `atan`** (glibc against musl); untested between native and wasm.

**Fixes made in this brief, and why** (each was needed to make the hash or the hot-join test work, per `PROMPT.md` section 5)
- L13: a build without `HWRENDER` did not compile (`w_wad.c`, `v_video.c`): three small edits, needed for the wasm build (D5).
- L15: `memset` of `mapthings` after allocation (`p_setup.c`): needed for the native-against-wasm hash on the shareware `DEMO1`.
- L21: the client applies a `PT_STATE` pause change at the server's gametic (`d_clisrv.c`, 30 lines): needed for the hot-join test; without it every join starts a tic off.
- L22: `dropoffz` saved when it differs from `floorz` (`p_saveg.c`, one line): needed for the same.
Whether upstream already has any of these could not be checked (below).

**For later briefs**
- 01 (vnet): `hardware_MAXPACKETLENGTH` is 512 on the internet path already; `i_vnet.c` replaces `I_Init_TCP_Network` and the seven pointers (`code-facts.md` section 2). `-server`/`-connect` and the node numbers are in section 3.
- 02: the loops to yield in are in `code-facts.md` section 6, with the launcher's "press ESC" loop and the 3 s `I_Sleep` in `I_Error`. The headless runner is `tests/tools/run-wasm.js` (Chromium; Node cannot start SDL video).
- 03: the `$$$.sav` file of the join goes to the working directory; `legacy.wad` must be found at start (section 9).
- 04: L19 (before anything), L23, L29, L20; the hash comparison between a native host and a wasm client is `tests/net/test-hot-join.sh` with one side replaced (`tests/tools/run-wasm.js` can write the dump; the page needs a vnet transport first).
- M1: the music path is `code-facts.md` section 10: `I_RegisterSong` gets the raw lump.
- The hash can be extended (the boss brain, the item respawn queue and FraggleScript are not in it) when a map that uses them is added.

**Not done**
- **Upstream check.** The SourceForge SVN repository still cannot be read from here, so whether a newer revision already fixes L13, L15, L21, L22, L24 or the others is unchecked. To check on a machine with Subversion: `svn cat svn://svn.code.sf.net/p/doomlegacy/code/legacy_one/trunk/src/p_setup.c | sed -n '/P_LoadThings/,/Z_Malloc/p'` and the same for the other files (the repository path is a guess, see the F1 Outcome).
- No `fix/` branch for L15, L21 or L22: pushing a branch from `main` is outside this brief's rules, so each is a single commit on this branch with a message written for upstream. The files are at the repository root's `src/`, so `git format-patch -1 599febc` (L15), `7d0d491` (L21) and `f4a09b7` (L22) give patches with `src/` paths; for the SVN trunk strip that prefix: `git format-patch -1 <hash> --relative=src` makes them trunk-relative (the trunk's files are `src/*` of the SVN tree). L13 is inside `dbcda88` with the rest of that commit; it was not split out.
- The CMake build was not changed.
- The hot-join test runs between two native instances only: a wasm instance cannot reach UDP (brief 01).

### Fix round (21 Nov 2026)

An independent review gave "merge after fixes". Each finding and what was done:

1. **L21 test reliability.** Confirmed: with the fix reverted the test passed 2 of 3. The AC6 sentence above is corrected. The race is now forced: a test-only server option `-testunpausedelay N` (`src/test_dump.c`, nothing on the wire, nothing without it) keeps the network pause N gametics longer so the unpause names a later gametic than the joining client has reached; with `-testdump` the client logs `TEST: pause N applied at gametic G (server's tic T)`, and `tests/net/test-hot-join.sh` requires that line (not in `--together`). With the fix reverted (throwaway build): 3 of 3 runs fail, on that check and on the file comparison (first difference at tic 362). With the fix: 5 of 5 pass.
2. **Stopped crushers and platforms.** Fixed in the hash: `live_thinker()` no longer drops function 0 (stopped platforms and ceilings stay in the thinker list that way), they are numbered, and `hash_effect` tells them apart through `activeplats` and `activeceilings`; the `PLATS_in_stasis` branch is live. Numbering matches across nodes because the savegame loader re-adds them in saved order. Neither the demos nor the hot-join run has one, so this is untested beyond the 11 demos still matching.
3. **Sector `soundtarget`.** In the hash (as a thinker index, `-2` for a stale pointer, never dereferenced). New `bugs.md` L30, **queued, to be fixed with F2**; the save is not touched. The hot-join test cannot see it: nobody fires. Scripted input that would: a host ticcmd that fires a weapon a few tics before the join (the server's `-testdump` then shows a sector `soundtarget` the client lacks).
4. **One pending value.** Replaced by a queue of 4 entries ordered by tic (`CL_Queue_Pause`): an entry for the same tic is replaced, a packet for the current or an earlier gametic is applied at once and drops what it supersedes, and when the queue is full the oldest entry is applied at once and dropped. `code-facts.md` section 11 says what `d_net.c` guarantees (reliable, duplicates dropped, **not** delivered in order) and what a late pause does (applied at once; the client is out by that many tics and the consistency check repairs it).
5. **Pending pause between sessions.** `CL_Clear_Pending_Pause()` is called from `CL_Reset`, `SV_ResetServer`, `D_StartTitle` and wherever the gametic is set from the server (`server_cfg_handler`, the two control messages, the repair message).

Nits: L15 reworded (Legacy mode spawns the players after `P_LoadThings`, `p_setup.c:2453`, so only the old-version path `p_mobj.c:2980` was affected; the fix moves those demos towards vanilla); L26 corrected (index 255 from `G_restore_user_settings`, `g_game.c:3346`, a byte; probably transient); `code-facts.md` section 11 no longer lists `paused` or the bob in the hash; the hot-join `--bots` help points at L23 and the header/code agree (the server's last tic must be within 5 of the client's); the `build-wasm.sh` comment (it was `wasm.mk`'s header that said `emmake`); `wasm.mk` uses `:=` so an environment `CFLAGS` cannot leak in; `-ffp-contract=off` is on the native wrapper and on the wasm flags; `scripts/build-native.sh` keeps a flags stamp in the build directory and rebuilds from scratch when `--fast-math`, `REAL_CC` or the extra variables change; `building.md`'s demo-hash time is 326 s (413 s with `--fast-math`); `demo-hash.sh` has a 240 s native timeout and a wasm timeout of 5 times the native time plus a minute, and refuses empty demo files.

Re-run after the fixes: `tests/demo-hash.sh` 11 of 11 identical in 326 s (and 11 of 11 identical to the `-ffast-math` build, 413 s), `draw-independence.sh` PASS 93 s, `test-hot-join.sh` PASS (default 1,438 identical records, `--together` 1,089), `sprite-column-oob.sh` 6 of 6.
`scripts/run-headless.sh`: `d1demo3` 64 s, `fd2demo3` 81 s, `fd1demo4` 92 s, all exit 0 with no errors. `tests/asan-demos.sh --only 'd1demo3|fd2demo1'` (rebuilt): 43 sites, all known, 0 new, exit 0 (no site moved, so `asan-known.txt` is unchanged; the hot-join part of that script was not run with `--only`).

### Fix round 2 (21 Nov 2026)

1. **Clearing the pause queue when the gametic is rebased lost a pause (a regression of the first fix round).** Confirmed from the code: a repair sends a pause for G and then a repair packet that sets the gametic to G. The four clears (control messages, repair, `server_cfg_handler`) are replaced by `CL_Rebase_Pending_Pause`: apply every queued change at or before the new gametic (the last wins) and keep the later ones. The plain clear stays in `CL_Reset`, `SV_ResetServer` and `D_StartTitle`. **No deterministic test for it**: it needs a test-only way to make the server send a repair (`SV_Send_player_repair`) while a pause for the same gametic is queued on a client that is behind, i.e. a server option that forces a consistency fault (for example `-testfault TIC` perturbing one player's x on the client) and a client held back a few tics; about a day with the repair path's timing. Not done.
2. **Out-of-order `PT_STATE`.** The client remembers the highest server gametic accepted (`pause_high_tic`) and ignores a `PT_STATE` with a lower one (logged as `TEST: ... ignored` with `-testdump`). I chose to reset it only where the queue is truly cleared (`CL_Reset`, `SV_ResetServer`, `D_StartTitle`), not on a rebase: a rebase keeps the session, and a pause that arrived before `PT_SERVERCFG` must still count. Same-gametic pairs need a sequence number: `bugs.md` L31, noted for brief 04 (vnet is unreliable and unordered, `ext/vnet/README.md:17`, so reordering will happen there). The wrong sentence in `code-facts.md` about the consistency check repairing a late pause is corrected.
3. Nits: `build-native.sh` cleans a build directory that has objects but no stamp, and the stamp includes the wrapper's checksum; `demo-hash.sh` checks for an empty demo after the `--only` filter; `test-hot-join.sh --no-force` runs the natural, unforced join (no `-testunpausedelay`, no applied-pause check; run it in addition to the default); the "server kept running" wording matches the check; `build-wasm.sh --help` prints its usage.

Re-run after round 2: `test-hot-join.sh` default PASS (1,449 identical records), `--together` PASS (1,111), `--no-force` PASS; with the L21 fix off (throwaway build) it fails (applied-pause check and file comparison, first difference at tic 370); `tests/demo-hash.sh` 11 of 11 identical, 373 s; `tests/draw-independence.sh` PASS.
