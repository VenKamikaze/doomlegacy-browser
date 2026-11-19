# Building and running

Every command runs from the repository root. Checked on Ubuntu 24.04 (the cloud container) on 19 Nov 2026. The pacman (Arch) path of `scripts/setup.sh` has not been tried yet.

## 1. Clone

```bash
git clone --recurse-submodules https://github.com/VenKamikaze/doomlegacy-browser
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

This downloads Freedoom 0.13.0 from its GitHub release and checks the zip and both WADs against pinned SHA-256 values. It writes:
- `testdata/freedoom1.wad` (detected as "Ultimate FreeDoom");
- `testdata/freedoom2.wad` (detected as "FreeDoom");
- the demo lumps, as `testdata/demos/fd{1,2}demo{1..4}.lmp`.

`testdata/` is git-ignored, and a second run downloads nothing. `--from-zip FILE` uses a local copy of the zip; `--dest DIR` writes somewhere else.

Freedoom is BSD-licensed and may be redistributed, so it can also be served by the browser build. The shareware `DOOM1.WAD` is not fetched: id's `doom19s.zip` packs it in a PKLITE self-extractor. A `DOOM1.WAD` of your own can go in `testdata/`.

`scripts/wadlump.py list|extract` lists or extracts WAD lumps (run it with `python3 -I`).

## 5. Headless run

```bash
scripts/run-headless.sh
```

The script runs the game:
- with `SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy`;
- with `-nosound -nomusic -noendtext`;
- in a temporary `-home` that is deleted afterwards (`--home DIR` keeps one);
- under a timeout (`--timeout SECS`, default 120; exit status 124 on timeout).

By default it plays `testdata/demos/fd1demo1.lmp` with `-playdemo`. At the end of the demo the game quits by itself with status 0 (`G_CheckDemoStatus`: `singledemo` → `I_Quit`, `src/g_game.c:4602`). Options:
- `--iwad`, `--demo FILE|none` and `--bin` choose what runs;
- arguments after `--` go to the game, for example `-- -warp 1 1`.

**State on 19 Nov 2026: the x86_64 build segfaults** as soon as the player's weapon sprite is drawn, with a demo or a `-warp`, on both IWADs. See [`bugs.md`](bugs.md) L1. Until that is fixed, the headless run ends with status 139 after about 2 s. The title loop alone runs, and is stopped by the timeout.

Quirks the script works around (details in [`bugs.md`](bugs.md)):
- `-playdemo` takes only an external file, adds `.lmp` if there is no extension, and first looks the name up as a lump.
- The demo name is cut at 32 bytes.

So the script runs the game from the demo's directory and passes the bare file name. The demo files have short names that can't match a lump.

## 6. Emscripten

```bash
scripts/setup-emsdk.sh --with-ports
```

```bash
source ~/.cache/doomlegacy-browser/emsdk/emsdk_env.sh
```

- This installs emsdk revision `d7b4130` with Emscripten **6.0.13**, the same pins as jfsw-browser, into `~/.cache/doomlegacy-browser/emsdk` (override with `EMSDK_DIR`). The download is about 300 MB from `storage.googleapis.com`.
- `--with-ports` seeds the SDL2, Ogg and Vorbis ports from jfsw-browser's `emscripten-ports` branch (override with `PORTS_REPO`), after checking each SHA-512 against the pinned emsdk. That is needed because GitHub archive URLs, where Emscripten would download them, answer 403 in the cloud container.
- **SDL2_mixer is not seeded.** No mirror holds it yet, so `-sUSE_SDL_MIXER=2` would try a blocked download. It is needed only for music (`HAVE_MIXER`); sound effects use plain SDL audio (`src/sdl/i_sound.c:21-33`).

**Smoke checks (19 Nov 2026):**
- vnet: all 13 `ext/vnet/src/*.c` compile with no warnings under both `gcc` and `emcc`, with `-std=c11 -Wall -Wextra -D_POSIX_C_SOURCE=200809L -Iext/vnet/include -Iext/vnet/src`.
- Game sources: `emcc -sUSE_SDL=2 -DSDL2 -DSMIF_SDL -DLINUX -c` on `src/*.c src/sdl/*.c`, as the survey reported:
  - unmodified, 11 of 110 compile: the `strupr`/`strlwr` prototypes in `doomtype.h:183-186` clash with Emscripten's `compat/string.h`;
  - with that guard extended to `!defined(__EMSCRIPTEN__)` (tried on a scratch copy only), 100 of 110 compile;
  - the other 10 are the 6 files included into other files (`r_draw8/16/24/32`, `p_henemy`, `p_hpspr`) and 4 that need build settings (`i_tcp.c`: IPX; `v_video.c`, `w_wad.c`: `HWRENDER` symbols; `sdl/i_sound.c`: `HAVE_MIXER`).
- No wasm build is wired up yet. That is the first brief's job.
