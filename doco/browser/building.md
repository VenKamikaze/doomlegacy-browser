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
scripts/build-wasm.sh              # build/wasm/bin/doomlegacy.{js,wasm}, 4 jobs, about 25 s from scratch
scripts/build-wasm.sh clean
EM_CACHE=/tmp/cache scripts/build-wasm.sh   # a private Emscripten cache
```

- It needs the emsdk of section 6 (`scripts/setup-emsdk.sh --with-ports`). `EM_CACHE=DIR scripts/setup-emsdk.sh --with-ports` seeds a private cache the same way, which is the clean-cache check: with it empty to begin with, `scripts/build-wasm.sh` builds with no download (the SDL2, SDL2_mixer, Ogg and Vorbis ports come from the seeded cache; it also builds the libraries it needs into the cache once, about 40 s).
- **The upstream Makefile is not used** (the native build is): for SDL it always defines `HWRENDER`, links `-lGL -lGLU` and asks the host's `sdl2-config` for flags, with no switch to leave them out. `scripts/wasm.mk` lists the sources instead: the native build's list without `hardware/*`, `sdl/ogl_sdl.c`, `sdl/hwsym_sdl.c` and `sdl/dosstr.c`, plus `sdl/i_nohwr.c` (stubs for the OpenGL symbols `sdl/i_video.c` refers to without a guard). Software renderer only (D5).
- Flags: `-O2 -fno-strict-aliasing` (upstream's), no `-ffast-math`, `-DLINUX -DSDL2 -DSMIF_SDL -DHAVE_MIXER -sUSE_SDL=2 -sUSE_SDL_MIXER=2`. Not built in: zlib (compressed BSP nodes), libzip (pk3), `dlopen`, IPX. `-Ddetect_music_type=dl_detect_music_type` avoids a clash with the static SDL2_mixer. Link: 2 MB stack, 128 MB initial memory, growth allowed, `-sEXIT_RUNTIME=1`, `MODULARIZE` as `createDoomLegacy`, `FS`, `ENV` and `callMain` exported, `INVOKE_RUN=0`.
- Source changes (D11), all behind `__EMSCRIPTEN__` except the two bug fixes: `src/doomtype.h` (the `strupr`/`strlwr` prototypes), `src/i_tcp.c` (no IPX), `src/m_menu.c` (no `ftw`: the `dirent` code), new `src/sdl/i_nohwr.c`; and `src/w_wad.c`, `src/v_video.c` (a build without `HWRENDER` did not compile, `bugs.md` L13).
- `-testdump` and the rest of the test hooks are in `src/test_dump.c`, built into both.

### Running it headless

```bash
node tests/tools/run-wasm.js --iwad testdata/doom1.wad --demo testdata/demos/d1demo3.lmp \
     --get o.bin=/tmp/o.bin -- -timedemo d1demo3.lmp -testdump o.bin
```

- It starts headless Chromium (Playwright; do not install another one), serves `build/wasm/bin` and the data files from a local port, puts the IWAD, `common/legacy.wad` and the demo in MEMFS under `/work`, runs `callMain` with `-home /work -iwad /work/<iwad> -nosound -nomusic -noendtext` and your arguments, prints the game's output, copies the `--get` files out and exits with the game's status (124 on `--timeout`).
- Why a browser and not Node: the SDL2 port's only video driver is the one for a web page; under Node `SDL_Init` fails (`screen` is not defined; with that faked, the gamepad code fails next). `SDL_AUDIODRIVER=dummy` does exist.
- The game's loop does not return (ASYNCIFY and the yields are brief 02), so the page is blocked until the game exits. That is fine for a test and wrong for a user.
- A missing `legacy.wad` or IWAD leaves the game in the launcher's "press ESC" loop (`bugs.md` L18): always pass `--timeout`.

## 8. Tests of brief 00

All run from the repository root and need `scripts/build-native.sh` and `scripts/fetch-test-data.sh` (the first four also `scripts/build-wasm.sh`). Each prints one line per check and exits 0 only if everything passed.

| Test | What it does | Time here (4 cores) |
|---|---|---|
| `tests/demo-hash.sh` | All 11 demos, `-timedemo -testdump`, native and wasm, 3 at a time; compares the files record for record and prints the first differing tic and the state lines that differ. `--fast-math` also plays them on `build/native-fastmath` (information only). `--only REGEX`, `--jobs N`. | about 5.5 min (326 s measured); 7 min with `--fast-math` (413 s) |
| `tests/draw-independence.sh` | One demo per IWAD, played with `-timedemo`, `-timedemo -nodraw` and `-playdemo` (real time): the three files must be identical. | 90 s |
| `tests/net/test-hot-join.sh` | Two native instances on loopback: the server starts E1M1, a client joins after 10 s, gets the savegame and plays 40 s; their `-testdump` files must agree for every tic both have, from the client's first. `--together` starts both at once (`-server 2`); `--bots` adds a bot (fails today, `bugs.md` L23); `--state N` writes the text state of tic N on both. | 56 s (35 s together) |
| `tests/asan-demos.sh` | Builds `build/asan` (ASan and UBSan, recover on), plays all 11 demos and groups the reports by site; a site not in `tests/asan-known.txt` fails the run. | see `00-baseline.md` |
| `tests/sprite-column-oob.sh` (F1) | 10 s of `-warp 1 1` per IWAD at 8 and 24 bpp. | 60 s |
| `scripts/run-headless.sh` | One demo, without `-testdump`: the game must behave as before and exit 0. | 63-206 s per demo |

Helpers: `tests/tools/testdump-diff.py A B [--common]` compares two `-testdump` files (`--info A` prints the count); `tests/tools/state-diff.py A B` shows the first differing lines of two `-teststate` files with only the fields that differ; `tests/tools/sanitizer-sites.py` groups sanitizer reports; `tests/tools/run-wasm.js` is the headless runner above.

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
| `tests/net/test-relay.sh` | Own relay on a port the relay picks; a server (`-server 2`), a client that joins at the start, a third player that joins the game in progress after 10 s; every `-testdump` file must agree with the server's for every tic it has, with at least 30 s after the join, no consistency fault in any log. Then the same with `VNET_IMPAIR` on every process (`lat=30,jit=10,loss=3,dup=2,reorder=3`, a seed per process; it also checks that the datagrams the spec names really were lost, duplicated and reordered). **The impaired case does not pass reliably yet**: the game's join in progress is not robust against reordered or lost packets, over UDP too (`bugs.md` L31, L35; Outcome of brief 01). The clean case passed 5 of 5. `--clean-only`, `--impair-only`, `--runs N`, `--impair SPEC`, `--dedicated`, `--bin FILE`, `--keep`, `--state FROM TO`. | 45 s per clean case, 50 s per impaired case |
| `tests/net/test-relay.sh --dedicated` | A `-dedicated -server 2` server and two players: the state before the first level only, because a dedicated server crashes when it loads one (`bugs.md` L33) | 45 s |
| `tests/net/test-relay-errors.sh` | Bad arguments, a relay nobody listens on (server, joiner, dedicated), a room that does not exist, a full room (the relay's limit and the game's own `sv_maxplayers`), the relay killed during a game, a silent member dropped by the relay, the host killed, a host that never answers. Each has a time limit and checks the message and what the game does next. `--only REGEX`, `--list`, `--bin FILE`. | about 2 min |

`tests/net/lib.sh` has what both share (the relay, the games, stopping every process they started: a test fails if one had to be killed or is left running). The tests use real time and a full core per game: run nothing else at the same time.

