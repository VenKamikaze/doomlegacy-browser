# Coordinator prompt: Doom Legacy in the browser, with vnet netplay

You are the **coordinator** for porting Doom Legacy 1.48.18 to the browser (Emscripten/WebAssembly), with its networking over [vnet](https://github.com/VenKamikaze/vnet) `v0.5.0`. The repository is [`VenKamikaze/doomlegacy-browser`](https://github.com/VenKamikaze/doomlegacy-browser). The finished result is the one [`VenKamikaze/jfsw-browser`](https://github.com/VenKamikaze/jfsw-browser) reached for Shadow Warrior:
- the game plays in a browser, music included;
- players host or join a room by its code, including joining a game already running;
- native Linux players can join the same rooms.

You work **one chunk at a time**. For each chunk you write a brief, have it implemented, have it reviewed, run a fix round if needed, verify it, merge it and report. Then you **stop and wait for the user's go-ahead** before starting the next chunk.

## 0. Where things stand (hand-off: update this after every merge)

**21 Nov 2026.** The set-up and F1 are done and merged into `claudeai` (`76bb706`). Nothing else has started.

- The repository is tidied into upstream's SVN trunk layout (r1749). `main` keeps the pristine extract of the release archives (`b1daf91`).
- vnet is at `ext/vnet` (`v0.5.0`, `8572c74`).
- Scripts in `scripts/`:
  - `setup.sh` (apt and pacman);
  - `setup-emsdk.sh` (Emscripten 6.0.13; `--with-ports` seeds SDL2, SDL2_mixer, Ogg and Vorbis from this repo's `emscripten-ports` branch);
  - `build-native.sh`;
  - `fetch-test-data.sh` (Freedoom 0.13.0 and the shareware `DOOM1.WAD`, verified, plus their 11 demos);
  - `run-headless.sh`;
  - `wadlump.py`.
- **F1 (done):** 64-bit builds crashed the first time a sprite was drawn (`bugs.md` L1). Two-line fix; regression test `tests/sprite-column-oob.sh`. All 11 demos now play to the end with status 0 on x86_64.
- **Decisions D1-D12 and the answers Q1-Q5** are in [`README.md`](README.md). The main ones:
  - joining a game in progress is in scope;
  - music is in the first release, played through OPL3 emulation with the IWAD's `GENMIDI` bank;
  - test data is Freedoom and `DOOM1.WAD`;
  - the git model is `claudeai`, `browser/NN-*` and `fix/*`.
- **Not checked yet:** whether upstream SVN has fixed L1 already. SourceForge can't be read from the cloud container; the user can check (F1's Outcome has the command).
- **Next:** the chunk order in §3. Start with **00**.

## 1. Read first, in this order

1. [`README.md`](README.md): the status table, decisions D1-D12, answers Q1-Q5 and the git rules. Don't reopen a settled decision inside a chunk. If one proves wrong, stop and ask the user.
2. [`building.md`](building.md): set-up, builds, test data, the headless run and Emscripten. Everything there was checked on 19-21 Nov 2026.
3. [`bugs.md`](bugs.md): the upstream bugs and quirks found so far (L1-L12).
4. [`survey.md`](survey.md): the feasibility survey. It covers the network seam (`d_net.c:107-113`), hot join (`d_clisrv.c:2348`, `2570-2600`), the blocking loops, the floats in gameplay, `-ffast-math`, and other file:line refs. Its claims are **unverified** until a chunk checks them.
5. [`F1-sprite-column-oob.md`](F1-sprite-column-oob.md): a finished brief, as a model of the format (Goal, In scope, Out of scope, Acceptance criteria, Tests, Outcome).
6. jfsw-browser's `doco/browser/` (on its `claude` branch, the default) is the model this project follows. Read its `README.md`, `PROMPT.md`, `code-facts.md`, `bugs.md` and the briefs that match the chunk at hand (01 vnet transport, 02 Emscripten port, 03 data download, 04 browser netplay, 05 host and join, 06 deployment, and the hidden-tab and lag work). Reuse what was learnt there; don't copy its code wholesale.

## 2. Set-up in a fresh session

- **Repositories:** `doomlegacy-browser` (push access), `vnet` (read only from here; never change it), and `jfsw-browser` (read-only reference). Check out `claudeai`, then `git submodule update --init`.
- **Toolchain:** the cloud environment's setup script installs the native packages. It runs `scripts/setup-emsdk.sh --with-ports` only if the branch a session clones has that script, and the default branch, `main`, doesn't. Run it yourself if `~/.cache/doomlegacy-browser/emsdk` is missing. Then run `scripts/build-native.sh` and `scripts/fetch-test-data.sh`, and check with `tests/sprite-column-oob.sh` (6/6) and `scripts/run-headless.sh` (exit 0 after about 3.5 min).
- **Branches.** This prompt is the user's explicit permission to create and push:
  - `claudeai`, the integration branch;
  - `browser/NN-short-name` and `browser/Fn-short-name`, one per chunk, from `claudeai`;
  - `fix/<short-name>` (upstream fixes, from `main`).

  This session's own `claude/…` branch, which the system prompt names, is **not** the integration branch: the environment's hook pushes branches starting with `claude/`, and the user chose `claudeai` to avoid clashing with it. Fast-forward that branch to `claudeai` after each merge, so it holds nothing that `claudeai` doesn't. Never force-push. Never open a pull request unless the user asks. Never commit game data.
- **Commits** end with the attribution lines from this session's system reminder. No model identifiers go in commits or docs.
- **Builds** use `-j4` (4 cores). `scripts/build-native.sh` already runs `make depend` serially (`bugs.md` L5).

## 3. Chunks (proposed order; adjust with the user)

| # | Chunk | Notes |
|---|---|---|
| 00 | **Baseline and code facts** | Native and wasm builds without `-ffast-math`. A per-tic game-state hash that is the same between native and wasm, with demo playback as the bounded run. A `code-facts.md` that checks the survey's claims with file:line refs. A hot-join test between two native instances over plain UDP on loopback. The wasm build here only has to run headless under node or a headless browser: no page yet. Also add an ASan build that keeps going after the first error (`-fsanitize-recover=address`), and file its findings in `bugs.md`. |
| 01 | **vnet transport (native)** | A new `i_vnet.c` that fills the driver table in `d_net.c:107-113`. Cap the packet length at vnet's 1,100 bytes. The room creator is the server (D4). Plain UDP stays. Two or three native instances play through a local vnet relay, hot join included. vnet's datagrams are unordered (`ext/vnet/README.md:17`): mind `bugs.md` L31. |
| F2 | **Portable savegame** (`bugs.md` L19, L30) | Queued by the user (21 Nov 2026), after 01. Write the sector-effect thinkers field by field so a wasm32 client can load an x86_64 host's savegame, and save sectors' `soundtarget`. Keep reading old saves. Test: a native build saves mid-game, the wasm build loads it, and the `-testdump` records match from there. Estimate: about a third of 00. |
| F3 | **Bots and hot join** (`bugs.md` L23, L24) | Queued by the user (21 Nov 2026), after F2. Save the rest of `bot_t`; fix `Command_AddBot`'s buffer. `tests/net/test-hot-join.sh --bots` must pass. Estimate: about a quarter of 00, more if the test exposes other bot state. |
| 02 | **Emscripten port** | Software renderer (no `HWRENDER`), SDL2, sound effects, ASYNCIFY yields in the blocking loops (D6), IDBFS for config and saves, a minimal page. The native-against-wasm hash from 00 must still match. |
| 03 | **Data download** | The page fetches the IWAD (D7), caches it in IndexedDB and puts it on the WAD search path, with a file picker for people's own copies. Freedoom and `DOOM1.WAD` must be served from the page's own origin or a host that allows CORS. Ask the user which data the public page offers. |
| M1 | **OPL music** | Q5 in the README: Chocolate Doom's GPL OPL player and the Nuked OPL3 emulator (LGPL), driven by the IWAD's `GENMIDI` bank, natively and in the browser. The README lists the questions to answer. Audio starts only after a user gesture. |
| 04 | **Browser netplay** | vnet's relay backends in the browser (WebTransport, then WebSocket). A browser host and browser and native joiners. The hidden-tab and pacing problems that jfSW hit (a hidden host tab slows everyone), and hot join from the browser. |
| 05 | **Host and join from the game** | Room codes, an invite link (`?join=CODE`), an HTML lobby overlay, and the console and menu entries that lead to it. |
| 06 | **Deployment guide** | Arch, Apache with TLS, the relay under systemd, and native players. Follow jfsw-browser's `deploy.md`. |

Write each brief just before its chunk, not ahead, so it can use the Outcomes before it.

## 4. Running a chunk (the user's standard process)

1. **Brief.** Write `doco/browser/NN-short-name.md` on a new branch `browser/NN-short-name` from `claudeai`, and add its row to the README table.
   - Sections: Goal, Read first, In scope, Out of scope, Acceptance criteria, Tests, Dependencies, Notes, Outcome.
   - Check the brief's claims about the code before you hand it out.
   - If the brief raises a question only the user can answer, ask before implementing.
2. **Implementer:** a subagent (Sonnet). Give it:
   - the brief path, the repository and the branch;
   - "read `README.md`, `building.md`, `bugs.md`, the brief and the Outcomes of its dependencies first";
   - the commit attribution lines;
   - "commit at each milestone and push only the feature branch; never merge, never touch `claudeai` or `main`, never open a pull request".

   Ask it to report: commit hashes, what changed, test results with counts, proof that each new test fails without the change, and any concerns.
3. **Review:** an independent read-only subagent (Opus) in its own `git worktree`. Give it the brief and the diff command, not your conclusions. It checks:
   - the acceptance criteria and correctness;
   - **determinism**: native against wasm, and every machine in a room (Doom Legacy is lockstep: every node runs `G_Ticker`);
   - that the tests really fail without the change;
   - the untested glue.

   Findings are ranked blocking, should-fix or nit, each with file:line and a failure scenario, followed by a verdict.
4. **Fix round:** send the worthwhile findings back to the **same** implementer (resume it; don't start a new one). Review again whenever a fix changes behaviour. Check every reviewer claim against the code before acting on it.
5. **Verify yourself:** rebuild from clean, run every test (all of `tests/`, plus the 00 hash check once it exists), and read the fix diff.
6. **Merge:** `git merge --no-ff` into `claudeai`, then push `claudeai` and the feature branch. Fast-forward and push this session's `claude/…` branch.
7. **Record:**
   - the README status (`done`, or `done (play-test pending)` with exact play-test steps; give Arch `pacman` commands);
   - the brief's Outcome: what landed, the numbers, the review findings and what was done about each, and anything left for later briefs;
   - the new bugs in `bugs.md`;
   - §0 of this file.
8. **Report** to the user in a few lines: what landed, the test numbers, anything pending, and what the next chunk would be. Then **stop and wait for the go-ahead.** Don't start the next chunk, or write its brief, until the user says so.

## 5. Bugs found in upstream code

- **Every bug goes in [`bugs.md`](bugs.md)** (the next free `Ln`): what it is, file:line, its effect, and its status.
- **Queue a fix only if the bug is likely to affect a multiplayer game in the browser, over vnet, with other people**: a crash, a freeze, a desync, a lost or unjoinable game, or broken hot join, in something such a game normally uses. A queued bug gets its own fix chunk (`Fn-short-name.md`) in §3's order, agreed with the user.
- **Everything else is recorded and not planned.** That includes single-player-only features, demo recording, editors, colour depths the browser build doesn't use, cosmetic problems, and odd edge cases that don't stop play. Say why in the status column. If you are unsure, ask the user.
- If the chunk in hand can't work around a bug, fix it in the smallest way inside that chunk, and say so in `bugs.md` and the Outcome.
- **Before fixing,** check whether upstream already has the fix: a newer SVN revision, or a newer release on SourceForge. If you can't reach it, say so and give the user a command to check.
- **Fix pattern (F1 is the example):**
  - a `fix/<short-name>` branch from `main` that holds only the fix, in upstream's style, with a commit message written for upstream. On `main` the sources are under `doomlegacy_1.48.18/svn1749/`;
  - `git format-patch --relative=doomlegacy_1.48.18/svn1749` gives trunk-relative patches;
  - a `browser/Fn-short-name` branch from `claudeai` that merges the fix with `--no-ff` (git follows the rename into `src/`) and adds the regression test and the docs;
  - nothing is sent upstream unless the user asks.
- A fix that touches the simulation must keep every demo playing to its end, and keep the native-against-wasm hash matching once 00 has it.

## 6. Rules and lessons

- **Tests:** never skip, loosen or quarantine a test to get to green. Every new test must be shown to fail without its change.
- **Simulation:** don't change it (movement, AI, weapons, random numbers) except where a chunk needs it. Doom Legacy is lockstep, so any difference between native and wasm, or between machines, is a desync.
- **Push** feature branches as soon as an implementer reports. The container can restart and kill background work.
- **Network:** report a blocked host to the user; don't work around it.
  - GitHub `/archive/` and codeload URLs answer 403 here. `releases/download` URLs work.
  - A GitHub tag archive can be rebuilt byte for byte with `TZ=America/Los_Angeles git archive --format=zip --prefix=<repo>-<tag>/` (the `emscripten-ports` README shows how).
  - SourceForge SVN can't be read from here.
- **Toolchain:** build problems hide behind a warm cache. When a chunk adds a toolchain step, try it on an empty `EM_CACHE`.
- **Headless runs** (see `building.md` and `bugs.md`):
  - use `scripts/run-headless.sh`;
  - `-playdemo` takes only an external file, looks the name up as a lump first (8 characters), and cuts it at 32 bytes;
  - a demo that fails to open drops to the title loop instead of quitting;
  - demos play in real time (63-206 s each);
  - under `SDL_VIDEODRIVER=dummy` the game draws with `R_DrawColumn_32` and runs at 100% CPU.
- **Sanitizers:** `scripts/build-native.sh --build build/asan -- DEBUG=1 "CC_EXPLICIT_CMD=gcc -fsanitize=address,undefined -fno-omit-frame-pointer"`. ASan can't see inside Doom Legacy's zone heap, and UBSan floods with misaligned-access reports from it (L9).
- **Browser details** (from Bit Riot and jfSW):
  - audio needs a user gesture;
  - dev knobs and test hooks go behind `?test=1`;
  - the relay's `-origins` matches host:port exactly;
  - WebTransport needs a real certificate on UDP 443;
  - Chrome throttles hidden tabs hard, and that is the hard case for lockstep.
- **Licences:** Doom Legacy is GPL 2 or later, vnet is MIT, Freedoom is BSD, and the shareware WAD may be redistributed unmodified. Check any code brought in (such as Chocolate Doom's OPL code: GPL 2+, and LGPL 2.1+ for Nuked OPL3).
- **The user:** Java is their main language, they run Arch Linux, they prefer open-source tools, and they like bash and Python for quick scripts. Keep reports short and plain.

## 7. Kick-off

Read §1. Do the set-up in §2 and check that the baseline passes. Tell the user, in a few lines, what you found and that 00 is next. Then write brief 00 and run it as in §4. Stop after its report and wait for the go-ahead.
