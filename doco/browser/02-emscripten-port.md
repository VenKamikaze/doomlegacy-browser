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

(to be filled in by the implementer, then the coordinator)
