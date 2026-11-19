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

- The options are in `scripts/make_options_native`: `OS=LINUX SMIF=SDL SDL2=1 HAVE_MIXER=1`, and `ARCH=` empty, because `make_options_nix` defaults to `-march=i686`.
- The script runs the upstream Makefile with `BUILD=build/native MAKE_OPTIONS=scripts/make_options_native`.
  - It runs `make depend` serially first. The dependency rules all write one temp file (`dep/sed.dep`), so they fail under `-j`.
  - Then it compiles with `-j$(nproc)`.
- Other builds:
  - `scripts/build-native.sh --build build/debug -- DEBUG=1` for a debug build;
  - `--clean` to rebuild from scratch.
- The build keeps upstream's `-ffast-math` (`src/Makefile:1357`). Removing it is part of the determinism work.

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

**State on 19 Nov 2026: the x86_64 build segfaults** as soon as the player's weapon sprite is drawn, with a demo or a `-warp`, on all three IWADs, `doom1.wad` included. See [`bugs.md`](bugs.md) L1. Until that is fixed, the headless run ends with status 139 after about 2 s. The title loop alone runs, and is stopped by the timeout.

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
- Game sources: `emcc -sUSE_SDL=2 -DSDL2 -DSMIF_SDL -DLINUX -c` on `src/*.c src/sdl/*.c`, as the survey reported:
  - unmodified, 11 of 110 compile: the `strupr`/`strlwr` prototypes in `doomtype.h:183-186` clash with Emscripten's `compat/string.h`;
  - with that guard extended to `!defined(__EMSCRIPTEN__)` (tried on a scratch copy only), 100 of 110 compile;
  - the other 10 are the 6 files included into other files (`r_draw8/16/24/32`, `p_henemy`, `p_hpspr`) and 4 that need build settings (`i_tcp.c`: IPX; `v_video.c`, `w_wad.c`: `HWRENDER` symbols; `sdl/i_sound.c`: `HAVE_MIXER`, now available as a port).
- No wasm build is wired up yet. That is the first brief's job.
