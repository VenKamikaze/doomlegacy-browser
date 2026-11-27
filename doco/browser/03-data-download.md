# 03: Game data download

## Goal

The page gets its game data the way decision D7 describes:
- it downloads the IWAD before the game starts and shows progress;
- it checks the file and caches it in IndexedDB, so a reload starts at once with no download;
- a file picker covers people with their own copy;
- every failure gives a clear message;
- the server side is documented.

**The default is the Doom shareware 1.9 `DOOM1.WAD`, served from the page's own origin (D14).** Freedoom stays available by configuration.

## Read first

- [`README.md`](README.md): D7, D9, **D14** (the default data), Q2 (the shareware file, its source and checksums; the public mirror is a zip with no CORS headers).
- The Outcome of [02](02-emscripten-port.md) and `web/page.js`. Today the page fetches `?iwad=` (default `freedoom1.wad` next to the page, same origin only) into the working directory, uncached, and passes it to the game with `-iwad`. `legacy.wad` is fetched from next to the page. `/persist` (IDBFS) holds the config and saves.
- `code-facts.md` §6 and §12 (what 02 added), and `building.md` §7 and §11 (the page, its `?test=1` hooks, `scripts/serve-wasm.sh`).
- `scripts/fetch-test-data.sh`: the verified test data and its SHA-256 values.
- `src/d_main.c:1520-1600`: the game table (IWAD file names per game). `src/w_wad.c:510-535`: the game computes an MD5 of every WAD it loads, each start.
- Reference, read-only: `/home/user/jfsw-browser/doco/browser/03-data-download.md` and `data-hosting.md`. That is the same brief for another engine; its Outcome shows what worked. Its "no re-checksum" item does not apply here: Doom Legacy keeps no checksum cache.

## In scope

### 1. Configuration

- The data comes from a page config: one small, documented place a person hosting the game edits, such as `web/config.js`. It sets the URL, the file name the game sees, and the expected size and SHA-256.
- The default is `doom1.wad` next to the page, with the shareware 1.9 size and SHA-256 (Q2). A second documented example entry is Freedoom 0.13.0 `freedoom1.wad`.
- `?iwad=<url>` overrides the URL, as 02's dev loader does. A URL on another origin is now allowed (D7 allows a host that sends CORS headers), with the CORS hint of §5 when it fails.
- The page shows which data it is using: the game name, downloaded or your own copy, and from where.

### 2. Download with progress and checks

- **Progress:** a bar showing bytes and percent. It must stay sensible when the total is unknown or the response is compressed; use the declared size where there is one.
- **Checks before use and before caching:**
  - the size and SHA-256 match the declared values, if any (`crypto.subtle.digest`; say how long it takes on the 4 MB file);
  - without declared values (a `?iwad=` override), the header is `IWAD` and the lump directory lies inside the file.
- **Keep known IWADs in one table.** The page holds a small table (file name, size, SHA-256, game name) for shareware `DOOM1.WAD` 1.9 and Freedoom 0.13.0 `freedoom1.wad` and `freedoom2.wad`. A quick test checks it against `scripts/fetch-test-data.sh`, so the two cannot drift.
- A truncated, wrong or unknown file is never cached and never handed to the game.

### 3. IndexedDB cache

- A store of its own, not inside the game's IDBFS folder. Each entry is keyed by the absolute URL and holds:
  - the bytes;
  - the size and SHA-256;
  - the ETag or Last-Modified, if the server sent one;
  - the config signature it was stored under;
  - when it was stored.
- **A second load with a cached file makes no network request for it.** The test counts requests at the server.
- The cache is replaced:
  - when the configured URL, declared size or declared hash changes;
  - by a visible "Download again" control.
  
  A conditional request (`If-None-Match`) is optional and opt-in, so the no-request rule holds for the default config.
- Entries for URLs no longer in use are removed.
- Ask for persistent storage (`navigator.storage.persist()`). Say in the Outcome what Chromium does with the request; for Firefox, say what is expected.
- **Quota:** if storing fails, the game still starts from the downloaded copy, with a notice that it will be downloaded again next time.
- `legacy.wad` is part of the build, not game data. It may stay uncached (it is served next to the page), or be cached the same way; your call, documented.

### 4. File picker

"Use your own copy" is an `<input type=file>` that takes a `.wad`.
- It is checked as in §2: an IWAD header and a sane directory. A known table entry is named; any other IWAD is accepted as the person's own copy, and the game decides which game it is.
- It is cached under a key of its own, so a reload uses it again.
- It is offered on the start screen and in every error message.
- There is a way to switch back to the download.
- A person's registered `DOOM.WAD` or `DOOM2.WAD` works this way. It is their own copy, used locally; nothing registered is ever offered for download (D9, D14).
- The game needs the file under the name it expects (`-iwad` with the right name). Make sure a picked file named differently (say `Doom1.WAD` or `mydoom.wad`) still starts the right game, and say how.

### 5. Clear errors

