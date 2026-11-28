# Building and running

Every command runs from the repository root. Checked on Ubuntu 24.04 (the cloud container) on 19 Nov 2026. The pacman (Arch) path of `scripts/setup.sh` has not been tried yet.

## 1. Clone

```bash
git clone --recurse-submodules -b claudeai https://github.com/VenKamikaze/doomlegacy-browser
```

In an existing clone, `git submodule update --init` fetches `ext/vnet` (pinned to `v0.5.0`, `8572c74`).

## 2. Native dependencies

```bash
scripts/setup.sh
```

This installs a C compiler and make, pkg-config, git, curl, unzip, Python 3, SDL2, SDL2_mixer, zlib, libzip and the OpenGL/GLU headers. It works with apt or pacman, uses sudo when not run as root, and is safe to re-run. Go is only checked, not installed: the vnet relay needs it, and `ext/vnet/relay/go.mod` says which version.

The GL/GLU headers are needed because the upstream SDL build always compiles the optional OpenGL renderer (`-DHWRENDER`, `src/Makefile:920`).

## 3. Native build

```bash
scripts/build-native.sh
```

This produces `build/native/bin/doomlegacy`, with `legacy.wad` copied next to it. It takes about 11 s on 4 cores and gives 11 warnings, all `-Wunused-result` or `-Wdangling-pointer` in upstream code.

- `ext/vnet/src/*.c` (13 files) are compiled in as `vnet-*.o` with vnet's own flags (`-std=c11 -D_POSIX_C_SOURCE=200809L -Iext/vnet/include -Iext/vnet/src`, `-O2 -Wall -Wextra`, through the same compiler wrapper, so without `-ffast-math`), and `src/i_vnet.c` with `-DUSE_VNET`; the rules are the block after `MOBJS` and the one after the `hardware/%.c` rule in `src/Makefile`. Without `ext/vnet` checked out (`git submodule update --init`) `i_vnet.c` is built as stubs that refuse `-relay`.
- The options are in `scripts/make_options_native`: `OS=LINUX SMIF=SDL SDL2=1 HAVE_MIXER=1`, and `ARCH=` empty, because `make_options_nix` defaults to `-march=i686`.
- The script runs the upstream Makefile with `BUILD=build/native MAKE_OPTIONS=scripts/make_options_native`.
  - It runs `make depend` serially first. The dependency rules all write one temp file (`dep/sed.dep`), so they fail under `-j`.
  - Then it compiles with `-j$(nproc)`.
- Other builds:
  - `scripts/build-native.sh --build build/debug -- DEBUG=1` for a debug build;
  - `--clean` to rebuild from scratch.
  - The ASan build is made by `tests/asan-demos.sh` (section 8).
- **No `-ffast-math`.** Upstream adds it unconditionally (`src/Makefile:1357`) and there is no switch. Every flag source (`OPTS`, `OPTINC`, `make_options`) is reset or comes before it, so the build runs the compiler through `scripts/cc-no-fast-math.sh` (`CC_EXPLICIT_CMD`), which puts `-fno-fast-math` last on every command line (`gcc -Q --help=optimizers -ffast-math -fno-fast-math` shows `-funsafe-math-optimizations`, `-ffinite-math-only` and the rest disabled again, and `-fmath-errno` back on). To see it: `CC_WRAP_ECHO=1 scripts/build-native.sh --clean` prints each final command line.
  - `scripts/build-native.sh --fast-math` builds as upstream does, into `build/native-fastmath`, for the comparison in `tests/demo-hash.sh --fast-math`.
  - `REAL_CC` chooses the compiler and may carry flags: `REAL_CC="gcc -g -O0" scripts/build-native.sh --build build/dbg`.
  - `CMakeLists.txt:86` still has `-ffast-math`; the project does not use CMake, so it was left alone.

Running `make` in-tree with no options stops after writing a `make_options` file and asks you to edit it. That is upstream behaviour; the script avoids it.

## 4. Test data

```bash
scripts/fetch-test-data.sh
```

This downloads and verifies two sets of IWADs, then extracts their demo lumps.

