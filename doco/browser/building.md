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

- `web/index.html`, `web/page.js`, `web/page.css`, copied into `build/wasm/bin` by the build. The page has the canvas, a "Click to start" overlay (the game starts inside the click; so does the audio: the page creates the AudioContext there and gives it to SDL), a progress and status line, and an end state: when the game exits (`I_Quit`, `I_Error`) or the page cannot start, the overlay comes back with the message (the game's own words after an error) and a "Reload the page" button.
- **Dev data loader (brief 03 replaces it):** `?iwad=URL` (same origin only, until brief 03) fetches the IWAD into the game's working directory `/work` (MEMFS) before `main`; the default is `freedoom1.wad` next to the page, which `scripts/serve-wasm.sh` serves from `testdata/`. `legacy.wad` is fetched from next to the page. No cache: every load downloads both.
- The game gets `-home /persist -iwad /work/NAME -nomusic -noendtext -window -width 640 -height 480` (a fixed 640x480 window: the game's default is "fullscreen", which SDL turns into a canvas the size of the browser window). The canvas is scaled to the window, keeping its shape.
- **Files:** `/persist` is IndexedDB (IDBFS), so the config (`/persist/.doomlegacy/config.cfg`) and the saved games survive a reload; the game saves its config when its menu closes (a page can be closed at any moment; upstream saves it only at quit). The page writes to IndexedDB 10 ms after the game closes a file it opened for writing under `/persist` (but not `log.txt`), once a second if anything changed another way, and on `visibilitychange` and `pagehide`; a request during a write is queued. If IndexedDB is unavailable the game still starts and says that saves and settings will not be kept. The working directory `/work` is MEMFS and writable (the join's `$$$.sav` goes there, brief 04).
- **Input:** keyboard; the page keeps the keys the game uses (arrows, Tab, Backspace, page keys, F1 to F11: F5 and F11 are game keys too) from the browser, and leaves F12 and Ctrl+R to it. Mouse: the game asks the page for the mouse while a level plays (not in a menu); the page locks the pointer (pointer lock) at once if the player's last click or key press is recent, else at the next click on the picture, and sends each movement to the game. When the browser takes the pointer back (Escape) the key itself never reaches the page, so the page gives the game an Escape. Sound effects: SDL_mixer through Web Audio; music is off (M1).
- **Test hooks, only with `?test=1`** (listed at the top of `web/page.js`): `args=` (game arguments, JSON array or words), `files=` (URLs fetched into `/work` before the game starts), `persist=0` (no IDBFS: the control run), `home=`, `fast=1` and `fastms=` (test pacing), `audio=dummy`, `video=native`, `nolock=1`, `nofetch=1`; and `window.dlTest` (`FS`, `readFile`, `writeFile`, `listFiles`, `syncNow`), `window.dlState`, `dlExit`, `dlOut`, `dlErr`, `Module.dlFrameLog`, `Module.dlYields`, `window.dlMouse`.
- **Yields.** The game's loops stay (D6) and yield through ASYNCIFY: `code-facts.md` section 6 has every loop and where it yields. In short: one wait for the next display frame (`requestAnimationFrame`) per presented frame and per pass of the main loop; a yield from the event pump after 8 ms without one; a 1 ms timer wait inside the loops that spin on the clock. **Test pacing** (`fast=1`) yields without waiting for a frame, once 20 ms have passed since the last yield, and hides the canvas (a headless Chromium without a GPU reads every presented frame back from WebGL and the game waits for it; hidden, nothing is composited), so `-timedemo` runs as fast as the CPU allows.

### Running it headless

```bash
node tests/tools/run-wasm.js --iwad testdata/doom1.wad --demo testdata/demos/d1demo3.lmp \
     --get o.bin=/tmp/o.bin -- -timedemo d1demo3.lmp -testdump o.bin
```

- It starts headless Chromium (Playwright; do not install another one), serves `build/wasm/bin` and the data files from a local port, and **drives the page that users get** with its test hooks: it opens `index.html?test=1&...`, clicks the start button, waits for the page's end state, and reads the `--get` files from `/work`. The game gets `-home /work -iwad /work/<iwad> -nomusic -noendtext -nosound` and your arguments (the page's `-window -width 640 -height 480` is left out, `video=native`, so that the tests keep drawing the size they drew before the page existed), with the IWAD, `legacy.wad` and the demo in `/work`; its output goes to stdout; the exit status is the game's own (124 on `--timeout`). `--paced` runs at the page's normal pace instead of the test pacing; `--fastms N` changes the yield interval.
- It starts the game with a click sent from the page's own script (`document.getElementById('start').click()`), not with a mouse: the audio is the dummy driver, and a build without ASYNCIFY blocks inside the click until the game ends, which Playwright's click would wait for.
- Why a browser and not Node: the SDL2 port's only video driver is the one for a web page (a canvas, `screen`, gamepad events); under Node `SDL_Init` fails.
- A missing IWAD now ends the game with an error (`bugs.md` L18): the runner reports it and exits 1. `--timeout` is still the net for a game that waits (a demo the game cannot open falls back to the title loop, L4).

## 8. Tests of brief 00

All run from the repository root and need `scripts/build-native.sh` and `scripts/fetch-test-data.sh` (the first four also `scripts/build-wasm.sh`). Each prints one line per check and exits 0 only if everything passed.

| Test | What it does | Time here (4 cores) |
|---|---|---|
| `tests/demo-hash.sh` | All 11 demos, `-timedemo -testdump`, native and wasm, 3 at a time; compares the files record for record and prints the first differing tic and the state lines that differ. `--fast-math` also plays them on `build/native-fastmath` (information only). `--only REGEX`, `--jobs N`. | about 5.5 min (326 s measured; 339 s before brief 02, 354 s after it); 7 min with `--fast-math` (413 s) |
| `tests/draw-independence.sh` | One demo per IWAD, played with `-timedemo`, `-timedemo -nodraw` and `-playdemo` (real time): the three files must be identical. | 90 s |
| `tests/net/test-hot-join.sh` | Two native instances on loopback: the server starts E1M1, a client joins after 10 s, gets the savegame and plays 40 s; their `-testdump` files must agree for every tic both have, from the client's first. `--together` starts both at once (`-server 2`); `--bots` adds two bots with long names (`-testaddbots`, F3; the seed `botgen 1`, `botrandseed 136` gives two 9-letter names, `bugs.md` L24), whose whole state the join carries; `--state N` writes the text state of tic N on both. | 56 s (35 s together) |
| `tests/asan-demos.sh` | Builds `build/asan` (ASan and UBSan, recover on), plays all 11 demos and groups the reports by site; a site not in `tests/asan-known.txt` fails the run. | see `00-baseline.md` |
| `tests/sprite-column-oob.sh` (F1) | 10 s of `-warp 1 1` per IWAD at 8 and 24 bpp. | 60 s |
| `tests/savegame-portable.sh` (F2) | The savegame is the same on native and wasm (section 10). `-testsizes` on both builds: the bytes one record of each sector effect takes, and a write-read-write trip of each, must be the same. 7 demos, 12 saves at chosen tics (doors, platforms, floors, lights, soundtargets): the same save from native and from wasm must be byte for byte the same; every save is loaded by native and by wasm, and the two `-testdump` files of 1,100 tics must be identical, the first record (the state as loaded) equal to the saver's record at the save tic; the same for the first wasm-written save of each demo (`--full`: all). F3 adds a stage `bots` (`--only bots` runs it alone): a bot game (E1M3, skill 4, two bots) played on both builds with and without two saves (tic 1300 and 1700): the games must be identical (saving changes nothing), the saves byte for byte the same on both, and each load, by native and by wasm, must play on identically and start from the state the saver had, bots included. `--only REGEX`, `--jobs N`, `--full`, `--keep`. | 430 s + 150 s for the bots (3 runs at once); 578 s in all before brief 02, 581 s after it |
| `tests/savegame-old.sh` (F2) | The build from before F2 (`git worktree` of `72924ef` outside the tree, built with this tree's `test_dump.c`): its state as loaded differs from the state it saved (the soundtarget, L30) and the new build's does not; the new build loads the old savegame file and plays on; refuses a server's old-layout savegame; the old build refuses the new one; a join between the two builds over UDP prints the reason both ways. `--no-join`, `--old REV`, `--keep`. | about 140 s |
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
| `tests/net/test-relay.sh` | `--bots` (F3): the server adds two bots at tic 10; B joins a game with bots and the three files must agree, which shows that saving the game for B did not change the game the server and A go on with (45 s a run). Own relay on a port the relay picks; a server (`-server 2`), a client that joins at the start, a third player that joins the game in progress after 10 s; every `-testdump` file must agree with the server's for every tic it has, with at least 30 s after the join, no consistency fault in any log. Then the same with `VNET_IMPAIR` on every process (default `lat=30`, a seed per process; it checks that vnet itself logged taking the variable on all three, and, for a spec that names them, that datagrams really were lost, duplicated and reordered). The full spec (`--impair lat=30,jit=10,loss=3,dup=2,reorder=3`) does not pass reliably: the game's join in progress is not robust against reordered or lost packets, over UDP too (`bugs.md` L31, L35); making it pass is fix chunk F4's. The clean case passed 5 of 5. `--clean-only`, `--impair-only`, `--runs N`, `--impair SPEC`, `--dedicated`, `--bin FILE`, `--keep`, `--state FROM TO`. | 45 s per clean case, 50 s per impaired case |
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
| (with `-testdump`) | Prints `TEST: bots in game: N at gametic T` when the number of bots in the level changes: the bot tests require 2 in every log. |
| (at `-testquit`) | Prints `TEST: bot aim calls: N, hash of the aim values H`: how often a bot computed its aim, and a hash of every value. A build with `-DBOT_AIM_COMPARE` (`REAL_CC="gcc -DBOT_AIM_COMPARE" scripts/build-native.sh --build build/aimcmp`) also prints the largest difference from the libm `atan` the aim replaced |

A savegame written headless needs `-nodraw` to be the same on two machines (`bugs.md` L41), and a fresh `-home`: the config file keeps `botrandom`, a network variable that the game changes, and a savegame holds the network variables.

**Builds before F3 and bots.** A build from before F3 and an F3 build cannot play one game with bots: their bots play differently, and an F3 client refuses a join whose savegame has bots without their state (`code-facts.md` §8). Without bots the two join each other as before; but the refusal covers only a savegame that already holds bots (the version is still 10149), so if a bot is added later to a game they share, they part silently.

**Demos and bots (F3, the user's decision of 27 Nov 2026).** The bot code changed in F3 (the player number in `regulate()`, `bugs.md` L45; the table aim, `code-facts.md` §7; `oksector`, L46). A demo recorded with bots before F3 does not play back as recorded: `G_Ticker` still runs the bots during playback and what they do besides the ticcmd (`B_Random`, zeroing the bot's momentum at an edge) stays (L47); it did not even play back the same twice on one build. The 11 demos of `tests/demo-hash.sh` have no bots and are unchanged.

## 11. The browser tests of brief 02

All use Playwright's Chromium (preinstalled; never run `playwright install`) from `tests/web/`, serve `build/wasm/bin` and `testdata/` from a local port (`tests/tools/serve.js`), and need `scripts/build-wasm.sh` and `scripts/fetch-test-data.sh` (`demo-page.js` also `scripts/build-native.sh`). Each prints one line per check and exits 0 only if all passed. `WASM_DIR=DIR` tests another build. Run one at a time.

| Test | What it checks | Time here | Fails when (`NAME_SABOTAGE=...`) |
|---|---|---|---|
| `tests/web/smoke.js` (AC2, and the input and sound parts of AC9) | The blank check on pictures known to be blank. The page loads and offers "Click to start"; the click starts the game; the canvas is not blank (80 colours) and the game runs in a 640x480 window shown 4:3. Escape opens the menu (its skull appears) and Down and Up move the skull. Frames keep coming. The audio device is open, the AudioContext runs and its clock advances, the menu's sound effects reach the audio output (the loudest sample the mixer writes is above 0). The browser's default is prevented for the keys the game uses (F5 and F11 included) and not for F12. The AudioContext is created inside the click and is the one SDL uses. In a level: a click locks the pointer; moving the mouse turns the view and does not when the pointer is released; a release the game asks for does not make up an Escape; a release by the browser (as for Escape) does, and the menu opens. No page error, no `console.error`. | 33 s | `SMOKE_SABOTAGE=blank` (canvas hidden: 1 fails), `lateaudio` (SDL makes the AudioContext, as before the fix: 1), `nokey` (no key sent: 4 fail), `noesc` (1), `nosound` (output silenced: 1), `nomouse` (1), `unlockedmouse` (a hook passes unlocked motion on: 1) |
| `tests/web/demo-page.js` (AC3, AC4's page-played demo, AC5) | Native plays `d1demo3` and `fd1demo4` with `-timedemo -testdump`. The page plays `d1demo3` with `-playdemo -testdump` at its normal pace (one yield per display frame, pointer not locked: `nolock=1`) and the file is identical to the native one, 2,134 records; it differs from the other demo's. While it plays, a 20 ms timer and an animation-frame callback of the page itself run all the time, with no gap over 250 ms after the first second (largest 38 ms and 17 ms). Frame intervals over 62 s: the page's animation frames median 16.7 ms, p95 16.7, p99 16.8, max 16.8; the game's presented frames (35 a second, one or two display frames) median 33.1, p95 34.1, p99 35.2, max 44.6. `DEMO_PAGE_GAPS=1` lists the gaps over 100 ms. | 95 s (63 s of play) | `DEMO_PAGE_SABOTAGE=other` (compares with the other demo's native dump: 1 fails), `block` (the page blocks 400 ms every 5 s: 3 fail), `noyield` (the game yields every 5 s: 2 fail, gaps of 10 s) |
| `tests/web/persist.js` (AC6) | Walk in E1M1, set `soundvolume 7`, `save 3 persisttest` from the console, open and close the menu. Reload in the same browser profile and start with `-loadgame 3`: `config.cfg` and `doomsav3.dsg` are still in `/persist` (the savegame holds its name); the game holds `soundvolume 7` (`saveconfig` writes what it holds); the picture after the load is the saved one (1,568 pixels differ) and not the level's first view (312,911). The control run (`?persist=0`, no IDBFS) loses both: no `config.cfg`, no save, the game holds 15, and `-loadgame 3` finds nothing. | 75 s | `PERSIST_SABOTAGE=nosync` (the page never writes to IndexedDB: 4 fail) |
| `tests/web/exits.js` (AC7) | A quit from the menu (F10, Y): the overlay with "The game has ended.", a reload button, status 0. A missing IWAD URL: "Could not start: nosuch.wad: /nosuch.wad answered 404". An IWAD the game cannot find (the launcher case, L18): the game ends in 0.7 s with `I_Error`, status -1, the page shows "IWAD /work/freedoom1.wad not found / Cannot start the game", and the launcher's "press ESC" loop is not entered. A file that is no IWAD: the same end. `-testquit` ends a running level with status 0. An IWAD URL on another origin is refused with a message. | 13 s | `EXITS_SABOTAGE=silent` (the page ignores the game's exit, in every case: the 4 cases that end through it fail, 10 checks) |

Notes on these:
- **Pointer lock and headless Chromium** (`bugs.md` L58): with the pointer locked this headless Chromium stalls the page for 100 ms to 3 s at a time, a bare WebGL page included, so the pacing is measured with the pointer unlocked (`?test=1&nolock=1`). `DEMO_PAGE_LOCK=1 node tests/web/demo-page.js` lets the page lock it (as a player's click does) and shows it with the game: the animation frames' p95 is 83 ms, p99 200 ms, max 400 ms and the three timing checks fail.
- Playwright's `mouse.move` gives a locked pointer no movement after the first event, so the mouse-look check sends `mousemove` events with `movementX` from the test page, as the browser makes them.
- The screen is read as an element screenshot: reading a WebGL canvas directly gives a blank picture.

**Browser build, ASYNCIFY cost** (measured on `d1demo3`, the same runner): build size and the speed of the demo tests are in the brief 02 Outcome in [`02-emscripten-port.md`](02-emscripten-port.md).
