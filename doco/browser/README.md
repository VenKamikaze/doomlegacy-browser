# Doom Legacy in the browser: work notes

The goal is Doom Legacy playable in a browser (Emscripten/WASM), with multiplayer over [vnet](https://github.com/VenKamikaze/vnet) `v0.5.0`. Players host or join by room code, and native players can join the same rooms. This is the same result [jfsw-browser](https://github.com/VenKamikaze/jfsw-browser) reached for Shadow Warrior; its `doco/browser/` is the model for these notes and briefs.

**Read first:**
- [`survey.md`](survey.md): the feasibility survey of 19 Nov 2026 (copied as delivered), which chose Doom Legacy and lists the seams, risks and file:line refs.
- [`building.md`](building.md): set-up, native build, test data, headless run and Emscripten.
- [`bugs.md`](bugs.md): upstream bugs and quirks found so far. **L1 crashes every x86_64 build as soon as a sprite is drawn.**

## Status

| # | Work | Status |
|---|---|---|
| — | Repository tidy-up and environment set-up (this commit series) | done, 19 Nov 2026 |
| 00 | Baseline brief, as the survey proposes: native and wasm builds without `-ffast-math`, a per-tic state hash to compare native against wasm, a hot-join test, and whether the SVN maintainer accepts patches | not written |

The first brief has to deal with `bugs.md` L1 before any native baseline can run.

## What is in place

- The upstream SVN trunk (r1749) at the repository root, unchanged. `main` keeps the pristine extract of the release archives.
- `ext/vnet` at `v0.5.0` (`8572c74`); its sources compile under gcc and emcc.
- Scripts:
  - `setup.sh` (apt and pacman);
  - `setup-emsdk.sh` (Emscripten 6.0.13, ports seeded without GitHub archive downloads);
  - `build-native.sh`;
  - `fetch-test-data.sh` (Freedoom 0.13.0, SHA-256-checked, plus its demo lumps);
  - `run-headless.sh`;
  - `wadlump.py`.

## Carried over from jfsw-browser (proposed, not yet agreed)

These worked for jfSW. Each needs the user's yes before a brief relies on it.

- **The browser is the end goal.** The native Linux build keeps working, and native players can join browser rooms.
- **The transport is vnet**, as a submodule at `ext/vnet`, with `VNET_BACKEND_RELAY_AUTO`. A new `i_vnet.c` fills Doom Legacy's network driver table (`d_net.c:107-113`); the plain UDP path in `i_tcp.c` stays for native builds.
- **The room creator is the server.** Doom Legacy's listen server runs inside the host's game, so the host gets the first relay address.
- **The software renderer comes first.** Build without `HWRENDER` for wasm.
- **The blocking loops stay**, with ASYNCIFY yields (`survey.md` lists them).
- **The page fetches the data** (Freedoom by default, since it can be redistributed), caches it in IndexedDB, and puts it on the game's WAD search path.
- **Upstream-friendly changes:** new files where possible, `#ifdef __EMSCRIPTEN__`, no reformatting of upstream code.
- **Git:** game data is never committed, and there are no force-pushes.

New for Doom Legacy: **hot join is in scope.** The survey's main reason for choosing this port is that its savegame-based join (`d_clisrv.c:2348`, `2570-2600`) already exists.

## Open questions for the user

1. **Branches:** jfsw-browser used a long-lived `claude` integration branch with `browser/NN-*` feature branches. Use the same here?
2. **Test data:** is Freedoom alone enough? The shareware `DOOM1.WAD` would need either a mirror of the bare WAD or a PKLITE/LHA unpacker.
3. **SDL2_mixer port** (music): mirror its archive on an `emscripten-ports` branch in this repo, as jfsw did for SDL2, Ogg and Vorbis? Or leave music for later, as jfSW's Q4 did?
4. **Upstream fixes** (such as `bugs.md` L1): use jfsw's policy (a separate `fix/*` branch from the pristine `main`, written so it can go upstream unchanged)?