| File | Source | Checked against |
|---|---|---|
| `testdata/freedoom1.wad` ("Ultimate FreeDoom"), `testdata/freedoom2.wad` ("FreeDoom") | Freedoom 0.13.0 GitHub release zip | SHA-256 of the zip and of each WAD, recorded on first download (Freedoom publishes none) |
| `testdata/doom1.wad` ("Doom shareware", 1.9) | `https://www.jbserver.com/downloads/games/doom/misc/shareware/doom1.wad.zip` | the published MD5 and SHA-1 ([DoomWiki](https://doomwiki.org/wiki/DOOM1.WAD)), plus SHA-256 of the zip and the WAD |
| `testdata/demos/fd{1,2}demo{1..4}.lmp`, `testdata/demos/d1demo{1..3}.lmp` | the `DEMOn` lumps of those WADs | (taken from verified WADs) |

- `testdata/` is git-ignored, and a second run downloads nothing.
- On any mismatch the script exits 1 and leaves no unverified file behind. A bad WAD that is already there is deleted.
- Options:
  - `--only freedoom|doom1` fetches one set;
  - `--freedoom-zip FILE` and `--doom1-zip FILE` use local copies of the zips;
  - `--dest DIR` writes somewhere else.

Freedoom is BSD-licensed. The shareware WAD may be redistributed unmodified. Which data the public page offers is the user's call (D9).

`scripts/wadlump.py list|extract` lists or extracts WAD lumps (run it with `python3 -I`).

## 5. Headless run

```bash
scripts/run-headless.sh
```

The script runs the game:
- with `SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy`;
- with `-nosound -nomusic -noendtext`;
- in a temporary `-home` that is deleted afterwards (`--home DIR` keeps one), which is also its working directory: the game writes `log.txt` there, and the demo is copied in;
- under a timeout (`--timeout SECS`, default 120; exit status 124 on timeout).

By default it plays `testdata/demos/fd1demo1.lmp` on `freedoom1.wad` with `-playdemo`. At the end of the demo the game quits by itself with status 0 (`G_CheckDemoStatus`: `singledemo` → `I_Quit`, `src/g_game.c:4602`). Options:
- `--iwad`, `--demo FILE|none` and `--bin` choose what runs, for example `--iwad testdata/doom1.wad --demo testdata/demos/d1demo1.lmp`;
- arguments after `--` go to the game, for example `-- -warp 1 1`.

Since F1, the headless run plays the demo to its end and exits 0 on all three IWADs: 63-206 s per demo, in real time. Before F1, every x86_64 build segfaulted as soon as a sprite was drawn (`bugs.md` L1). `tests/sprite-column-oob.sh` is the regression test.

Quirks the script works around (details in [`bugs.md`](bugs.md)):
- `-playdemo` takes only an external file, adds `.lmp` if there is no extension, and first looks the name up as a lump.
- The demo name is cut at 32 bytes.

So the script copies the demo into the game's working directory and passes the bare file name. The demo files have short names that can't match a lump.

## 6. Emscripten

```bash
scripts/setup-emsdk.sh --with-ports
```

```bash
source ~/.cache/doomlegacy-browser/emsdk/emsdk_env.sh
```

- This installs emsdk revision `d7b4130` with Emscripten **6.0.13**, the same pins as jfsw-browser, into `~/.cache/doomlegacy-browser/emsdk` (override with `EMSDK_DIR`). The download is about 300 MB from `storage.googleapis.com`.
- `--with-ports` seeds the **SDL2, SDL2_mixer, Ogg and Vorbis** ports from this repo's `emscripten-ports` branch (override with `PORTS_REPO`), after checking each SHA-512 against the pinned emsdk. That is needed because GitHub archive URLs, where Emscripten would download them, answer 403 in the cloud container.
- SDL2_mixer with MIDI and Ogg: `-sUSE_SDL=2 -sUSE_SDL_MIXER=2 -sSDL2_MIXER_FORMATS='["mid","ogg"]'`. A test program, built from an empty `EM_CACHE` seeded by the script, links in 21 s with no download and prints `SDL_mixer 2.8.0, Mix_Init(MID|OGG) -> 0x30`. The `mid` format is SDL_mixer's built-in Timidity, which needs instrument patches at run time; the project plays music through OPL3 emulation instead (README, Q5), so `mid` is probably not needed in the end.

**Smoke checks (19 Nov 2026):**
- vnet: all 13 `ext/vnet/src/*.c` compile with no warnings under both `gcc` and `emcc`, with `-std=c11 -Wall -Wextra -D_POSIX_C_SOURCE=200809L -Iext/vnet/include -Iext/vnet/src`.
- Game sources: see the next sections; the survey's 100 of 110 files now all build and link.

## 7. The wasm build

```bash
scripts/build-wasm.sh              # build/wasm/bin: the game and the page, 4 jobs, about 30 s from scratch
scripts/build-wasm.sh clean
EM_CACHE=/tmp/cache scripts/build-wasm.sh   # a private Emscripten cache
scripts/serve-wasm.sh              # serves build/wasm/bin and testdata/ on http://127.0.0.1:8000/ (Node.js)
```

- It needs the emsdk of section 6 (`scripts/setup-emsdk.sh --with-ports`). `EM_CACHE=DIR scripts/setup-emsdk.sh --with-ports` seeds a private cache the same way, which is the clean-cache check: with it empty to begin with, `scripts/build-wasm.sh` builds with no download (the SDL2, SDL2_mixer, Ogg and Vorbis ports come from the seeded cache; it also builds the libraries it needs into the cache once, about 40 s).
- **The upstream Makefile is not used** (the native build is): for SDL it always defines `HWRENDER`, links `-lGL -lGLU` and asks the host's `sdl2-config` for flags, with no switch to leave them out. `scripts/wasm.mk` lists the sources instead: the native build's list without `hardware/*`, `sdl/ogl_sdl.c`, `sdl/hwsym_sdl.c` and `sdl/dosstr.c`, plus `sdl/i_nohwr.c` (stubs for the OpenGL symbols `sdl/i_video.c` refers to without a guard) and `sdl/i_web.c` (brief 02, below). Software renderer only (D5).
- Flags: `-O2 -fno-strict-aliasing` (upstream's), no `-ffast-math`, `-DLINUX -DSDL2 -DSMIF_SDL -DHAVE_MIXER -sUSE_SDL=2 -sUSE_SDL_MIXER=2`. Not built in: zlib (compressed BSP nodes), libzip (pk3), `dlopen`, IPX. `-Ddetect_music_type=dl_detect_music_type` avoids a clash with the static SDL2_mixer. Link: 2 MB stack, 128 MB initial memory, growth allowed, `-sEXIT_RUNTIME=1`, `MODULARIZE` as `createDoomLegacy`, `FS`, `ENV`, `IDBFS` and `callMain` exported, `INVOKE_RUN=0`, `-lidbfs.js`, and (brief 02) `-sASYNCIFY -sASYNCIFY_STACK_SIZE=262144` with the defaults for everything else.
- **Make variables:** `BUILD=DIR` (another output directory), `NOASYNC=1` (a copy with the yields compiled out and no ASYNCIFY, only to measure what ASYNCIFY costs; it cannot run in a page), `EXTRA_LDFLAGS=...` (for example `--profiling-funcs`, or `-sASYNCIFY_ADVISE=1` to list what ASYNCIFY instruments and why).
- **What is in `build/wasm/bin`** (all git-ignored): `doomlegacy.js` and `.wasm`; the page from `web/` (`index.html`, `page.js`, `page.css`); and `legacy.wad` (copied from `common/`). Game data is not: the page fetches the IWAD (below).
- Source changes (D11), all behind `__EMSCRIPTEN__` except the two bug fixes: `src/doomtype.h` (the `strupr`/`strlwr` prototypes), `src/i_tcp.c` (no IPX), `src/m_menu.c` (no `ftw`: the `dirent` code), new `src/sdl/i_nohwr.c`; and `src/w_wad.c`, `src/v_video.c` (a build without `HWRENDER` did not compile, `bugs.md` L13). Brief 02 adds new `src/i_web.h` and `src/sdl/i_web.c` (the yields and the mouse), and small `__EMSCRIPTEN__` edits in `sdl/i_system.c`, `sdl/i_video.c`, `d_main.c`, `d_net.c` and `m_menu.c`: `code-facts.md` section 12 lists them.
- `-testdump` and the rest of the test hooks are in `src/test_dump.c`, built into both.

### The page (brief 02)

```bash
scripts/build-wasm.sh && scripts/fetch-test-data.sh
scripts/serve-wasm.sh          # then open http://127.0.0.1:8000/ and click "Click to start"
```

- `web/index.html`, `page.js`, `page.css`, `config.js`, `iwads.js` and `data.js`, copied into `build/wasm/bin` by the build. The page has the canvas, a "Click to start" overlay (the game starts inside the click; so does the audio: the page creates the AudioContext there and gives it to SDL), a progress and status line, and an end state: when the game exits (`I_Quit`, `I_Error`) or the page cannot start, the overlay comes back with the message (the game's own words after an error) and a "Reload the page" button.
- **The game data (brief 03):** `web/config.js` says where it is (default `doom1.wad` next to the page, the shareware IWAD, D14; a second entry for Freedoom 0.13.0 is in the file); `web/data.js` downloads it with a progress bar, checks the size and SHA-256 (`web/iwads.js` is the table of known IWADs and of the engine's IWAD file names), keeps it in an IndexedDB database of its own (`doomlegacy-data`) and writes it into the game's working directory `/work` under the file name the game wants. A reload makes no request for it. "Use your own copy..." (a file picker) takes any IWAD; "Download again" and "Use the download instead" switch. `?iwad=URL` overrides the configured URL (any origin that sends CORS headers). Every failure is a message on the page with the picker and "Try again". `doco/browser/data-hosting.md` says what to serve and how; `code-facts.md` section 14 is the loader's design. `scripts/serve-wasm.sh` serves `testdata/doom1.wad` (and the Freedoom files) next to the page, so the default works locally. `legacy.wad` is fetched from next to the page and not cached by the page.
- The game gets `-home /persist -iwad /work/NAME -nomusic -noendtext -window -width 640 -height 480` (a fixed 640x480 window: the game's default is "fullscreen", which SDL turns into a canvas the size of the browser window). The canvas is scaled to the window, keeping its shape.
- **Files:** `/persist` is IndexedDB (IDBFS), so the config (`/persist/.doomlegacy/config.cfg`) and the saved games survive a reload; the game saves its config when its menu closes (a page can be closed at any moment; upstream saves it only at quit). The page writes to IndexedDB 10 ms after the game closes a file it opened for writing under `/persist` (but not `log.txt`), once a second if anything changed another way, and on `visibilitychange` and `pagehide`; a request during a write is queued. If IndexedDB is unavailable the game still starts and says that saves and settings will not be kept. The working directory `/work` is MEMFS and writable (the join's `$$$.sav` goes there, brief 04).
- **Input:** keyboard; the page keeps the keys the game uses (arrows, Tab, Backspace, page keys, F1 to F11: F5 and F11 are game keys too) from the browser, and leaves F12 and Ctrl+R to it. Mouse: the game asks the page for the mouse while a level plays (not in a menu); the page locks the pointer (pointer lock) at once if the player's last click or key press is recent, else at the next click on the picture, and sends each movement to the game. When the browser takes the pointer back (Escape) the key itself never reaches the page, so the page gives the game an Escape. Sound effects: SDL_mixer through Web Audio; music is off (M1).
- **Test hooks, only with `?test=1`** (listed at the top of `web/page.js`): `args=` (game arguments, JSON array or words), `files=` (URLs fetched into `/work` before the game starts), `persist=0` (no IDBFS: the control run), `home=`, `fast=1` and `fastms=` (test pacing), `audio=dummy`, `video=native`, `nolock=1`, `nofetch=1`; and (brief 03) `raw=1` (with `iwad=`: the file as it is, no checks, no cache), `idb=off` and `idb=quota` (the data cache's IndexedDB is unavailable, or a store fails with `QuotaExceededError`), `sha=js` (the JavaScript SHA-256), `stall=MS`, `window.dlData`, `window.dlStarts`, `window.dlProgress`, `window.dlPersistent`; and `window.dlTest` (`FS`, `readFile`, `writeFile`, `listFiles`, `syncNow`), `window.dlState`, `dlExit`, `dlOut`, `dlErr`, `Module.dlFrameLog`, `Module.dlYields`, `window.dlMouse`.
- **Yields.** The game's loops stay (D6) and yield through ASYNCIFY: `code-facts.md` section 6 has every loop and where it yields. In short: one wait for the next display frame (`requestAnimationFrame`) per presented frame and per pass of the main loop; a yield from the event pump after 8 ms without one; a 1 ms timer wait inside the loops that spin on the clock. **Test pacing** (`fast=1`) yields without waiting for a frame, once 20 ms have passed since the last yield, and hides the canvas (a headless Chromium without a GPU reads every presented frame back from WebGL and the game waits for it; hidden, nothing is composited), so `-timedemo` runs as fast as the CPU allows.

### Running it headless

```bash
node tests/tools/run-wasm.js --iwad testdata/doom1.wad --demo testdata/demos/d1demo3.lmp \
     --get o.bin=/tmp/o.bin -- -timedemo d1demo3.lmp -testdump o.bin
```

- It starts headless Chromium (Playwright; do not install another one), serves `build/wasm/bin` and the data files from a local port, and **drives the page that users get** with its test hooks: it opens `index.html?test=1&raw=1&iwad=...`, clicks the start button, waits for the page's end state, and reads the `--get` files from `/work`. The game gets `-home /work -iwad /work/<iwad> -nomusic -noendtext -nosound` and your arguments (the page's `-window -width 640 -height 480` is left out, `video=native`, so that the tests keep drawing the size they drew before the page existed), with the IWAD, `legacy.wad` and the demo in `/work`; its output goes to stdout; the exit status is the game's own (124 on `--timeout`). `--paced` runs at the page's normal pace instead of the test pacing; `--fastms N` changes the yield interval.
- It starts the game with a click sent from the page's own script (`document.getElementById('start').click()`), not with a mouse: the audio is the dummy driver, and a build without ASYNCIFY blocks inside the click until the game ends, which Playwright's click would wait for.
- **The IWAD goes in as it is** (brief 03's choice): the runner passes `raw=1`, which puts `--iwad`'s file into `/work` under its own name with no check, no hashing and no IndexedDB, as before the loader existed. The demo and savegame tests compare the simulation and must not depend on the loader (their IWADs are the verified `testdata/` files, and the loader has its own tests, `tests/web/data.js`). The runner needs no IndexedDB for the data, and `persist=0` keeps the game's own `/persist` out of it.
- Why a browser and not Node: the SDL2 port's only video driver is the one for a web page (a canvas, `screen`, gamepad events); under Node `SDL_Init` fails.
- A missing IWAD now ends the game with an error (`bugs.md` L18): the runner reports it and exits 1. `--timeout` is still the net for a game that waits (a demo the game cannot open falls back to the title loop, L4).

## 8. Tests of brief 00

All run from the repository root and need `scripts/build-native.sh` and `scripts/fetch-test-data.sh` (the first four also `scripts/build-wasm.sh`). Each prints one line per check and exits 0 only if everything passed.

| Test | What it does | Time here (4 cores) |
|---|---|---|
| `tests/demo-hash.sh` | All 11 demos, `-timedemo -testdump`, native and wasm, 3 at a time; compares the files record for record and prints the first differing tic and the state lines that differ. `--fast-math` also plays them on `build/native-fastmath` (information only). `--only REGEX`, `--jobs N`. | about 5.5 min (326 s measured; 339 s before brief 02, 354 s after it); 7 min with `--fast-math` (413 s) |
| `tests/draw-independence.sh` | One demo per IWAD, played with `-timedemo`, `-timedemo -nodraw` and `-playdemo` (real time): the three files must be identical. | 90 s |
| `tests/net/test-hot-join.sh` | Two native instances on loopback: the server starts E1M1, a client joins after 10 s, gets the savegame and plays 40 s; their `-testdump` files must agree for every tic both have, from the client's first. `--together` starts both at once (`-server 2`); `--bots` adds two bots with long names (`-testaddbots`, F3; the seed `botgen 1`, `botrandseed 136` gives two 9-letter names, `bugs.md` L24), whose whole state the join carries; `--state N` (or `--state "FROM TO"`) writes the text state of those tics on both. F4: `--lossy SPEC` makes both machines' datagrams lossy with `-testimpair` (e.g. `--lossy loss=3,dup=2,reorder=3`; no root; the server's seed is `--seed`, the client's the next one; the script checks from each game's counters that datagrams were lost, duplicated and reordered), `--runs N` runs it N times with the seeds `--seed` to `--seed + N - 1` and prints "k of N passed" and the failed seeds (`--keep DIR` keeps each run's files in `DIR/run-SEED`), `--walk FROM TO` makes the host's player run forward for those game tics (`-testwalk`: a human who is moving at the join, `bugs.md` L53; `--walk 330 400`). The two files are compared as they are just before the games are stopped (a game told to quit takes one more record after it left the level). | 56 s (35 s together); `--lossy`: 57 s a run |
| `tests/net/pause-order.sh` (F4) | `-testpauseorder`: the client's pause code is fed the changes of four server timelines (a pause and an unpause for one gametic, for the next one, and two longer ones) in every order of arrival, each on time, with and without a duplicate of each, with the sequence numbers wrapping in half of them; `paused` before every tic must be what the server had (285 cases). One more: a late older pause after a newer unpause is dropped. `bugs.md` L31. `--bin FILE`. | 1 s |
| `tests/net/servertic-sections.sh` (F4 fix round 1) | `-testservertics`: `servertic_handler` is given tic packets made by hand, split as `SV_Send_Tics` splits a long one (45 ticcmds a datagram), in the orders a lossy link makes: sections in order, swapped, the first again; the packet of 1 tic then the first section of one of 30 from the same tic; the first section of (101, 30), a late (100, 3), the first of (101, 30) again. The ticcmds in the slots must be those sent, and `cl_need_tic` must go only as far as the tics that have come. No network, no timing: it replaces the seeded runs as the proof of `bugs.md` L35 (a seed does not replay a failure). Each case fails with its fix put back. 5 cases. | 0.1 s |
| `tests/net/test-drone.sh` (F4 fix round 1) | A drone (`-left`) connects to a running server: the server must go on making tics (at least 200 in 8 s; 280 with the fix, 35 when the hold of a joiner's tics covers a node that was not sent a savegame). | 16 s |
| `tests/net/test-two-joiners.sh` (F4 fix round 1) | A server with `-testunpausedelay 140`, client A, client B a second later, while the server is paused for A: B must be identical to the server (the savegame holds the pause state). `--gap S`, `--bin`, `--keep`. | 34 s |
| `tests/savegame-f3.sh` (F4) | The build of the revision before F4 (`git worktree` of `14152ce`, outside the tree): it writes a 10149 savegame at tic 1200 of `d1demo3` (a file and the join's), this build writes 10150; this build loads the 10149 file and plays 1,099 tics on; refuses a server's 10149 savegame and the old build refuses 10150 ("Invalid savegame: wrong version"); this build's own savegame loads with the state equal to the saved one and the walking bob (not 0) equal; a join over UDP between the two builds is refused both ways with that message. `--no-join`, `--old REV`, `--keep`. | 134 s |
| `tests/asan-demos.sh` | Builds `build/asan` (ASan and UBSan, recover on), plays all 11 demos and groups the reports by site; a site not in `tests/asan-known.txt` fails the run. | see `00-baseline.md` |
| `tests/sprite-column-oob.sh` (F1) | 10 s of `-warp 1 1` per IWAD at 8 and 24 bpp. | 60 s |
| `tests/savegame-portable.sh` (F2) | The savegame is the same on native and wasm (section 10). `-testsizes` on both builds: the bytes one record of each sector effect takes, and a write-read-write trip of each, must be the same. 7 demos, 12 saves at chosen tics (doors, platforms, floors, lights, soundtargets): the same save from native and from wasm must be byte for byte the same; every save is loaded by native and by wasm, and the two `-testdump` files of 1,100 tics must be identical, the first record (the state as loaded) equal to the saver's record at the save tic; the same for the first wasm-written save of each demo (`--full`: all). F3 adds a stage `bots` (`--only bots` runs it alone): a bot game (E1M3, skill 4, two bots) played on both builds with and without two saves (tic 1300 and 1700): the games must be identical (saving changes nothing), the saves byte for byte the same on both, and each load, by native and by wasm, must play on identically and start from the state the saver had, bots included. `--only REGEX`, `--jobs N`, `--full`, `--keep`. | 430 s + 150 s for the bots (3 runs at once); 578 s in all before brief 02, 581 s after it |
| `tests/savegame-old.sh` (F2) | The build from before F2 (`git worktree` of `72924ef` outside the tree, built with this tree's `test_dump.c`): its state as loaded differs from the state it saved (the soundtarget, L30) and the new build's does not; the new build loads the old savegame file and plays on; refuses a server's old-layout savegame; the old build refuses the new one; a join between the two builds over UDP is refused both ways (since F4 by `NETWORK_VERSION`, "Incompatible client", before a savegame is sent). `--no-join`, `--old REV`, `--keep`. | about 140 s |
| `tests/bots-native-wasm.sh` (F3) | Native and wasm play the same bot game (Freedoom 1 E1M3, skill 4, two bots, no human input, 2,800 tics, both at once) and write `-testdump` files, which must be identical record for record, with the number of aims and a hash of every aim value equal and at least 100 aims. Prints the first differing tic and the parts that differ otherwise. `--tics N`, `--map "E M"`, `--native-bin`, `--wasm-dir`, `--keep`. | about 85 s (86 s before brief 02, 83 s after it) |
| `tests/savegame-malformed.sh` (F3 fix round 1) | A real E4M8 savegame with two bots, its bot section changed (truncated, a path length of 60,000 or 2,000,000, a node outside the grid, a record for a player that is no bot), each loaded with `-testload` under ASan: all must be refused, none may read past the buffer. A netgame savegame without the bot state (what a build before F3 sends) must be refused with a message naming that build; as a savegame file it loads. `--bin FILE` (another ASan build), `--keep`. Builds `build/asan` if it is missing. | about 25 s |
| `scripts/run-headless.sh` | One demo, without `-testdump`: the game must behave as before and exit 0. Its default `--timeout` is 120 s, which the longer demos need more than (`--timeout 400`). | 63-206 s per demo |

Helpers: `tests/tools/dump-at.py A TIC B TIC|first` compares one record of a `-testdump` file with one of another, ignoring the tic (the state as loaded against the state as saved); `tests/tools/run-wasm.js --put FILE[=NAME]` puts a file (a savegame) into the wasm game's `/work` before it starts; `tests/tools/testdump-diff.py A B [--common]` compares two `-testdump` files (`--info A` prints the count); `tests/tools/state-diff.py A B` shows the first differing lines of two `-teststate` files with only the fields that differ; `tests/tools/sanitizer-sites.py` groups sanitizer reports; `tests/tools/run-wasm.js` is the headless runner above.

The state hash itself (`-testdump FILE [-teststate FROM [TO]]`, what is in it and what is not) is in [`code-facts.md`](code-facts.md) section 11. Test-only: without the option nothing changes.

## 9. The relay and the network tests of brief 01

```bash
scripts/build-relay.sh        # build/relay/vnet-relay (Go 1.24; modules from the Go proxy; about 1 s when cached)
```

The relay is built outside the source tree and is never committed. Run it by hand with `build/relay/vnet-relay -udp 127.0.0.1:7777 -http "" -v` (the first line it prints, `LISTEN udp=...`, has the port; `-udp 127.0.0.1:0` picks a free one). Flags worth knowing: `-max-members N` (default 8), `-keepalive` and `-session-timeout` (default 5 s and 15 s). `ext/vnet/relay/README.md` has the rest.

**Playing through it** (every player, native):

```bash
build/native/bin/doomlegacy -iwad testdata/freedoom1.wad -relay 127.0.0.1:7777 -server 2 -warp 1 1   # creates a room and prints: vnet: room code ABC234 (you are 10.0.0.1; the room takes 8 players)
build/native/bin/doomlegacy -iwad testdata/freedoom1.wad -relay 127.0.0.1:7777 -connect ABC234       # joins it; joining a game in progress works too
```

- `-relay HOST:PORT` is the relay's UDP address; a host name is resolved once, at start-up. With `-server [N]` or `-dedicated` the machine creates the room and is the server (`10.0.0.1`); with `-connect CODE` it joins the room and connects to its server. `-connect` with no code (the LAN search) is refused. `-udpport` is the server's port, as over UDP; a joiner needs the same one.
- `VNET_IMPAIR="lat=30,jit=10,loss=3,dup=2,reorder=3,seed=N"` in a process's environment makes vnet delay, lose, duplicate and reorder what that process sends; give each process its own `seed`. The game prints the impairment it found when it opens the room, and when it leaves the room a line with what vnet did (`vnet: closed ...: sent N datagrams (impairment lost .., duplicated .., reordered ..) ...`).
- Messages go to stdout (flushed) and to the console, each starting `vnet:`. How a failure ends: `code-facts.md` §13.

| Test | What it does | Time here (4 cores) |
|---|---|---|
| `tests/net/test-relay.sh` | `--bots` (F3): the server adds two bots at tic 10; B joins a game with bots and the three files must agree, which shows that saving the game for B did not change the game the server and A go on with (45 s a run). Own relay on a port the relay picks; a server (`-server 2`), a client that joins at the start, a third player that joins the game in progress after 10 s; every `-testdump` file must agree with the server's for every tic it has, with at least 30 s after the join, no consistency fault in any log. Then the same with `VNET_IMPAIR` on every process (default `lat=30,jit=10,loss=3,dup=2,reorder=3`, a seed per process; it checks that vnet itself logged taking the variable on all three, and, for a spec that names them, that datagrams really were lost, duplicated and reordered). The default spec is `lat=30,jit=10,loss=3,dup=2,reorder=3` again since F4 (brief 01 had narrowed it to `lat=30` because the join in progress was not robust against reordered or lost packets, `bugs.md` L31, L35; before F4's fixes 1 of 5 impaired runs passed with the full spec). The clean case passed 5 of 5. `--clean-only`, `--impair-only`, `--runs N`, `--impair SPEC`, `--dedicated`, `--bin FILE`, `--keep`, `--state FROM TO`. | 45 s per clean case, 50 s per impaired case |
| `tests/net/test-relay.sh --dedicated` | A `-dedicated -server 2` server and two players: the state before the first level only, because a dedicated server crashes when it loads one (`bugs.md` L33) | 45 s |
| `tests/net/test-relay-errors.sh` | Bad arguments, a relay nobody listens on (server, joiner, dedicated), a room that does not exist, a full room (the relay's limit and the game's own `sv_maxplayers`), the relay killed during a game (also with a `-dedicated` server), a silent member dropped by the relay, the host killed, a host that never answers. Each has a time limit and checks the message and what the game does next. `--only REGEX`, `--list`, `--bin FILE`. | about 2 min |

`tests/net/lib.sh` has what both share (the relay, the games, stopping every process they started: a test fails if one had to be killed or is left running). The tests use real time and a full core per game: run nothing else at the same time.

## 10. The savegame test options (brief F2)

Test-only, like `-testdump`: all in `src/test_dump.c`, called from `TestDump_Tic` (every tic) and `TestDump_Init`; nothing changes without them and nothing goes on the wire. Written so that a build from before F2 compiles them with this file copied in (`tests/savegame-old.sh` does that).

| Option | What it does |
|---|---|
| `-testsave TIC FILE [game]` | At game tic TIC (the tic of the `-testdump` record, so after the tic ran), right after that record, writes to FILE what the join sends: `P_Savegame_Write_header( NULL, 1 )` and `P_Savegame_Save_game()`. With `game` the header of a savegame file instead. May be given many times. Prints `TEST: save holds: mobj N ceiling N ...`: the thinkers of each type and the sectors with a soundtarget, as the game counted them |
| `-testquit TIC` | Quits with status 0 at tic TIC, after the above |
| `-testload FILE` | At the first tic loads FILE as a joining client does (`P_Savegame_Read_header`, `P_Savegame_Load_game`, a header of either kind) and plays on with no input, as fast as the single-player server runs (real time), nothing drawn. The first record is the state as loaded. With `-timedemo DEMO` or `-playdemo DEMO` the game keeps what the demo set up (demo version, compatibility switches, `mobjinfo` changes: a savegame taken in a demo needs them) and takes over from it at the first tic; without, it is a plain single-player game. Prints `TEST: load holds: ...` |
| `-testsizes` | Prints `size NAME BYTES roundtrip ok|FAIL` for each sector effect and quits: the bytes one record takes in a savegame, and whether a record whose every byte is set survives write, read, write |
| `-testcensus` | Prints the census of the thinkers each time a count reaches a new maximum in the run (what a run produces) |
| `-testaddbots TIC N` (F3) | On the server, at game tic TIC, adds N bots as the console command `addbot` does. `+addbot` on the command line runs before the level starts and the first bot takes the host's own player slot (`bugs.md` L48). With `+botgen 1 +botrandseed 136` the names of players 1 and 2 are 9 letters (`bugs.md` L24) |
| `-testimpair SPEC` (F4) | Makes this machine's own outgoing datagrams lossy in any network driver, with no root: `HSendPacket` sends through it in place of `I_NetSend`, resends included. SPEC is a comma list of `loss=P`, `dup=P`, `reorder=P` (percent of the datagrams) and `seed=N`. A lost datagram is not sent, a duplicated one is sent twice, a reordered one is held and sent after 1 to 3 later ones (four can be held). Off without the option. The same seed rolls the same dice in the same order, so which datagram each roll hits depends only on how many this machine has sent (timing makes the runs differ: a failing seed is a probability, not a replay). Prints `TEST: impair: loss ..., seed N` at the start and `TEST: impair: of N datagrams: lost .., duplicated .., reordered ..; M sent` when the connection closes. `tests/net/test-hot-join.sh --lossy` uses it |
| `-testwalk FROM TO` (F4) | The local player's ticcmds, built for game tics FROM to TO-1, run forward (`forwardmove` 50): a human who is moving at the join, with no input device |
| `-testpauseorder` (F4) | Runs the check of `tests/net/pause-order.sh` at start-up and exits with its number of failures |
| (with `-testdump`) | Prints `TEST: bots in game: N at gametic T` when the number of bots in the level changes: the bot tests require 2 in every log. |
| (at `-testquit`) | Prints `TEST: bot aim calls: N, hash of the aim values H`: how often a bot computed its aim, and a hash of every value. A build with `-DBOT_AIM_COMPARE` (`REAL_CC="gcc -DBOT_AIM_COMPARE" scripts/build-native.sh --build build/aimcmp`) also prints the largest difference from the libm `atan` the aim replaced |

A savegame written headless needs `-nodraw` to be the same on two machines (`bugs.md` L41), and a fresh `-home`: the config file keeps `botrandom`, a network variable that the game changes, and a savegame holds the network variables.

**Builds before F3 and bots.** A build from before F3 and an F3 build cannot play one game with bots: their bots play differently, and an F3 client refuses a join whose savegame has bots without their state (`code-facts.md` §8). Without bots the two join each other as before; but the refusal covers only a savegame that already holds bots (the version is still 10149), so if a bot is added later to a game they share, they part silently.

**Demos and bots (F3, the user's decision of 27 Nov 2026).** The bot code changed in F3 (the player number in `regulate()`, `bugs.md` L45; the table aim, `code-facts.md` §7; `oksector`, L46). A demo recorded with bots before F3 does not play back as recorded: `G_Ticker` still runs the bots during playback and what they do besides the ticcmd (`B_Random`, zeroing the bot's momentum at an edge) stays (L47); it did not even play back the same twice on one build. The 11 demos of `tests/demo-hash.sh` have no bots and are unchanged.

## 11. The browser tests of brief 02

All use Playwright's Chromium (preinstalled; never run `playwright install`) from `tests/web/`, serve `build/wasm/bin` and `testdata/` from a local port (`tests/tools/serve.js`), and need `scripts/build-wasm.sh` and `scripts/fetch-test-data.sh`. Since brief 03 the page's default IWAD is the shareware `doom1.wad`, so the tests that need Freedoom pass `iwad=/freedoom1.wad` (`demo-page.js` also `scripts/build-native.sh`). Each prints one line per check and exits 0 only if all passed. `WASM_DIR=DIR` tests another build. Run one at a time.

| Test | What it checks | Time here | Fails when (`NAME_SABOTAGE=...`) |
|---|---|---|---|
| `tests/web/smoke.js` (AC2, and the input and sound parts of AC9) | The blank check on pictures known to be blank. The page loads and offers "Click to start"; the click starts the game; the canvas is not blank (80 colours) and the game runs in a 640x480 window shown 4:3. Escape opens the menu (its skull appears) and Down and Up move the skull. Frames keep coming. The audio device is open, the AudioContext runs and its clock advances, the menu's sound effects reach the audio output (the loudest sample the mixer writes is above 0). The browser's default is prevented for the keys the game uses (F5 and F11 included) and not for F12. The AudioContext is created inside the click and is the one SDL uses. In a level: a click locks the pointer; moving the mouse turns the view and does not when the pointer is released; a release the game asks for does not make up an Escape; a release by the browser (as for Escape) does, and the menu opens. No page error, no `console.error`. | 33 s | `SMOKE_SABOTAGE=blank` (canvas hidden: 1 fails), `lateaudio` (SDL makes the AudioContext, as before the fix: 1), `nokey` (no key sent: 4 fail), `noesc` (1), `nosound` (output silenced: 1), `nomouse` (1), `unlockedmouse` (a hook passes unlocked motion on: 1) |
| `tests/web/demo-page.js` (AC3, AC4's page-played demo, AC5) | Native plays `d1demo3` and `fd1demo4` with `-timedemo -testdump`. The page plays `d1demo3` with `-playdemo -testdump` at its normal pace (one yield per display frame, pointer not locked: `nolock=1`) and the file is identical to the native one, 2,134 records; it differs from the other demo's. While it plays, a 20 ms timer and an animation-frame callback of the page itself run all the time, with no gap over 250 ms after the first second (largest 38 ms and 17 ms). Frame intervals over 62 s: the page's animation frames median 16.7 ms, p95 16.7, p99 16.8, max 16.8; the game's presented frames (35 a second, one or two display frames) median 33.1, p95 34.1, p99 35.2, max 44.6. `DEMO_PAGE_GAPS=1` lists the gaps over 100 ms. | 95 s (63 s of play) | `DEMO_PAGE_SABOTAGE=other` (compares with the other demo's native dump: 1 fails), `block` (the page blocks 400 ms every 5 s: 3 fail), `noyield` (the game yields every 5 s: 2 fail, gaps of 10 s) |
| `tests/web/persist.js` (AC6) | Walk in E1M1, set `soundvolume 7`, `save 3 persisttest` from the console, open and close the menu. Reload in the same browser profile and start with `-loadgame 3`: `config.cfg` and `doomsav3.dsg` are still in `/persist` (the savegame holds its name); the game holds `soundvolume 7` (`saveconfig` writes what it holds); the picture after the load is the saved one (1,568 pixels differ) and not the level's first view (312,911). The control run (`?persist=0`, no IDBFS) loses both: no `config.cfg`, no save, the game holds 15, and `-loadgame 3` finds nothing. | 75 s | `PERSIST_SABOTAGE=nosync` (the page never writes to IndexedDB: 4 fail) |
| `tests/web/exits.js` (AC7) | A quit from the menu (F10, Y): the overlay with "The game has ended.", a reload button, status 0. A missing IWAD URL: the page's data error (state `nodata`, with the picker and "Try again"): "...nosuch.wad answered 404 Not Found", the game not started. An IWAD the game cannot find (the launcher case, L18): the game ends in 0.7 s with `I_Error`, status -1, the page shows "IWAD /work/freedoom1.wad not found / Cannot start the game", and the launcher's "press ESC" loop is not entered. A file that is no IWAD, handed to the game as it is (`raw=1`: the page's own loader would refuse it): the same end. `-testquit` ends a running level with status 0. An IWAD URL on another origin that does not answer: a data error with the CORS hint. | 13 s | `EXITS_SABOTAGE=silent` (the page ignores the game's exit, in every case: the 4 cases that end through it fail, 10 checks) |
| `tests/web/data.js` (brief 03: AC1 to AC8) | Against `tests/web/data-server.js` (gzip, ETags, CORS on or off, errors, short files, dropped connections, a stall; it records every request). First load: more than one progress report, the game reports "Doom shareware", the picture is not blank, the file is in the cache with its size, SHA-256 and ETag. Reload: no request for the IWAD, the game starts. Bad files (a flipped byte, a short file, a dropped connection, random bytes, a text file): a message that names the URL and says what is wrong, no start, nothing cached, the picker and "Try again" offered, and the right file then loads. 404, 403, 500; another origin without CORS headers (the CORS hint) and with them; gzip with progress; the file picker (shareware, Freedoom as `mydata.wad`, an IWAD not in the table, a text file, a PWAD and a cut-off IWAD refused; a reload; "Use the download instead"); a quota failure and no IndexedDB, by the hooks and for real (indexedDB undefined; a 1 MB quota set through the devtools protocol); a changed URL, size or hash; `?iwad=` keeping the configured copy; "Download again"; `revalidate`; a stalled download; the JavaScript SHA-256; hooks inert without `?test=1`; markup shown as text. | 46 s | `DATA_SABOTAGE=nocache` (the loader ignores its cache: 5 fail, then the run aborts; more switches in the test's header and the Outcome's fix round 1), `nohash` (no SHA-256 check: 6 fail, then the run aborts), `nolocal` (a picked file is not cached: 3 fail, then it aborts) |
| `tests/web/iwad-table.js` (AC9) | `web/iwads.js` agrees with `scripts/fetch-test-data.sh` (the SHA-256 of each file) and with the files in `testdata/` (size and SHA-256); `config.js`'s default is the shareware entry and its example the Freedoom one; the engine's IWAD names equal `d_main.c`'s and `classify()` agrees with the game table's key, required and rejected lumps. No browser. | 0.3 s | `IWAD_TABLE_SABOTAGE=1` (a digit of a hash changed: 3 fail; `names`, `classify`: 1 and 7) |

Notes on these:
- **Pointer lock and headless Chromium** (`bugs.md` L58): with the pointer locked this headless Chromium stalls the page for 100 ms to 3 s at a time, a bare WebGL page included, so the pacing is measured with the pointer unlocked (`?test=1&nolock=1`). `DEMO_PAGE_LOCK=1 node tests/web/demo-page.js` lets the page lock it (as a player's click does) and shows it with the game: the animation frames' p95 is 83 ms, p99 200 ms, max 400 ms and the three timing checks fail.
- Playwright's `mouse.move` gives a locked pointer no movement after the first event, so the mouse-look check sends `mousemove` events with `movementX` from the test page, as the browser makes them.
- The screen is read as an element screenshot: reading a WebGL canvas directly gives a blank picture.

**Browser build, ASYNCIFY cost** (measured on `d1demo3`, the same runner): build size and the speed of the demo tests are in the brief 02 Outcome in [`02-emscripten-port.md`](02-emscripten-port.md).

## 12. Browser netplay (brief 04)

The wasm build links vnet (`scripts/wasm.mk` builds `ext/vnet/src/*.c` and `i_vnet.c` with `-DUSE_VNET`, links `-lwebsocket.js`; `flags.stamp` has `VNET=yes|no`). A fresh clone builds it with an empty `EM_CACHE` as before (about 25 s from scratch on 4 cores, no download).

**Playing by hand** (a relay, the page, and a native player; ports are yours to pick):

```bash
scripts/build-relay.sh && scripts/build-wasm.sh && scripts/build-native.sh && scripts/fetch-test-data.sh
build/relay/vnet-relay -udp 127.0.0.1:7777 -http 127.0.0.1:7778 -origins 127.0.0.1:8000 -v        # terminal 1
scripts/serve-wasm.sh                                                                             # terminal 2: http://127.0.0.1:8000/
# a browser host: open  http://127.0.0.1:8000/?test=1&relay=ws://127.0.0.1:7778/vnet&args=-server%202%20-warp%201%201   (the iwad: add &iwad=/freedoom1.wad)
#   click "Click to start"; the room code is under the picture ("Hosting room ABC234 (WebSocket)") and in the console
# a native joiner:
build/native/bin/doomlegacy -iwad testdata/doom1.wad -relay 127.0.0.1:7777 -connect ABC234
# a browser joiner: the same address with  args=-connect%20ABC234
```

For WebTransport add `-wt 127.0.0.1:4433 -dev-cert` to the relay and read `wt_cert_sha256=` from its `LISTEN` line, then add `&relay_wt=https://127.0.0.1:4433/vnet&relay_cert=HASH` to the page's address (a new hash at every relay start). `&impair=lat=30,jit=10,loss=3,dup=2,reorder=3,seed=7` makes the page's vnet lossy. All of these only work with `?test=1`. A page needs `relay` in `config.js` to offer a network game without them (`data-hosting.md`).

**`tests/web/netplay.js`** (Playwright's Chromium, the native build, a relay of its own per game; run one scenario at a time, the games run in real time and each takes a core):

```bash
node tests/web/netplay.js --list
node tests/web/netplay.js ws wt                 # these
node tests/web/netplay.js --runs 3 impaired     # 3 runs (default 1); no names: every scenario once
```

Every game is Freedoom 1 E1M1, skill 3, at normal page pace (not `fast=1`), `-testdump` on every machine; the test waits until the last machine has 30 s of game time (a late joiner comes after 10 s), snapshots every dump at one moment, and compares each with the host's over the tics both have (`tests/tools/testdump-diff.py --common`). It also checks: every machine logged the same room code and the transport it was given (`relay-ws`, `relay-wt`; a native player `relay-udp`), a late joiner's first record is after tic 100, the game was not idle, no consistency fault, repair, kick, vnet failure or page error in any log, every browser's game exited with status 0, every machine left the room and its longest gap between polls of vnet was under 5 s, no datagram over 1,100 bytes, and (impaired) vnet took the spec on every machine and datagrams were lost, duplicated and reordered. A page is stopped with `window.dlTest.quit()`, which makes the game quit at its next tic (as `-testquit` does), so that it leaves the room and prints vnet's counters.

| Scenario | Machines | Time | What it shows |
|---|---|---|---|
| `ws` | browser host, browser joiner | 34 s | WebSocket |
| `wt` | the same | 34 s | WebTransport (`relay-wt`) |
| `browser-host-native` | browser host, native joiner | 36 to 41 s | |
| `native-host` | native host, browser joiner | 34 s | |
| `hot-join-browser` | browser host and joiner, a second browser joins at about tic 360 | 47 s | |
| `hot-join-native` | native host alone, a browser joins in progress | 45 s | |
| `hot-join-into-browser` | browser host alone, a native joins in progress | 46 s | |
| `impaired`, `impaired-ws` | browser host, browser, native (late), `lat=30,jit=10,loss=3,dup=2,reorder=3` with a seed each, WebTransport or WebSocket | 47 to 49 s | about 150 lost, 80 to 105 duplicated, 135 to 155 reordered datagrams a game |
| `bots` | browser host with two bots (`-testaddbots 10 2`), a browser joins in progress | 46 to 48 s | |
| `errors` | the cases of brief 04 section 5 and bad `-relay` values | 90 to 100 s | below |
| `knobs` | | 18 s | below |
| `connect-spin` | | 80 s | below |

Three runs of each of the ten game scenarios: 30 games, 453 checks, **21 minutes** (1,260 s), all passed. A game takes 34 to 49 s of which about 8 s is the pages starting. **`errors`** (each case: the page's status line and `window.dlNet` say what failed, are not left on "connecting", and the game is still running at its title screen, its dump growing; the bound is the case's, and the measured time in brackets): the relay not listening (20 s; 6.4 s), no such room (10 s; 0.6 s), the room full (10 s; 0.9 s), the relay killed during a game (`-keepalive 1s`; 15 s; host 0.0 s, joiner 1.7 s), a member dropped by the relay (`-session-timeout 3s`, the page frozen for 6 s; 10 s; 2.1 s after it thaws), the host's page closed (30 s; 15.3 s, "Server Timeout"); `-relay` that is no URL, has no host, a port out of range, no path, a space, 200 characters, or is given to a page that has no relay, and `-server 2` on a page with no relay: the game ends with the message on the overlay, exit status not 0. **`knobs`**: without `?test=1` a page with `relay=`, `relay_wt=`, `relay_cert=`, `impair=` and `args=` in its address starts a single-player game, passes the game none of `DL_RELAY`, `DL_RELAY_WT`, `DL_RELAY_CERT`, `VNET_IMPAIR`, and the relay sees nothing; a page whose `config.js` names a relay passes that one and not the address bar's; with `?test=1` the knobs act (`relay-wt`, vnet reports the impairment), and 8 bad values are refused by the page, 3 more by the game. **`connect-spin`**: a native host is stopped (`SIGSTOP`) after it printed its room code, a browser joins and waits 10 s in `CL_ConnectToServer` (`-testconnectpasses` prints the loop's passes a second every 2 s): 350 to 366 passes a second (before the yield: 450,000 to 550,000); Escape ends the loop (the game leaves the room within 3 s and goes on at the title); then 5 joins in progress of a game with 6 bots, timed from entering the room to the first game tic (`NETPLAY_JOIN_RUNS`): median 0.51 s (0.52 s before the yield).

**Failure proofs of the test's own checks** are switches (`NETPLAY_SABOTAGE=nowt|flip|short|noerrpage`, `NETPLAY_GAPMAX=1000`; the header of `netplay.js`); of the source changes, a build with the change reverted (`WASM_DIR=build/wasm-sab/bin node tests/web/netplay.js ...`, built with `scripts/build-wasm.sh BUILD=build/wasm-sab`). The Outcome of brief 04 lists each run.

Other test-only things added: `-testconnectpasses` (`src/test_dump.c`); `window.dlTest.quit()` and `Module.dlQuitNow` (the page asks the game to quit at its next tic); `?relayraw=1` (the page passes the four knobs on unchecked, to test the game's own checks); `window.dlNet` (the page's network status: `{kind, text}`; kind 0 none, 1 connecting, 2 in a room, 3 ended, with the reason).
