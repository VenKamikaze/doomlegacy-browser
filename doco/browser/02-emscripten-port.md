# 02: the Emscripten port

## Goal

Single-player Doom Legacy runs in a browser page that stays responsive. The page has:
- the software renderer;
- keyboard and mouse;
- sound effects;
- a config and savegames that survive a reload;
- a minimal page around it.

The game's blocking loops stay and yield to the browser through ASYNCIFY (D6). The wasm build that the page runs must still match the native build tic for tic: `tests/demo-hash.sh`, `tests/savegame-portable.sh` and `tests/bots-native-wasm.sh` keep passing on it.

## Read first

- [`README.md`](README.md): D1, D5, D6, D7, D8, D10, D11.
- [`building.md`](building.md) §6 to §10: the emsdk, `scripts/build-wasm.sh`, `tests/tools/run-wasm.js`, the tests and their times.
- [`code-facts.md`](code-facts.md):
  - §6, the blocking loops: every one of them is in scope here;
  - §9, files, the WAD search and the home directory;
  - §12, the wasm build as it is now.
- [`bugs.md`](bugs.md): L7 (100% CPU with no vsync) and L18 (the launcher's "press ESC" loop).
- The Outcome of [00](00-baseline.md), which made the wasm build, the runner and the hash.
- jfsw-browser's `doco/browser/02-emscripten-port.md` and its Outcome (read-only, `/home/user/jfsw-browser`). That port did the same job for another engine. Reuse what it learned:
  - one yield per presented frame, plus a time-based yield in the event pump;
  - the click-to-start overlay that opens audio inside the click;
  - handling Escape under pointer lock;
  - syncing IDBFS after a write and on page hide;
  - a blank-canvas check that is proved to fail;
  - the frame-time numbers;
  - the ASYNCIFY size and speed cost.

## What is known

- **The build.** `scripts/wasm.mk` already builds `build/wasm/bin/doomlegacy.{js,wasm}`. It uses the software renderer only, with SDL2 and SDL2_mixer from Emscripten's ports. The flags are `-sMODULARIZE=1 -sEXPORT_NAME=createDoomLegacy -sEXIT_RUNTIME=1 -sINVOKE_RUN=0`, and it exports `FS`, `ENV` and `callMain`. There is no ASYNCIFY.
- **How it runs now.** The game runs inside one `callMain` on the page's main thread, and blocks until `I_Quit` (code-facts §12). `tests/tools/run-wasm.js` depends on that.
- **The main loop.** `D_DoomLoop` (`d_main.c:1035`, `while (1)` at `:1086`) runs, per pass, `I_StartFrame`, `TryRunTics`, `D_Display` and `I_UpdateSound`.
- **The event pump** is `I_GetEvent` (`src/sdl/i_system.c:438`, `SDL_PollEvent` at `:460`).
- **The present** is `I_FinishUpdate` (`src/sdl/i_video.c:271`).
- **The clock.** `I_GetTime` (`src/sdl/i_system.c:1544`) reads `SDL_GetTicks`.
- **The other blocking loops**, listed in code-facts §6:
  - the screen wipe busy-waits on the clock;
  - `CL_ConnectToServer` and the repair download poll the network;
  - `Net_Wait_AllAckReceived` spins on the clock;
  - the quit sound waits 2 s;
  - the launcher's ESC loop runs after a missing WAD;
  - `I_Sleep`/`SDL_Delay` are called in level setup, on errors and in video-mode failures.
- **Files** (code-facts §9):
  - `-home DIR` puts the config, the log and the savegames under `DIR/.doomlegacy/`;
  - the join's `$$$.sav` goes to the working directory;
  - `legacy.wad` is in `common/`, and the native build copies it next to the binary;
  - the runner puts the IWAD, `legacy.wad` and the demo in MEMFS under `/work`.
- **Sound** is `src/sdl/i_sound.c`, through SDL_mixer (`HAVE_MIXER`). Music is M1's job: run with `-nomusic`, or with music simply off.

## In scope

### 1. ASYNCIFY and the yields

- Build with `-sASYNCIFY`. Use the defaults, or an `ASYNCIFY_ADD`/`ASYNCIFY_IMPORTS` list if one is needed. Measure the cost and record it in the Outcome: the size of `.wasm`, raw and gzipped, with and without ASYNCIFY, and the time between yields. Keep one build: the page and the tests run the same `.js` and `.wasm`.
- **Yield once per presented frame,** in `I_FinishUpdate` or right after it, paced to the display (`requestAnimationFrame`). Yield also in `I_GetEvent`, after a few milliseconds without a yield, for loops that wait without drawing.
- **Check every loop in code-facts §6 reaches a yield.** None may spin without one. That includes:
  - the wipe;
  - `Net_Wait_AllAckReceived`'s `while(ct == I_GetTime()) {}`;
  - the quit sound;
  - the launcher loop.
- **`I_Sleep`/`SDL_Delay` must yield.** It must not block the page.
- **The `exit()` paths.** `I_Quit`, `I_Error` and the 3 s `I_Sleep` before `exit` (`d_main.c:3695`) must leave the page in a clear "the game has ended" state, with its message and a reload button, not a frozen canvas.
- **The launcher's "press ESC" loop after a missing IWAD** (L18) must not spin forever on the page. Show the error on the page, or let it wait with yields, and say which you chose.
- **The simulation must not change.** The yields change only when the page gets control back. `TryRunTics` already works from `I_GetTime`, so a slow frame runs several tics, as natively. Check that `-timedemo` and the demo-hash tests still produce identical records.

### 2. Test speed

The wasm tests must not become much slower. Today they run `-timedemo` as fast as the CPU allows inside one blocking `callMain`.

- **Pacing for tests.** With rAF pacing, `-timedemo` would be held to the display rate. Give the tests a way to yield without waiting for a frame: for example, a test-only switch that the runner sets, with which a yield is `emscripten_sleep(0)`, or happens only every N ms.
- **Time cost.** Report the time of `demo-hash.sh`, `savegame-portable.sh` and `bots-native-wasm.sh` before and after the change. Keep each within about 1.5 times its current time, or explain why it can't be.
- **The runner.** Adapt `tests/tools/run-wasm.js` to the asynchronous `callMain`. `callMain` returns at the first yield, so the runner must wait for the game's exit: `onExit`, the exit status, the `--get` files and `--timeout`.

### 3. Platform

- **Video:** SDL2's canvas, the 8-bit path the software renderer already uses. The canvas scales to the window and keeps the game's shape.
- **Input:**
  - keyboard, and mouse with pointer lock on a click;
  - Escape must still reach the game, because the browser takes it to leave pointer lock. jfsw-browser has one way to handle it.
  - Don't let browser shortcuts the game uses scroll or navigate the page: arrows, space, Tab, Backspace, F-keys where the browser allows it.
- **Audio:** sound effects through SDL_mixer. Nothing opens the audio device before a user gesture: the page shows a "Click to start" overlay and starts the game, or the audio, inside the click. Music is off (M1).
- **Files:**
  - Config and savegames go on IndexedDB (IDBFS), mounted at the `-home` the page passes.
  - Sync IDBFS after the game writes a file, and on page hide.
  - Load it before `main`.
  - The IWAD and `legacy.wad` are not on IDBFS; brief 03 caches the IWAD.
  - The working directory must be writable, for `$$$.sav` later (04).
  - Find a simple way to know when the game wrote a file, such as a wrap of `FS.close` or a call from the game's own save and config code.
- **Compiled out under `__EMSCRIPTEN__`:** anything that can't work in a browser, such as `fork`, `exec`, threads and the CD-audio code.

### 4. The page

- A plain HTML page in a git-ignored build output, made from sources in the repository (a `web/` directory or similar). It has:
  - the canvas;
  - the click-to-start overlay;
  - a status line, a progress line while loading, and errors shown on the page.
- **Dev data loader, for this brief only:**
  - `?iwad=<url>` fetches the IWAD into MEMFS before `main`. The default is a same-origin `freedoom1.wad` next to the page.
  - `legacy.wad` is fetched from next to the page.
  - Brief 03 replaces this with the real download and cache.
  - Game data is never committed. A local helper script that serves the build with `testdata/` and tells the user the URL is welcome.
- **Test hooks only with `?test=1`.** For example:
  - extra game arguments;
  - files put into `/work` before `main`;
  - the files the game wrote, handed back to the test;
  - the test pacing of §2.
- **The runner.** If the runner can drive this page, or share its loader, so that the tests run what users run, do that. Otherwise say why the two differ and how little.

## Out of scope

- Networking in the browser (04). The wasm build keeps `i_vnet.c` as stubs.
- The data download and cache (03).
- Music (M1).
- WebGL and `HWRENDER` (D5), touch controls, gamepads.
- Any change to the simulation. If a determinism test finds a native-against-wasm difference, **stop and report it**: give the first differing tic and what differs, before you fix it.

## Acceptance criteria

1. **AC1: clean build.** The browser build compiles from a fresh clone with the documented commands, on a clean Emscripten cache (`EM_CACHE=` an empty directory, seeded by `scripts/setup-emsdk.sh --with-ports`). The native build is unchanged.
2. **AC2: smoke test (Playwright).** Chromium and Playwright are preinstalled; **never** run `playwright install`. The test:
   - serves the build and `testdata/freedoom1.wad`;
   - loads the page with `?test=1` and clicks to start;
   - reaches the title or menu, and checks that the canvas is not blank (several distinct colours, read back in a way that works with SDL's canvas);
   - checks that a key reaches the game: the menu changes on a key press, and the check is shown to fail when no key is sent;
   - checks there are no uncaught errors.
   **Prove the blank check works** by showing it fails on a blank or single-colour canvas.
3. **AC3: the page stays responsive.** While a demo plays, the page's own JavaScript runs regularly. For example, a timer or rAF callback on the page counts its calls, and no gap is over 250 ms after load. This proves the yields work.
4. **AC4: determinism.**
   - `tests/demo-hash.sh` passes 11 of 11 on the ASYNCIFY build.
   - `tests/savegame-portable.sh` passes in full, and `tests/bots-native-wasm.sh` is identical.
   - A demo played **by the page itself**, with its normal pacing (rAF), gives the same `-testdump` records as native, unless the runner already is the page (§4). Show it fails when it should, with the dump from another demo.
5. **AC5: frame time.** Measure the frame intervals in Chromium during a demo, at normal pacing, over at least 30 s. Report the median, the 95th and 99th percentile and the largest. The target is a median of about 16.7 ms (60 Hz) with no stalls over 100 ms after load. If headless Chromium in this container can't show that, say what it shows and why.
6. **AC6: persistence (Playwright).** Change a setting and save a game, reload the page, and check both are still there and the game uses them. A control run without IDBFS, a test switch, must lose them.
7. **AC7: exits.** A quit from the menu ends on the "game has ended" state with its message. So does an `I_Error`, for example from a missing IWAD URL or a test argument that triggers one. Show both in a test.
8. **AC8: the other tests still pass.**
   - Every test in `tests/`, natively, as before.
   - `scripts/run-headless.sh` exits 0.
   - `tests/asan-demos.sh` reports 0 new sites.
   - The test times are in the Outcome.
9. **AC9: a person can play.** Someone can play E1M1 of Freedoom in Chromium and Firefox with keyboard, mouse and sound. The coordinator gives the user play-test steps; Firefox isn't in the container.

## Dependencies

00 (the wasm build, the runner, the hash), F2 and F3 (the savegame and bot tests that must keep passing on the new build).

## Notes

- **Git:** branch `browser/02-emscripten-port` from `claudeai`. Commit at each milestone and push only this branch. `ext/vnet` is read-only.
- **Upstream-friendly (D11):** keep changes under `#ifdef __EMSCRIPTEN__` where possible, and put new code in new files (for example `src/sdl/i_web.c`). Don't reformat upstream code.
- **Licences:** anything taken from jfsw-browser's page is the user's own work (GPL there too). Say what was reused.
- **Machine:** 4 cores, and each game uses a whole core. Run one multi-process test at a time.
- **Network:** report a blocked host; don't work around it. Emscripten ports must come from the seeded cache, not a download.
- **Estimate:** about one brief 00.

## Outcome

Status: **done, 27 Nov 2026; the play-test (AC9) is pending** (merged into `claudeai`; a person plays it in Chromium and Firefox). Single-player Freedoom runs in a page that stays responsive, with keyboard, mouse, sound effects, and a config and savegames that survive a reload. `tests/demo-hash.sh` 11 of 11, `tests/savegame-portable.sh` 117 of 117 and `tests/bots-native-wasm.sh` identical on the ASYNCIFY build; the demo tests run within 5 percent of their old time. Not tested: Firefox (not in the container), a real GPU, a real sound card or mouse, a person playing, music (off: M1).

**What landed**

- **Yields (D6), `src/i_web.h`, `src/sdl/i_web.c`.** `-sASYNCIFY`, defaults kept. One wait for the next display frame (`requestAnimationFrame`, or a 100 ms timer if no frame comes; in a hidden tab there is no frame wait, `bugs.md` L59) per presented frame (`I_FinishUpdate`) and per pass of `D_DoomLoop` (`I_Web_PassEnd`: a pass with no new tic would spin, L7); a yield from the event pump after 8 ms without one (`I_Web_Poll`); a 1 ms timer wait in the loops that spin on the clock (the wipe, `Net_Wait_AllAckReceived`, the quit sound: `I_Web_Idle`); `I_Sleep` yields; SDL's own yields (`SDL_Delay`, the buffer swap) are switched off with `SDL_HINT_EMSCRIPTEN_ASYNCIFY` so that every yield is ours. `code-facts.md` section 6 lists every loop and where it yields. **Test pacing** (`?test=1&fast=1`): a yield is a message to the page itself, once 20 ms have passed since the last, and the canvas is hidden (see the findings), so `-timedemo` runs as fast as the CPU allows.
- **Exits.** `exit()` reaches `Module.onExit`: the overlay returns with "The game has ended." (status 0) or "The game stopped with an error (exit status N)" and the game's own words (`Error:` and the lines before it that say what it could not find), and a reload button. The 3 s `I_Sleep` before `exit` is left out under `__EMSCRIPTEN__`. **The launcher's "press ESC" loop (L18): chosen: the game ends.** Under `__EMSCRIPTEN__` a fatal start-up error calls `I_Error("Cannot start the game. See the warnings above.")` instead of showing the console and the launcher, which has nothing to offer in a page; the page shows the warnings. (Both loops would have yielded through `I_FinishUpdate` anyway.)
- **Page, `web/`** (built into `build/wasm/bin` with `legacy.wad`; `scripts/serve-wasm.sh` serves it with `testdata/`): click to start (the page creates the AudioContext inside the click and hands it to SDL as `Module.SDL2.audioContext`; before fix round 1 SDL made it about 700 ms and 23 yields later, outside the click), progress and status line, errors on the page, the canvas scaled to the window (a 640x480 window, shown 4:3), pointer lock, Escape, the keys the game uses kept from the browser, IDBFS at `/persist` (`-home /persist`), the dev data loader (`?iwad=URL`, default `freedoom1.wad` next to the page; `legacy.wad` next to the page), test hooks only with `?test=1` (listed at the top of `web/page.js` and in `building.md` section 7).
- **Mouse.** The game's mouse code warps the pointer, which a page cannot do (L56). `I_GrabMouse` and `I_UngrabMouse` now tell the page (`I_Web_MouseGrab`); the page locks the pointer when the game wants the mouse and the player clicks (or at once if the last click or key press is recent), and sends each movement to `dl_mouse_motion`, which posts the same `ev_mouse` event the relative branch of `I_GetEvent` posts. SDL's own relative mouse mode is not used.
- **Files.** The game saves its config when its menu closes (L55; upstream only at quit). The page writes `/persist` to IndexedDB 10 ms after the game closes a file there (not `log.txt`), once a second as a net, on `visibilitychange` and `pagehide`, with a queue, as jfsw-browser's does.
- **Runner.** `tests/tools/run-wasm.js` now drives the page that users get (`?test=1&fast=1&...`): the tests run what users run, with three differences, all on purpose: the test pacing, the canvas hidden, and the video mode left to the game (`video=native`) so that the tests keep drawing the size they drew before (L57). It waits for the page's end state, not for `callMain`. Same options as before, plus `--paced` and `--fastms`.
- **Compiled out:** nothing needed to be: the build has no `fork`, `exec`, threads or CD-audio code.
- **Tests** (`building.md` section 11): `tests/web/smoke.js`, `demo-page.js`, `persist.js`, `exits.js`.
- **Reused from jfsw-browser** (the user's own work, GPL): the page's overlay, status and error handling; the Escape under pointer lock (`pointerlockchange` without a release by the game: a made-up Escape); the quiet handling of refused pointer lock and audio resume; the IDBFS sync queue with the `FS.close` wrap; the blank-canvas check (an element screenshot, proved on blank pictures); `tests/web/lib.js` helpers. Not reused: the data loader and cache (brief 03), the lobby (brief 04), the Firefox test.
- **Fixed on the way** (`bugs.md`): L7 and L18 for the browser build; new L55 (config saved only at quit), L56 (the mouse code needs warping), L57 (the default "fullscreen" mode is the window), L58 (headless Chromium stalls a page while the pointer is locked: an environment quirk). `tests/asan-known.txt`: the one known `i_system.c` site moved from line 575 to 578 because of the lines added above it (same code).

**Commits** (branch `browser/02-emscripten-port`): `6d293ad` yields, page, runner; `d369aa2` page-managed pointer lock and the browser tests; `07fda3c` docs, asan-known line; the last commit has this Outcome.

**Acceptance criteria**

1. **AC1 clean build: pass.** A fresh `git clone` of the branch, `EM_CACHE=/tmp/cc/emcache` (empty) with `scripts/setup-emsdk.sh --with-ports` (seeded sdl2, ogg, vorbis, sdl2_mixer in 2.7 s) and `scripts/build-wasm.sh`: rc 0 in **37 s**, no "download", "fetch" or "403" in the log, and the page files next to the game. `scripts/build-native.sh` in the clone: rc 0, and the objects of `i_system.c`, `i_video.c`, `d_net.c` and `m_menu.c` are byte for byte the ones of the commit before; `d_main.o` differs only by the `__TIME__` string. **The native build is unchanged.**
2. **AC2 smoke test: pass, `smoke.js` 34 of 34.** Canvas not blank (80 colours); the menu opens on Escape and the skull moves on Down and Up; no error. **The blank check is proved to fail:** it counts the canvas before the game starts, a one-colour and a two-colour picture as blank (and a 12-colour one as not), and `SMOKE_SABOTAGE=blank` hides the canvas after the game drew: `FAIL the canvas is not blank (1 colours ...)`. **The key check fails without a key:** `SMOKE_SABOTAGE=nokey`: the skull never appears, 4 checks fail. Also: audio device open, AudioContext running, sound effects reach the output (`nosound` fails it); pointer lock, mouse look, Escape (`nomouse`, `unlockedmouse`, `noesc` each fail one check).
3. **AC3 responsive: pass.** While the page plays `d1demo3` at its normal pace (62 s), a 20 ms timer and an animation-frame callback of the page itself ran 3,116 and 3,739 times after the first second: **largest gap 38 ms and 17 ms** (limit 250). The check fails when it should: `noyield` (the game yields only every 5 s): gaps of 10 s and 5 s; `block` (the page blocks 400 ms every 5 s): gaps of 407 and 400 ms. With the pointer locked headless Chromium stalls (see AC5).
4. **AC4 determinism: pass.** `tests/demo-hash.sh` **11 of 11 identical** (the same 11 files as before, every run exits 0). `tests/savegame-portable.sh` **117 passed, 0 failed**, 14 saves. `tests/bots-native-wasm.sh` **identical, 2,800 records, 557 aim calls**. **A demo played by the page itself at its normal pace** (`demo-page.js`, `d1demo3`, `-playdemo -testdump`): **identical to the native file, 2,134 records**; it differs from `fd1demo4`'s native dump at tic 1, and `DEMO_PAGE_SABOTAGE=other` (compare with that file) fails the check. No native-against-wasm difference was found, so there is no first differing tic to report.
5. **AC5 frame time: pass for the page, with a caveat for the game and the lock.** Over 62 s of `d1demo3` (after the first second), pointer unlocked, normal pacing, headless Chromium, 4 cores, nothing else running: **the page's animation frames: median 16.7 ms, p95 16.7, p99 16.8, max 16.8** (the page keeps 60 Hz while the game runs). **The game's presented frames: median 33.1 ms, p95 34.1, p99 35.2, max 44.6**: the game draws only when a tic is due (35 a second, `code-facts.md` section 12), so a frame is one or two display frames; no stall over 100 ms. **With the pointer locked** (`DEMO_PAGE_LOCK=1`) headless Chromium here stalls: animation frames p95 83 ms, p99 200, max 400; a bare WebGL page that only uploads a texture and draws it, with the lock granted, gave median 16.7, p95 167, p99 583, max 2,166 (`bugs.md` L58). So the lock is the environment, not the port; a person on real hardware will show whether a real browser does it.
6. **AC6 persistence: pass, `persist.js` 12 of 12.** A setting (`soundvolume 7`) and a saved game survive a reload; the game holds the setting and loads the save (the picture is the saved one, 1,568 pixels differ, against 312,911 from the first view). The control run without IDBFS loses both. **`PERSIST_SABOTAGE=nosync`** (the page never writes to IndexedDB): 4 checks fail.
7. **AC7 exits: pass, `exits.js` 14 of 14.** A quit from the menu ends on "The game has ended." with a reload button. A missing IWAD URL: the page says which file and the 404. A missing IWAD for the game: ends in 0.7 s with the game's words ("IWAD /work/freedoom1.wad not found / Cannot start the game"), status -1, no launcher loop. A file that is no IWAD: the same. `EXITS_SABOTAGE=silent` (the page ignores the exit): 3 fail.
8. **AC8 other tests: pass.** Native, on the rebuilt binary: `draw-independence.sh` PASS (93 s); `sprite-column-oob.sh` 6 of 6 (60 s); `savegame-malformed.sh` 8 of 8 (after the asan-known line fix; 56 s with the ASan build); `bots-level-start.sh` PASS (21 s); `tests/net/test-hot-join.sh` PASS (57 s); `test-relay.sh` PASS (96 s), `--dedicated` PASS (44 s); `test-relay-errors.sh` PASS (143 s); `savegame-old.sh` 12 of 12 (133 s). **`tests/asan-demos.sh`: 53 sites, 53 known, 0 new** (234 s). **`scripts/run-headless.sh --timeout 400`: all 11 demos exit 0**, 63 to 206 s each, as before (its default timeout of 120 s stops the long demos: it exits 124 for `fd1demo1`, as it did). Not a regression: the hot-join comparison inside `asan-demos.sh` (the ASan build, reports only) prints FAIL; the same happens with the ASan build of the commit before this brief.
9. **AC9 a person can play:** pending (steps below).

**Test times, before and after** (4 cores, one test at a time; before = the commit before this brief)

| Test | Before | After |
|---|---|---|
| `tests/demo-hash.sh` (11 demos) | 339 s | 354 s (1.04 times) |
| `tests/savegame-portable.sh` | 578 s | 581 s |
| `tests/bots-native-wasm.sh` | 86 s | 83 s |
| `run-wasm.js`, `d1demo3` `-timedemo -testdump` alone | 14.6 s (14.2 to 14.8) | 15.0 s (14.4 to 15.6); the same build without ASYNCIFY through the new runner 14.3 s |
| new: `tests/web/smoke.js`, `persist.js`, `exits.js`, `demo-page.js` | | 33 s, 75 s, 13 s, 95 s |

(A first measurement, 25 s for `d1demo3`, was the canvas: see the findings.)

**The ASYNCIFY cost** (`-O2`, defaults, `ASYNCIFY_STACK_SIZE` 262,144)

- Size: `doomlegacy.wasm` 2,033,478 bytes without (`NOASYNC=1`, yields compiled out) against 2,782,052 with: **+36.8 % raw, +20.9 % gzipped (853,948 to 1,032,816)**; `doomlegacy.js` 187,102 to 195,652 (gzipped 47,994 to 50,024). The download, `.wasm` and `.js` gzipped, is about 1.08 MB instead of 0.90 MB (plus `legacy.wad` 962 KB and the IWAD). The old build before this brief: `.wasm` 2,033,289, `.js` 180,178.
- Speed: **the demo tests are 3 to 5 percent slower** (15.0 s against 14.3 to 14.6 s above). Time between yields at normal pacing, `d1demo3`, 4,049 yields in 2,000 tics: the game's own work between yields **median 1.2 ms, p95 2.5, p99 3.5, max 79.5 (a level start)**; **rewinding the stack after a yield median 0.1 ms, p99 0.2, max 2.0**; the page's wait median 15.0 ms (a display frame). Under test pacing the work between yields is 20 ms (the setting), rewind the same 0.1 ms.
- Why defaults: with them every function that has an indirect call counts as one that may yield (`-sASYNCIFY_ADVISE=1` lists them), so the renderer and the thinker loops are instrumented; that costs size and almost no speed. `ASYNCIFY_REMOVE` of `R_RenderPlayerView` is **not safe**: it trapped (`unreachable`) at the first frame, because something under it reaches a yield. `ASYNCIFY_IGNORE_INDIRECT` was not tried: the paths from indirect calls to a yield are the menus and the console commands, and listing them by hand would be a risk for 37 percent of size.

**Findings and corrections**

- **A hidden canvas for the tests, and why.** The first ASYNCIFY runs of `d1demo3` took 25 s against 15 s. The game itself was not slower (work between yields 1.2 ms): headless Chromium without a GPU reads every presented frame back from WebGL and the game waits for it (3.6 s of `ReadPixels` waits in 500 tics in a trace), and the old runner never returned to the browser, so it never composited. With the canvas hidden (`display: none`) there is nothing to composite and the time is the old one. Only test pacing hides it; the page a user gets does not.
- **Pointer lock in headless Chromium stalls the page** (`bugs.md` L58). Found while measuring AC3 and AC5: the stalls were first taken for SDL's relative mouse mode, then for the game; a bare WebGL page with a locked pointer showed the same, and the same game without the lock is smooth. The mouse went the page-managed way all the same (the page knows when a user gesture allows the lock, and the test can switch it off with `nolock=1`); the stalls were not the reason. `?nolock=1` is the test switch.
- **Text keys.** Preventing the default of Space's `keydown` stops the browser's `keypress` and with it SDL's text input: a space typed in the console was lost. The page stops those keys (Space, `'`, `/`) at `keypress`, and the page cannot scroll (`overflow: hidden`). SDL, left alone, keeps the default of every key it handles, F5, F11, F12 and Ctrl+R included. Decision (fix round 1, following the brief): F5 and F11 are game keys and are kept from the browser; F12 (developer tools) and Ctrl+R, Ctrl+L are the browser's and the page stops them before SDL sees them.
- `-playdemo` of a bad demo or `-warp 1 99` leave the game in the title loop (L4), as before; the runner's `--timeout` is the net.
- The default `fullscreen "Yes"` made the canvas as large as the window (L57).
- `SDL_AUDIODRIVER=dummy` opens no device in a build without threads ("Couldn't create audio thread startup semaphore"); the game runs without sound. The tests pass `-nosound` anyway.

**Decisions for the coordinator**

1. **ASYNCIFY with the defaults, +37 % on the `.wasm`.** Kept for safety; if download size matters later (brief 03 caches it), trimming is a measured job of its own.
2. **The page locks the pointer, not SDL** (above). If M1 or 04 wants SDL's mouse back, `I_Web_MouseGrab` is the one place.
3. **The launcher is not offered in a browser** (L18): a fatal start-up error ends the game with a message. If you want the launcher's choices (another IWAD, a home) in a page, that is brief 03's data picker, not the launcher.
4. **The config is saved when a menu closes** (L55). A setting changed only from the console is not saved until then. Say if that should be tighter (a save after every `CV_Set` is a bigger change in upstream code).
5. **The page plays in a fixed 640x480 window** (L57); the video-mode menu is untouched and a mode change from it is **not tested**.
6. **The tests hide the canvas and use `nolock=1`** (findings). The numbers that matter for play (AC5 with the lock, a real GPU) need a person on real hardware.
7. **Music is off** (`-nomusic` is always passed); M1 changes that one argument.
8. The game draws 35 frames a second by design; a smoother picture is an interpolation project, not a port one.

**Left over**

- AC9: play-test (steps below), in Chromium and Firefox. Firefox's keyboard, the real Escape and the real pointer lock (headless gave synthetic events and a stalling lock) are the things only a person can check.
- Not tested: a mode change from the video menu; a savegame made in a game with a PWAD (`-file` has no page switch yet); `?iwad=` is limited to the page's own origin until brief 03; the hidden-tab behaviour in a real browser (emulated only: presented frames stop; the throttle numbers are from reading the code and Chrome's documentation, `bugs.md` L59: about 1 tic a second or less, a pause, nothing is lost).
- Brief 04 will meet the hidden-tab problem in lockstep (`bugs.md` L59) and the spin in the connect and repair loops (L60).

**Play-test steps** (Arch Linux, pacman)

```
sudo pacman -S --needed base-devel git unzip python nodejs npm chromium firefox
git clone --recurse-submodules -b claudeai https://github.com/VenKamikaze/doomlegacy-browser
cd doomlegacy-browser
scripts/setup-emsdk.sh --with-ports       # Emscripten 6.0.13 and its ports, about 300 MB, into ~/.cache/doomlegacy-browser/emsdk
scripts/build-wasm.sh                     # about a minute the first time
scripts/fetch-test-data.sh                # Freedoom and the shareware IWAD into testdata/
scripts/serve-wasm.sh                     # prints http://127.0.0.1:8000/
```

Open it in Chromium, then in Firefox. Click "Click to start". Escape opens the menu (Enter selects, arrows move). New Game, a skill, play E1M1: arrows move and turn, Ctrl fires, Space opens doors, 1 to 7 pick weapons. The game takes the mouse when a level plays: click the picture if it has not (the cursor goes), move the mouse to turn, click to fire; Escape gives it back and opens the menu; click again to take it. Check: sound effects; no key scrolls the page; F5 and F11 are the game's (not reload, not full screen); F12 opens the developer tools. Change a setting in Options (a volume), close the menu, save a game (F2, a slot, a name with a space in it), reload the page and load it (F3); check the setting is still there. Quit with F10 and Y: the page says the game has ended and offers a reload. Things only a person can check:

- **The real Escape** with the mouse taken, in both browsers: it should give the mouse back and open the menu once (not twice).
- **Firefox keyboard:** arrows, Ctrl, Shift, Space, number keys, F-keys.
- **Pointer lock:** the mouse look is smooth (headless Chromium here cannot show it), and the click that takes the pointer also fires once.
- **Audio latency:** the game asks for a small buffer; does shooting feel late?
- **A private window:** IndexedDB can be unavailable; the page should start and say that saves and settings will not be kept.
- **Frame time on real hardware:** `node tests/web/demo-page.js` (needs Node.js, Playwright with a Chromium, and a native build) prints the frame intervals; the page's animation frames should stay at about 16.7 ms.
- **Ctrl is the fire key,** so Ctrl+W and Ctrl+Tab close or change the tab: nothing a page can stop.

**Fix round 1** (after the independent review; no blockers)

- **Audio inside the click.** `start()` now makes the `AudioContext` (and resumes it) synchronously in the click and sets `Module.SDL2.audioContext`, which SDL2's Emscripten audio reuses; before, SDL made it about 700 ms and 23 yields later. `smoke.js` checks that exactly one context was made, inside the click, and that it is the one in `Module.SDL2.audioContext` (SDL's); `SMOKE_SABOTAGE=lateaudio` (`?noprime=1`, SDL makes it) fails that check.
- **Hidden tab:** the texts are corrected (`i_web.c`, `code-facts.md` §6, above) and `bugs.md` L59 is the note for brief 04. Emulating `visibilitychange` in headless Chromium shows the presented frames going from 35 a second to 0 (`I_FinishUpdate` returns before `I_Web_Frame`); the throttling itself (1 s or more, once a minute after 5 minutes, hence about 1 tic a second) is from reading the code and Chrome's documentation: headless is never throttled.
- `i_web.c` cites L58 and says any locked pointer stalls headless Chromium. `code-facts.md` §6's `CL_ConnectToServer` and repair rows say the loops spin between tics; `bugs.md` L60 (for brief 04, code unchanged). L61: no mouse in menus, no mouse look with `grabinput 0` or `-devparm`.
- **F5 and F11 are the game's** (prevented, and SDL and the game see them); F12 and Ctrl+R/Ctrl+L stay the browser's. `smoke.js` key list updated.
- `page.js`: `lastSignature` is set only after the IDBFS write succeeds, so the safety net retries. `?iwad=` is same-origin only; `exits.js` case 6 (another origin) ends with "must be on the same origin". `serve.js` answers 400 for an undecodable URL. `scripts/wasm.mk` has a flags stamp (`NOASYNC`, `EXTRA_LDFLAGS`): changing them rebuilds `i_web.o` and relinks (checked: NOASYNC=1, again, then without: 108, 0, 2 compiler runs).
- `EXITS_SABOTAGE=silent` now applies to every case (an init script makes `Module.onExit` do nothing): the 4 cases that end through `onExit` fail, 10 checks (6 passed, 10 failed); the two page-level errors do not go through it.
- **Counts after the round:** `smoke.js` 36 of 36, `exits.js` 16 of 16, `persist.js` 12 of 12, `demo-page.js` 11 of 11, `demo-hash.sh --only 'd1demo3|fd2demo1'` 3 of 3 identical, `bots-native-wasm.sh` identical (2,800 records, 557 aims).

**Review and coordinator verification (27 Nov 2026)**

- Independent review of 0691cab..3b2913a: no blockers; 11 findings (4 documentation, 7 small), all addressed in fix round 1 (746c860) or logged (L61). Re-review of the fix round: all resolved, merge as is. The reviewer confirmed by running them that the L55 and L18 changes are needed (with them reverted, `persist.js` fails 4 checks and `exits.js` 7) and that the yields are sound: no JavaScript-to-wasm entry point can reach a yield, and every change to an existing file is under `__EMSCRIPTEN__` or a macro that is empty natively.
- Two nits from the re-review, left as they are: `fetch` of `?iwad=` follows redirects, so an open redirect on the page's own origin could still fetch a WAD from elsewhere (brief 03 replaces the loader; `redirect: 'error'` would close it); and `smoke.js` checks that F5 and F11 are kept from the browser, not that the game reacts to them (the play-test does).
- Coordinator verification at 746c860, every test one at a time after a clean rebuild:

| Test | Result | Time |
|---|---|---|
| builds: native `--clean`, wasm clean, relay | rc 0 | 13 s, 14 s, 1 s |
| fresh clone, empty `EM_CACHE`, `setup-emsdk.sh --with-ports` and `build-wasm.sh` | rc 0, no download | 38 s |
| `bots-native-wasm.sh` | identical, 2,800 records, 557 aims | 83 s |
| `bots-level-start.sh` | pass | 21 s |
| `savegame-malformed.sh` | 8 of 8 | 56 s |
| `savegame-portable.sh` | 117 of 117 | 581 s |
| `savegame-old.sh` | 12 of 12 | 132 s |
| `test-hot-join.sh`, three modes, with and without `--bots` | 6 of 6 pass | 45-57 s each |
| `test-relay.sh`; `--bots --runs 3`; `test-relay-errors.sh` | pass; pass; pass | 95 s, 284 s, 143 s |
| `sprite-column-oob.sh`, `draw-independence.sh` | pass, pass | 60 s, 93 s |
| `demo-hash.sh` | 11 of 11 | 358 s |
| `tests/web/smoke.js` | 36 of 36 | 33 s |
| `tests/web/demo-page.js` | 11 of 11 (page dump = native, 2,134 records) | 96 s |
| `tests/web/persist.js` | 12 of 12 | 71 s |
| `tests/web/exits.js` | 16 of 16 | 12 s |
| `asan-demos.sh --rebuild` | 53 known, 0 new | 264 s |

  The hot-join run inside `asan-demos.sh` prints FAIL (first difference at tic 436), as it did at F3: that is L29 (a slow joiner diverges, for brief 04); only its sanitizer reports count there.
