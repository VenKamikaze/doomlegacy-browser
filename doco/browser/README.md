# Doom Legacy in the browser: work notes

The goal is Doom Legacy playable in a browser (Emscripten/WASM), **with its music**, and with multiplayer over [vnet](https://github.com/VenKamikaze/vnet) `v0.5.0`. Players host or join by room code (joining a game in progress included), and native players can join the same rooms. This is the same result [jfsw-browser](https://github.com/VenKamikaze/jfsw-browser) reached for Shadow Warrior; its `doco/browser/` is the model for these notes and briefs.

**Read first:**
- [`survey.md`](survey.md): the feasibility survey of 19 Nov 2026 (copied as delivered), which chose Doom Legacy and lists the seams, risks and file:line refs.
- [`building.md`](building.md): set-up, native build, test data, headless run and Emscripten.
- [`bugs.md`](bugs.md): upstream bugs and quirks found so far. **L1 crashes every x86_64 build as soon as a sprite is drawn.**

## Status

| # | Work | Status |
|---|---|---|
| — | Repository tidy-up and environment set-up | done, 19 Nov 2026 |
| F1 | Fix `bugs.md` L1, the sprite-column out-of-bounds read (crash on x86_64) | not written; blocks every native baseline run |
| 00 | Baseline, as the survey proposes: native and wasm builds without `-ffast-math`, a per-tic state hash to compare native against wasm, a hot-join test, and whether the SVN maintainer accepts patches | not written |

## Settled decisions

Don't reopen these inside a brief. If one proves wrong, stop and ask the user.

- **D1. The browser is the end goal.** The native Linux build keeps working, and native players can join browser rooms.
- **D2. Joining a game in progress is in scope.** It is Doom Legacy's savegame-based join (`d_clisrv.c:2348`, `2570-2600`); the survey chose this port for it.
- **D3. The transport is vnet `v0.5.0`**, a submodule at `ext/vnet`, with `VNET_BACKEND_RELAY_AUTO`. A new `i_vnet.c` fills Doom Legacy's network driver table (`d_net.c:107-113`); plain UDP (`i_tcp.c`) stays for native builds.
- **D4. The room creator is the server.** Doom Legacy's listen server runs inside the host's game.
- **D5. The software renderer comes first.** Build without `HWRENDER` for wasm.
- **D6. The blocking loops stay**, with ASYNCIFY yields (`survey.md` lists them).
- **D7. The page fetches the data**, caches it in IndexedDB, and puts it on the game's WAD search path.
- **D8. Music is in the first release** (the user, 19 Nov 2026: "Bobby Prince's music is an iconic part of doom"). Sound effects and music both, in the browser and natively. How the MIDI is synthesised is Q5.
- **D9. Test data is Freedoom 0.13.0 and the Doom shareware 1.9 `DOOM1.WAD`**, both fetched and verified by `scripts/fetch-test-data.sh`. Game data is never committed. Which data the public page offers by default is the user's call.
- **D10. Toolchain:** Emscripten 6.0.13 with the jfsw-browser pins; ports come from this repo's `emscripten-ports` branch (SDL2, SDL2_mixer, Ogg, Vorbis).
- **D11. Upstream-friendly changes:** new files where possible, `#ifdef __EMSCRIPTEN__`, no reformatting of upstream code.
- **D12. Git**, as below.

## Git

- **`claudeai` is the integration branch** (the user, 19 Nov 2026: not `claude`, because this environment's hook pushes branches whose names start with `claude/`).
- A brief's branch is `browser/NN-short-name`, from `claudeai`, merged back with `--no-ff`.
- `main` is the pristine extract of the 1.48.18 release archives (`b1daf91`). It stands in for upstream.
- **Fixes to upstream bugs** follow jfsw-browser's pattern:
  - a `fix/<short-name>` branch from `main`, holding only the fix, in upstream's style and with a commit message written for upstream;
  - a `browser/Fn-short-name` branch from `claudeai` that merges the fix with `--no-ff` and adds the regression test and the doc updates;
  - before fixing, check whether a newer upstream SVN revision already has the fix;
  - nothing is sent upstream unless the user asks.
- `emscripten-ports` is an orphan branch holding only library archives. Never force-push it.
- No pull requests unless the user asks. No force-pushes.
- A fresh `git clone --recurse-submodules -b claudeai https://github.com/VenKamikaze/doomlegacy-browser` must always work.

## Answers to the open questions (19 Nov 2026)

- **Q1. Branches:** jfsw's model, with `claudeai` in place of `claude`.
- **Q2. Test data:** Freedoom and `DOOM1.WAD`. The shareware WAD comes from `https://www.jbserver.com/downloads/games/doom/misc/shareware/doom1.wad.zip`. Its MD5, SHA-1 and size match the published shareware 1.9 values ([DoomWiki](https://doomwiki.org/wiki/DOOM1.WAD)): MD5 `f0cefca49926d00903cf57551d901abe`, SHA-1 `5b2e249b9c5133ec987b3ea77596381dc0d6bc1d`, 4,196,020 bytes, CRC32 `162b696a`.
- **Q3. Music:** in the first release (D8). The SDL2_mixer port is on the `emscripten-ports` branch. Its zip was rebuilt from the git tag so that it matches the port's SHA-512 byte for byte; the branch README has the commands.
- **Q4. Upstream fixes:** jfsw's pattern (see Git).

## Open questions

- **Q5. How is the music synthesised?** Doom Legacy converts the MUS lumps to MIDI (`qmus2mid.c`) and plays them through SDL_mixer (`sdl/i_sound.c:703`, `:850`). In the browser, SDL_mixer's MIDI is its built-in Timidity, which needs instrument data at run time. There are three ways to provide it:
  - **(a) Timidity with a free GUS patch set** (such as FreePats). Smallest change; how it sounds depends on the patch set.
  - **(b) FluidSynth with a General MIDI SoundFont** (FluidR3_GM is MIT). This is closest to the Roland Sound Canvas arrangement many players know. It is a new library to port, and adds a 100+ MB SoundFont, or a smaller one.
  - **(c) OPL3 emulation** (Nuked OPL3 or libADLMIDI, both LGPL) driven by the IWAD's own `GENMIDI` instrument bank. That is the DOS Sound Blaster / AdLib sound, with **no extra data**: `DOOM1.WAD`, `freedoom1.wad` and `freedoom2.wad` all ship `GENMIDI` (11,908 bytes). It needs a new music backend in Doom Legacy.