Each of these gets a plain message on the page that names the problem and the URL or file, and offers the file picker and "Try again":
- an HTTP error (404, 403, 500);
- a CORS block or a network failure. The two can't be told apart in JavaScript, so name both, with the CORS hint when the URL is on another origin;
- a truncated download;
- a wrong file: the size and SHA-256 found, against the declared values;
- a file that is no IWAD;
- a quota failure (§3; not fatal);
- IndexedDB unavailable, as in some private windows. The game still starts, uncached, with a notice. The game's own `/persist` handling from 02 must still behave.

The game is never started on a bad file. The game's own "IWAD not found" or "Cannot start the game" messages (02's exit page) must not be what a person sees for any of these cases.

### 6. Server-side documentation

`doco/browser/data-hosting.md` (new):
- what to serve: the extracted `doom1.wad`, unmodified (its licence allows that). `scripts/fetch-test-data.sh` produces a verified copy. The public mirror's zip is not usable directly, and the mirror sends no CORS headers;
- the MIME type;
- compression: measure what gzip saves on `doom1.wad`, and its effect on progress;
- cache headers;
- CORS headers when the data is on another origin;
- an example Apache configuration, using placeholder host names and paths only (`game.example.org`, `/srv/http/games/doom`).

Brief 06 builds on this, so keep it focused on the data file.

### 7. Tests and dev serving

- `scripts/serve-wasm.sh` serves `doom1.wad` (from `testdata/`) next to the page, so the default works locally.
- 02's web tests that rely on Freedoom (`fd*` demos, screen pictures) pass `?iwad=` or the runner's flag explicitly. None of them may change what it checks.
- `tests/tools/run-wasm.js` keeps working for demo-hash, savegame-portable and bots-native-wasm. Choose whether it goes through the new loader or puts the file straight in place, and document the choice. Either way it must not need IndexedDB.

## Out of scope

- A native downloader.
- Offering registered data for download.
- Unpacking zips in the browser.
- PWADs (`-file`) from the page.
- Any change to the game's simulation or to the engine's WAD code. If an engine change seems needed, keep it small and under `__EMSCRIPTEN__`, and say why.

## Acceptance criteria

Use Playwright with a local test server that can gzip, send ETags, add or omit CORS headers, return errors and drop connections, and that records every request. Use a fresh browser profile per test unless the cache is under test. Chromium and Playwright are preinstalled; never run `playwright install`. 02's `tests/web/lib.js` helpers are available.

1. **AC1, first load:** with no arguments, the page downloads `doom1.wad` with increasing progress events (more than one). The game reaches the title screen or menu (02's not-blank check), the game reports shareware Doom, and the file is in the cache.
2. **AC2, cached load:** after a reload, **no request for the IWAD reaches the server** and the game starts.
3. **AC3, bad files:** each of these gives a clear error, the game is not started (no `callMain`), and nothing is cached:
   - one byte flipped;
   - a truncated file, as a short file and as a dropped connection;
   - random bytes of the right size;
   - a small text file.
   
   Afterwards the correct file loads normally.
4. **AC4, HTTP and CORS:** a 404, and a server on another port without CORS headers, each give a clear error; the second includes the CORS hint. The same server with CORS headers works.
5. **AC5, compressed response:** with `Content-Encoding: gzip` the download works and the progress is sensible.
6. **AC6, file picker:**
   - With no data URL reachable, pick `testdata/doom1.wad` (`setInputFiles`). The game starts. Reload: it starts from the cache without picking again.
   - Picking `freedoom1.wad` renamed `mydata.wad` starts Freedoom.
   - "Use the download instead" switches back.
7. **AC7, quota and no IndexedDB:** simulate both through `?test=1` hooks. The game still starts, with the notice. Say how the simulation works and why it is close enough to the real failure.
8. **AC8, config change:** a changed configured URL or declared hash downloads again and removes the old entry.
9. **AC9, the table check** (§2) passes: the page's table agrees with `fetch-test-data.sh`.
10. **AC10, failure proofs:** each of AC2, AC3 and AC6 fails when its feature is broken (a loader that ignores the cache; one without the hash check; one that doesn't cache picked files). Show each fails, then revert. No test is loosened.
11. **AC11, nothing else breaks:**
    - 02's `smoke.js`, `demo-page.js`, `persist.js` and `exits.js` pass;
    - `demo-hash.sh` is 11 of 11, `savegame-portable.sh` passes and `bots-native-wasm.sh` is identical;
    - the native tests in PROMPT §0 still pass (no engine change is expected).
12. **AC12, docs and play-test:** `data-hosting.md` lets a person host the data correctly. The Outcome has play-test steps for Chromium and Firefox (Arch Linux, pacman) covering first load, reload, a bad URL and the file picker.

## Dependencies

02 (merged into `claudeai`).

## Notes

- Git: branch `browser/03-data-download` from `claudeai`. Push after each commit. Never merge, never touch `claudeai` or `master`, never open a PR, never force-push.
- Keep the page code plain (no framework, no bundler), like 02's. Text goes in through `textContent` only.
- Dev knobs and test hooks only with `?test=1`.
- Never commit game data or built binaries.
- Run only one multi-process test at a time (4 cores).
- The next free bug number is L62.
- Estimate: smaller than 02, about the size of brief 01.

## Outcome

Status: not started.
