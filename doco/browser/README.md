# Doom Legacy in the browser: work notes

The goal is Doom Legacy playable in a browser (Emscripten/WASM), **with its music**, and with multiplayer over [vnet](https://github.com/VenKamikaze/vnet) `v0.5.0`. Players host or join by room code (joining a game in progress included), and native players can join the same rooms. This is the same result [jfsw-browser](https://github.com/VenKamikaze/jfsw-browser) reached for Shadow Warrior; its `doco/browser/` is the model for these notes and briefs.

**Starting a fresh coordinator session?** Point it at [`PROMPT.md`](PROMPT.md). Its §0 is the hand-off.

**Read first:**
- [`survey.md`](survey.md): the feasibility survey of 19 Nov 2026 (copied as delivered), which chose Doom Legacy and lists the seams, risks and file:line refs.
- [`building.md`](building.md): set-up, native build, test data, headless run and Emscripten.
- [`bugs.md`](bugs.md): upstream bugs and quirks found so far. L1 (an x86_64 crash whenever a sprite is drawn) is fixed by F1; L15 (level start reads unfilled map things) is fixed in 00; L19 (the savegame was not portable between 64-bit native and wasm32) and L30 (it did not hold the sector `soundtarget`) are fixed by F2, together with five more things a savegame lost (L36 to L40); L31 and L35 (a join in progress under reordered or lost packets) came out of 01 and are **queued** as F4.
- [`code-facts.md`](code-facts.md): what the sources say, with file:line refs: the survey's claims checked, the network driver, start-up, the join, consistency, blocking loops, floats, savegame portability, files, the music path, the state hash.

## Status

| # | Work | Status |
|---|---|---|
| — | Repository tidy-up and environment set-up | done, 19 Nov 2026 |
| F1 | [Sprites crash the 24/32 bpp column drawer on 64-bit builds](F1-sprite-column-oob.md) (`bugs.md` L1) | done |
| M1 | OPL music (D8, Q5 c): Doom's DMX OPL sound from the IWAD's `GENMIDI`, natively and in the browser | not written |
| 00 | [Baseline, state hash and code facts](00-baseline.md): native and wasm builds without `-ffast-math`, a per-tic state hash (`-testdump`) compared native against wasm, a hot-join test over UDP, ASan with recovery, [`code-facts.md`](code-facts.md) | done |
| 01 | [vnet transport (native)](01-vnet-transport.md): `i_vnet.c` fills the driver table; `-relay HOST:PORT` with `-server`/`-connect CODE`; three native players and a join in progress through a local relay, with impairment | done, 26 Nov 2026 (AC4 narrowed to latency only by the user; the full impairment is F4) |
| F2 | [Portable savegame between x86_64 and wasm32](F2-portable-savegame.md) (`bugs.md` L19, L30) | done, 26 Nov 2026 (also fixes L36 to L40, five more things a savegame lost; L43 logged) |
| F3 | [Bots and joining a game in progress](F3-bots-hot-join.md) (`bugs.md` L23, L24; also L20, L45, L46, L51 to L53) | done, 27 Nov 2026 (bot aim without libm, a bot's whole state in the savegame; L54 logged for F4) |
| 02 | [The Emscripten port](02-emscripten-port.md): ASYNCIFY yields in the blocking loops, a page with click to start, keyboard, mouse, sound effects, IDBFS for config and saves | done by the implementer, 27 Nov 2026 (review and play-test pending) |
| F4 | Joining a game in progress over a lossy or reordering link (`bugs.md` L31, L35): `PT_STATE` sequence number, the cause of L35, brief 01's AC4 at its full values | queued, before 04 |

## Settled decisions

Don't reopen these inside a brief. If one proves wrong, stop and ask the user.

- **D1. The browser is the end goal.** The native Linux build keeps working, and native players can join browser rooms.
- **D2. Joining a game in progress is in scope.** It is Doom Legacy's savegame-based join (`d_clisrv.c:2348`, `2570-2600`); the survey chose this port for it.
- **D3. The transport is vnet `v0.5.0`**, a submodule at `ext/vnet`, with `VNET_BACKEND_RELAY_AUTO`. A new `i_vnet.c` fills Doom Legacy's network driver table (`d_net.c:107-113`); plain UDP (`i_tcp.c`) stays for native builds.
- **D4. The room creator is the server.** Doom Legacy's listen server runs inside the host's game.
- **D5. The software renderer comes first.** Build without `HWRENDER` for wasm.
- **D6. The blocking loops stay**, with ASYNCIFY yields (`survey.md` lists them).
- **D7. The page fetches the data**, caches it in IndexedDB, and puts it on the game's WAD search path.
- **D8. Music is in the first release** (the user, 19 Nov 2026: "Bobby Prince's music is an iconic part of doom"). Sound effects and music both, in the browser and natively. The music is played by **OPL3 emulation driven by the IWAD's own `GENMIDI` instrument bank** (Q5, option c): the DOS Sound Blaster/AdLib sound, with no extra data to download.
- **D9. Test data is Freedoom 0.13.0 and the Doom shareware 1.9 `DOOM1.WAD`**, both fetched and verified by `scripts/fetch-test-data.sh`. Game data is never committed. Which data the public page offers by default is the user's call.
- **D10. Toolchain:** Emscripten 6.0.13 with the jfsw-browser pins; ports come from this repo's `emscripten-ports` branch (SDL2, SDL2_mixer, Ogg, Vorbis).
- **D11. Upstream-friendly changes:** new files where possible, `#ifdef __EMSCRIPTEN__`, no reformatting of upstream code.
- **D12. Git**, as below.
- **D13. Bots may change, and so may demo compatibility** (the user, 27 Nov 2026: "Bots aren't part of original doom but are a feature of the port. I'm okay with changing that behaviour if it improves things"; "I'm also okay with breaking demo compatibility, we just would need to state so in doco"). F3 used it: the bots aim with the `tantoangle` table instead of libm's `atan`, and a demo recorded with bots before F3 does not play back as recorded (`bugs.md` L47, `building.md`). Any such break must be stated in the docs.

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

## Q5. How the music is synthesised: OPL3 emulation (the user, 19 Nov 2026: "Go with c")

Doom Legacy converts the MUS lumps to MIDI (`qmus2mid.c`) and plays them through SDL_mixer (`sdl/i_sound.c:703`, `:850`). Instead of SDL_mixer's own MIDI player (Timidity, which needs instrument patches), the music goes through an OPL3 emulator, using the instrument bank in the IWAD's `GENMIDI` lump, the way DOS Doom's DMX library drove a Sound Blaster or AdLib card. `DOOM1.WAD`, `freedoom1.wad` and `freedoom2.wad` all ship `GENMIDI` (11,908 bytes each).

The options that were not chosen were Timidity with a GUS patch set (a), and FluidSynth with a General MIDI SoundFont (b, the Sound Canvas sound, with a 100+ MB SoundFont). Either could be added later as an option.

**Likely source** (checked 19 Nov 2026 at chocolate-doom `a2dfd51`; to be confirmed by the brief). Chocolate Doom's OPL music player is a faithful re-implementation of DMX's OPL driver:
- `src/i_oplmusic.c` (1,906 lines): GENMIDI parsing, voice allocation, MIDI events to OPL registers;
- `src/midifile.c` (838 lines): MIDI parser;
- `opl/opl.c`, `opl/opl_sdl.c`, `opl/opl_queue.c`: the OPL interface and SDL output. `opl_sdl.c` mixes into SDL_mixer's output with `Mix_QuerySpec` and a mixer callback, so it fits Doom Legacy's `HAVE_MIXER` build;
- `opl/opl3.c` (1,938 lines): the Nuked OPL3 emulator.

Licences: `opl3.c` is LGPL 2.1 or later, and the rest is GPL 2 or later. All of it is compatible with Doom Legacy's GPL 2 or later.

Questions for the brief:
- the seam with Doom Legacy's music API (`I_PlaySong`, `I_RegisterSong` and friends in `sdl/i_sound.c`), and whether MIDI from `qmus2mid.c` or the raw MUS data is the better input;
- `opl_sdl.c` uses `SDL_mutex`, which needs checking in a wasm build without threads;
- the CPU cost of Nuked OPL3 in wasm (it is cycle-accurate; DOSBox's DBOPL is the cheaper alternative);
- the browser's audio-unlock gesture;
- a native A/B against Chocolate Doom playing the same track.
