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

Status: **done, 28 Nov 2026; the play-test is pending** (merged into `claudeai`). The page gets the shareware `DOOM1.WAD` from its own origin with a progress bar, checks it (size and SHA-256, or IWAD header and directory), keeps it in its own IndexedDB database and starts from it with no request on a reload; "Use your own copy..." takes any IWAD (cached, with a way back); every failure is a message on the page with the picker and "Try again". `tests/web/data.js` 138 of 138, `iwad-table.js` 17 of 17, 02's four page tests pass, `demo-hash.sh` 11 of 11, `savegame-portable.sh` 117 of 117, `bots-native-wasm.sh` identical. **No engine change** (`git diff 1ae4c18 -- src` is empty). Not tested: Firefox, a real network, a registered `DOOM.WAD`/`DOOM2.WAD`, the Apache examples (no Apache here), a person playing.

**What landed**

- **`web/config.js`**: the one place a host edits: `url`, `name` (the file name the game sees), `size`, `sha256`, `revalidate`. Default: `doom1.wad` next to the page, 4,196,020 bytes, SHA-256 `1d7d43be...`. The second entry, Freedoom 0.13.0 `freedoom1.wad`, is in the file (`DL_CONFIG_EXAMPLES`; "write `data: freedoom1`"). `?iwad=URL` overrides the URL (any origin; CORS hint on failure); the declared values then do not apply.
- **`web/iwads.js`**: the table of known IWADs (shareware `DOOM1.WAD` 1.9, Freedoom 0.13.0 `freedoom1.wad` and `freedoom2.wad`: name, size, SHA-256, game). `tests/web/iwad-table.js` checks it against `scripts/fetch-test-data.sh` and `testdata/`.
- **`web/data.js`**: the loader (structure from jfsw-browser's, with SHA-256 and IWAD checks): download with a stream and progress, stall timeout (30 s), checks, IndexedDB cache (database `doomlegacy-data`, stores `files` and `meta`; key `url:<absolute URL>` or `local`; record: bytes, size, SHA-256, ETag, Last-Modified, config signature, stored time, name), picked file, `navigator.storage.persist()`. Design details in `code-facts.md` section 14.
- **`web/page.js`, `index.html`, `page.css`**: the info line ("Game data: Doom shareware 1.9 (doom1.wad, 4.0 MB), downloaded just now from URL. Kept in this browser."), the progress bar, the buttons "Use your own copy..." (a real `<input type=file accept=.wad>` inside a label), "Try again", "Download again", "Use the download instead", a notes line (quota, no IndexedDB). New state `nodata` (the data failed; the page is alive; no `callMain`). All text through `textContent`.
- **Dev serving:** `scripts/serve-wasm.sh` serves `testdata/doom1.wad` next to the page (it always served every `testdata/*.wad`; the script's text and the missing-file hint now name `doom1.wad`). `scripts/wasm.mk` copies the new page files.
- **`doco/browser/data-hosting.md`** (new): what to serve, `config.js`, MIME, the gzip measurements, caching, CORS, Apache examples, checks.
- **02's tests that relied on Freedoom** now pass `iwad=/freedoom1.wad` (`smoke.js`: three opens; `persist.js` and `demo-page.js` already did). `exits.js`: see "Decisions" (three cases changed because the loader now handles those cases before the game does).

**Decisions**

1. **Runner: the IWAD goes in as it is (`raw=1`), not through the loader.** `run-wasm.js` passes `?test=1&raw=1&iwad=/data/<name>`: the file is written to `/work` under its own name, with no hashing and no IndexedDB. The demo, savegame and bots tests compare the simulation, so they must not depend on the loader, and a loader that hashed a 28 MB Freedoom file on every one of the 11 demo runs would add time for nothing. The loader has its own tests. `raw` is a `?test=1` hook.
2. **`legacy.wad` is not cached by the page.** It is part of the build (962 KB), served next to the page; the browser's HTTP cache handles it with the server's headers (`data-hosting.md`: `no-cache` for page files, so a redeploy reaches everyone). Caching it in IndexedDB would risk a `legacy.wad` of one build next to a `doomlegacy.wasm` of another.
3. **How a picked file with any name starts the right game.** The game picks the game by the IWAD's file name and treats an unlisted name as "another IWAD" with Doom II rules (`bugs.md` L62), so the page gives the game a name: the table's file name if size and SHA-256 match an entry, else a name from the lump directory following the game table's key lumps (`FREEDOOM`+`MAP01` is `freedoom2.wad`, `FREEDOOM`+`E4M1` is `freedoom1.wad`, `MAP01` is `doom2.wad`, `E4M1` `doomu.wad`, `E3M9` `doom.wad`, `E1M1` `doom1.wad`, plus Plutonia, TNT, FreeDM, Chex Quest, Blasphemer), else the file's own (safe) name. The file is written as `/work/<name>` and the game gets `-iwad /work/<name>`. Tested: `freedoom1.wad` picked as `mydata.wad` starts "Ultimate FreeDoom"; a changed `DOOM1.WAD` (not in the table) picked as `My Doom (1).WAD` starts "Doom shareware". Heretic, Hexen and Strife are named by their `TITLE` lump rules and, when the file already has an engine name, by that name (fix round 1; the first version wrongly gave them Doom names). Not tested with real files: Heretic, Hexen, Strife (synthetic IWADs only), a registered `DOOM.WAD`/`DOOM2.WAD` (no such file here: their rules are the `E3M9` and `MAP01` ones, which the table's names `doom.wad` and `doom2.wad` need in the game too).
4. **The conditional request is opt-in** (`revalidate: true` in `config.js`; default false). With it: `If-None-Match` and `If-Modified-Since` from the stored ETag and Last-Modified; 304 uses the cached copy, a changed ETag downloads and replaces, a network failure or a 5xx uses the cached copy with a notice. Tested, with the default config making no request.
5. **`persist()` result.** Asked once after the first successful store (and `persisted()` before it). **Headless Chromium here answered `false`** (no prompt; Chromium grants silently for installed, bookmarked or often visited sites and refuses a fresh profile). **Expected in Firefox** (not tried): a permission prompt, "Allow ... to store data in persistent storage", granted if the person agrees. Without it the browser may evict the file under disk pressure; the page then downloads it again. The result is in `window.dlPersistent` and nothing in the page depends on it.
6. **Quota and "no IndexedDB": how they are simulated, and why it is close.** `?test=1&idb=quota` throws a `DOMException` named `QuotaExceededError` from inside the `put()` transaction, which the loader handles by the same road as the real error (the transaction's rejection). `idb=off` makes `indexedDB.open` throw. **Both were also done for real** in `data.js` section 7: an init script making `window.indexedDB` undefined (as some private windows do; the game's own `/persist` then fails too, and the page shows both notices and the game starts), and a 1 MB origin quota set through the devtools protocol (`Storage.overrideQuotaForOrigin`), where Chromium refuses the 4 MB store itself. In every case the game starts from the downloaded copy with a notice that it will be downloaded again next time.
7. **Cache replacement.** The config signature is `schema|absolute URL|name|size|sha256`; a record is used only if it equals the current one, and its bytes are hashed again before use (6.6 ms). Entries for any other URL than the current one, the picked file and the configured URL (kept during an `?iwad=` visit) are removed at each load. "Download again" forces a fetch and replaces the entry; a failed fetch leaves the old entry.
8. **Unknown-size and compressed downloads.** The total for the bar is the declared size, else `Content-Length` of an answer without `Content-Encoding`, else unknown (unfilled bar, megabytes so far). A cross-origin response hides `Content-Encoding` from the page; with no declared size and a gzip answer the compressed `Content-Length` could be taken for the total, so progress is capped (never over 100 percent) and the byte count is not used to detect a short file there (the directory check catches it).
9. **`exits.js`: three cases changed, none loosened.** Case 2 (missing URL) used to end in the `error` state with a reload button; the loader now handles it before the game starts, so it checks the `nodata` state (message naming the file and 404, the picker and "Try again" visible, `dlStarts` 0), which is more than before. Case 4 (a file that is no IWAD) still checks the game's own `I_Error` path, by handing the file over with `raw=1`; the page's own loader refuses such a file (`data.js` tests that). Case 6 (another origin: "must be on the same origin") tested a restriction this brief removes; it now checks that another origin that does not answer gives the data error with the CORS hint.

**Acceptance criteria** (all by `tests/web/data.js` unless stated; Chromium headless, fresh browser context per test, one process at a time)

1. **AC1 first load: pass.** 22 progress reports (262,144 to 4,196,020 bytes, strictly increasing, each with the declared total); the game prints "IWAD recognized: Doom shareware"; the canvas is not blank (241 colours); the cache holds `url:<origin>/doom1.wad` with 4,196,020 bytes, the right SHA-256, the ETag, the stored time and the signature; SHA-256 of the 4.2 MB file by `crypto.subtle` took **6.6 ms** (the JavaScript fallback, `sha=js`: 42 ms; both agree on 10 padding-boundary lengths).
2. **AC2 cached load: pass.** After a reload the server saw `/index.html /page.css /config.js /iwads.js /data.js /page.js /doomlegacy.js /doomlegacy.wasm /legacy.wad` and **no request for any `.wad` but `legacy.wad`**; `dlData.from` is `cache` and the game starts.
3. **AC3 bad files: pass.** One byte flipped (corrupt: found and expected SHA-256 and size in the message), a short file (4,191,020 of 4,196,020 bytes, "incomplete"), a dropped connection (cut off after 200,511 of 4,196,020 bytes), 4,196,020 random bytes ("not a Doom data file"), a 56-byte text file (the same): each shows the message, `dlStarts` is 0, no `.wad` is in `/work`, the cache is empty, the picker and "Try again" are visible, and then "Try again" with the right file loads it, starts the game and caches it (5 x 7 checks).
4. **AC4 HTTP and CORS: pass.** 404, 403 and 500 each name the status and the URL, with the picker and "Try again". A server on another port without CORS headers: "The game data could not be downloaded from ... The server may be down or unreachable, or it does not allow this page to read it ... must send an Access-Control-Allow-Origin header (CORS)"; nothing cached. The same server with `Access-Control-Allow-Origin: *`: works, the file is named `doom1.wad` and the page says where it came from. A 404 on the page's own origin has no CORS hint.
5. **AC5 compressed response: pass.** `Content-Encoding: gzip` with `Content-Length` of the compressed size: 50 progress reports in decompressed bytes against the declared size, never over 100 percent, ending at 4,196,020; the checks pass on the decompressed bytes. With no declared size (`?iwad=`) and gzip: no total is claimed (42 reports, total 0: an unfilled bar); plain: the total is `Content-Length`; gzip from another origin (Content-Encoding hidden): works. gzip -6 saves 58 percent (1,765,820 of 4,196,020 bytes).
6. **AC6 file picker: pass.** With the download answering 404, picking `testdata/doom1.wad` starts the game (shareware), is cached under `local` (`meta.source=local`), and after a reload starts from the cache with no request for the download. `freedoom1.wad` picked as `mydata.wad` is named `freedoom1.wad` and the game starts "Ultimate FreeDoom". A changed `DOOM1.WAD` picked as `My Doom (1).WAD` is accepted and named from its lumps. A text file, a PWAD and a cut-off IWAD are refused with messages that name the file; nothing cached; the picker stays. "Use the download instead" removes the local copy, uses the cached download (no request) and a reload keeps it.
7. **AC7 quota and no IndexedDB: pass.** `idb=quota`, `idb=off`, no IndexedDB at all (real), and a real 1 MB quota: the game data is there, the game starts, the notice says the data will be downloaded again next time, nothing is cached, and a reload downloads it again (with the hooks). Without IndexedDB the game's own `/persist` notice from 02 ("Saved games and settings will not be kept") appears with the data notice and the game keeps running with no page error.
8. **AC8 config change: pass.** A changed URL downloads again and the old entry is gone; a changed declared size and SHA-256 under the same URL downloads again and replaces the entry (Freedoom's hash: 2 requests, 1 entry); the hash in capitals is the same signature; an `?iwad=` visit keeps the configured entry and adds its own, and the next plain visit removes it.
9. **AC9 table check: pass.** `tests/web/iwad-table.js`: 17 of 17 (the three SHA-256 values equal the script's, and the files in `testdata/` have the table's sizes and hashes; `config.js`'s two entries equal the table's; the script's published MD5 and SHA-1 for the shareware file are present).
10. **AC10 failure proofs: pass.** Each fails with its feature broken (the served `data.js` with one replacement, checked to apply exactly once), then reverted (no source was changed; the sabotage is in the test):
    - `DATA_SABOTAGE=nocache` (the loader ignores its cache): **5 checks fail** (AC2 "no request for the IWAD reached the server": `/doom1.wad` was requested again; "the data came from the cache" (network); the info line; "after a reload it starts from the cache" (state `nodata`); "... without asking the server" in the picker test), and the run aborts (exit 2) at the next step that needs the cache.
    - `DATA_SABOTAGE=nohash` (no SHA-256 check): **6 checks fail** (the flipped-byte file is accepted: state `ready`, game started, cached), and the run aborts at the "Try again" click (exit 2).
    - `DATA_SABOTAGE=nolocal` (a picked file is not cached): **3 checks fail** ("cached under a key of its own", "after a reload it starts from the cache", "without asking the server") and the run aborts (exit 2).
    - `IWAD_TABLE_SABOTAGE=1` (a digit of one hash in the table): 3 checks fail.
    - No test was loosened; the old test files changed only as listed in decision 9 and the explicit `iwad=`.
11. **AC11 nothing else breaks: pass.** `smoke.js` 36 of 36 (33 s), `demo-page.js` 11 of 11 (97 s; the page's `-testdump` equals the native one, 2,134 records), `persist.js` 12 of 12 (78 s), `exits.js` 16 of 16 (13 s). `demo-hash.sh` **11 of 11 identical** (367 s; 354 s in 02, the same within noise), `savegame-portable.sh` **117 of 117** (581 s, as in 02), `bots-native-wasm.sh` **identical, 2,800 records, 557 aim calls** (83 s, as in 02). Native: `sprite-column-oob.sh` 6 of 6, `bots-level-start.sh` PASS; no engine source changed, so the other native tests (`asan-demos`, `test-relay*`, `test-hot-join`, `savegame-old/malformed`, `draw-independence`) were not re-run.
12. **AC12 docs and play-test: done** (`data-hosting.md`; the steps below). The Apache blocks are not run here.

**Test times** (4 cores, one test at a time): new `data.js` 36 s, `iwad-table.js` 0.2 s; `smoke.js` 33 s, `demo-page.js` 97 s, `persist.js` 78 s, `exits.js` 13 s; `demo-hash.sh` 367 s, `savegame-portable.sh` 581 s, `bots-native-wasm.sh` 83 s.

**Findings**

- **headless Chromium's `persist()` is `false`**; a real quota can be made with the devtools protocol (`Storage.overrideQuotaForOrigin`), which gave the real `QuotaExceededError` path.
- **Cross-origin `Content-Encoding` is invisible to the page** unless the server exposes it; handled (decision 8) and noted in `data-hosting.md`.
- **A page served over plain `http` from a LAN address has no `crypto.subtle`**; the JavaScript SHA-256 fallback covers it (42 ms for the shareware file). Pointer lock, audio and IndexedDB itself are fine on `http://127.0.0.1` and `localhost`.
- `bugs.md` L62: the game picks the game by file name (worked around by the page's naming).
- A browser reports a CORS block and a network failure the same way, so the message names both.

**Left over**

- The play-test below, in Chromium and Firefox; Firefox is the unknown for IndexedDB (a 28 MB Freedoom record), the persistent-storage prompt, the file picker, and a private window.
- Not tested: the Apache blocks (`apachectl configtest` and the `curl` checks in `data-hosting.md`); a registered `DOOM.WAD`/`DOOM2.WAD`; real Heretic, Hexen, Strife IWADs; a real network (slow or flaky); a real CORS host.
- `revalidate: true` on a server whose `mod_deflate` rewrites the ETag downloads the whole file on every load (`data-hosting.md` says what to do).
- Brief 06 builds on `data-hosting.md`: the `config.js` to deploy must live outside `build/wasm/bin`.

**Play-test steps** (Arch Linux, pacman)

```
sudo pacman -S --needed base-devel git unzip python nodejs npm chromium firefox curl
git clone --recurse-submodules -b claudeai https://github.com/VenKamikaze/doomlegacy-browser
cd doomlegacy-browser
scripts/setup-emsdk.sh --with-ports
scripts/build-wasm.sh
scripts/fetch-test-data.sh                  # testdata/doom1.wad, freedoom1.wad, freedoom2.wad (verified)
scripts/serve-wasm.sh                       # http://127.0.0.1:8000/
```

Do each in Chromium, then in Firefox, with a fresh profile (or a private window for the last check):

1. **First load.** Open `http://127.0.0.1:8000/`. A progress bar moves to 100 percent with "Downloading ... MB of 4.0 MB", then "Game data: Doom shareware 1.9 (doom1.wad, 4.0 MB), downloaded just now from http://127.0.0.1:8000/doom1.wad. Kept in this browser." and "Click to start". Click it: the title screen, then the menu. (Firefox may show a permission prompt about persistent storage: say whether you allowed or declined it, and what `window.dlPersistent` shows in the console if you add `?test=1`.)
2. **Reload.** F5: the page is ready at once, with "from this browser's copy". In the developer tools' network tab there is no request for `doom1.wad`. Click to start: the game starts.
3. **Download again.** Press "Download again": the bar runs again, the info line says "downloaded just now".
4. **A bad URL.** Open `http://127.0.0.1:8000/?iwad=/nosuch.wad`: a red message with the URL and "404", the buttons "Use your own copy..." and "Try again", and no game. Open `?iwad=http://127.0.0.1:9/x.wad` (nothing listens): the message names both causes and the CORS hint. Open `?iwad=http://example.org/doom1.wad`: a CORS or network error with the hint, in both browsers.
5. **The file picker.** On the start screen press "Use your own copy..." and choose `testdata/freedoom1.wad` (or your own `DOOM.WAD` or `DOOM2.WAD` if you own it; it is only read locally). The info line says "your own copy", and the game starts that game (Freedoom shows its own title). Reload: it starts from the browser's copy without asking again. Press "Use the download instead": the shareware game again. Copy `testdata/freedoom1.wad` to `/tmp/mydata.wad` and pick that: Freedoom still starts. Pick a text file: a message that it is not an IWAD, and the earlier choice is unchanged.
6. **Private window / no storage (Firefox and Chromium).** Open the page in a private window: the game starts, and the page says the data will be downloaded again (and that saves will not be kept, where IndexedDB fails).
7. **Hosting check** (optional, needs a server you control): follow "Checking it" in `data-hosting.md`: `curl -sI -H 'Accept-Encoding: gzip' ...` and `sha256sum` of the downloaded file.

Things only a person can check: the file picker dialog in Firefox; the persistent-storage prompt; a real slow connection (does the bar read sensibly?); a registered `DOOM.WAD` or `DOOM2.WAD`.

**Fix round 1** (after the independent review: no blockers, one should-fix, ten nits; all addressed)

1. **Should-fix, names of Heretic, Hexen and Strife.** The review was right: `classify` gave Heretic's `E1M1`/`E3M9`/`E4M1` and Hexen's and Strife's `MAP01` Doom names, so they would have run as Doom games. Now (`web/data.js`): the file's own lower-cased name is kept when it is one of the engine's IWAD names (`DL_ENGINE_NAMES`, 24 names in `web/iwads.js`; `iwad-table.js` checks the list against `src/d_main.c`'s table); otherwise `classify` puts Heretic, Hexen and Strife first, by the table's own rules (a `TITLE` lump, which the table rejects for every Doom game; `ENDSTRF`; `MAP40`; `E2M2`), and the Doom rules now also require what the table requires. An exact match of size and SHA-256 with the table still comes before both. `iwad-table.js` parses `game_desc_table` (key, required and rejected lumps) and simulates the engine in table order on the lumps each entry needs: for every game, `classify` gives a name that the engine accepts as the same game. The false claim ("they keep their own name") is corrected here and in `code-facts.md` section 14.
2. **`?iwad=` wins over a remembered picked file** (`load()` skips the local lookup when `override` is set, and an override visit stores its copy without touching `meta.source`, so the remembered choice survives).
3. **`legacy.wad` is reserved:** a pick or URL with that name gets `game.wad` (`safeName`, and `urlFileName` in `page.js`); `/work/legacy.wad` is untouched and the cached record has the neutral name.
4. **AC8 capitals check** now requires `from === 'cache'` and exactly 2 requests in all.
5. **A superseded load stores nothing:** `store()` checks the abort signal before `put()` and before `setMeta`, and removes the record if the abort came between the two.
6. **Old entries are removed after the new load has worked** (`purgeOld()`), so a configuration that points at a missing file leaves the visitors' copies.
7. **Revalidation falls back on a bad 200** (cut off, damaged, not an IWAD) to the verified cached copy with a notice, like network errors and 5xx; a 4xx (the file is gone) is still an error.
8. **Picker memory:** the first 12 bytes are read with `file.slice(0, 12)` and a text file or PWAD is refused without reading the rest; a file over 512 MB is refused with a message and not read.
9. `db.onversionchange` closes the database (no check: a second tab upgrading the schema cannot happen with version 1).
10. **`data-hosting.md`:** "distributed unmodified and free of charge", pointing at the licence text in the original shareware distribution instead of quoting it, with a statement that the wording was not checked here.
11. **`exits.js`:** case 2 checks the overlay is visible; case 6 checks `dlStarts` is 0.

**New tests and counts:** `data.js` section 10 (21 new checks: 159 of 159 in total, 46 s), `iwad-table.js` 40 of 40 (was 17), `exits.js` 18 of 18 (was 16).

**Failure proofs for the new checks** (each by a served `data.js` with the fix taken out, exactly once, or a temporary edit, then reverted):

| Fix removed | Checks that fail |
|---|---|
| `DATA_SABOTAGE=heretic` (no `TITLE` rules) | 3: Heretic registered, Heretic shareware, Hexen get the file's own name |
| `ownname` (own engine name not kept) | 1: `Heretic.WAD` becomes `heretic1.wad` |
| `override` (`?iwad=` does not skip the local file) | 1: the override visit uses the picked file |
| `legacy` (no reserved name) | 2: named `LEGACY.WAD`, and the cached record |
| `abort` (no signal check in `store`) | 1: an aborted load stored a record and set the meta |
| `purgefirst` (purge before the load) | 1: the missing-file configuration wiped the copy |
| `revalfall` (the old fallback condition) | 3: a damaged, a cut-off and a non-IWAD 200 ended in `nodata` |
| `picker` (no size limit, no header read) | 2: the 600 MB file and the 20 MB text file were read whole |
| `capitals` (the hash is not lower-cased in the signature) | 1: the capitals check (the old check, `count === 3 \|\| ...`, would have passed) |
| `IWAD_TABLE_SABOTAGE=names` / `classify` | 1 / 7 |
| a temporary edit of `page.js` (overlay hidden, `dlStarts` 1 after a data error) | 3 `exits.js` checks (case 2 overlay, case 2 not started, case 6 not started) |

Item 9 has no check. The worktree used for this round is `/home/user/review-03`.

**Fix round 2** (re-review: three nits, two fixed, one kept)

- **Two quick picks:** both use the key `local`, so the cleanup of a cancelled pick (`store()` removes its record if the abort came between `put` and `setMeta`) could delete the record of the pick that replaced it. Each record now has an `id` and the cleanup (`Cache.delIfOwn`) deletes only if the stored record still carries this load's id, inside one readwrite transaction. No check: the race (the second pick committing between the first's `put` and its cleanup) cannot be made to happen on demand in a page.
- **The `legacy.wad` test** now picks `legacy.wad` in lower case (MEMFS is case-sensitive, so `LEGACY.WAD` could never overwrite the file). `DATA_SABOTAGE=legacy` now fails the "untouched" check too: `/work/legacy.wad` went from 962,192 to 52 bytes (2 checks fail: untouched, and the cached record's name).
- **Kept as it is:** a file's own engine name wins over its lumps, as for a native player; a Heretic file renamed `doom.wad` runs as the engine decides (also in `code-facts.md` section 14).
- **Counts:** `data.js` 159 of 159, `exits.js` 18 of 18.

**Review and coordinator verification (28 Nov 2026)**

- **Independent review** of 1ae4c18..a3bc91e: no blockers, 1 should-fix, 10 nits.
  - The should-fix: picked or `?iwad=` Heretic, Hexen and Strife files got Doom names, so the wrong game started.
  - Fix round 1 (949d32a) fixed all 11. The re-review checked `classify()` against the engine's game table with full lump lists of every supported IWAD: each gets a name the engine accepts as the same game, with no misclassification either way.
  - The re-review left 3 nits. Two were fixed in fix round 2 (13b705e): a cancelled pick deletes only its own record, and the `legacy.wad` test uses the exact name. The third is kept: a file's own engine name wins over its lumps, as natively.
- **Coordinator verification at 13b705e**, every test one at a time after a clean rebuild:

| Test | Result | Time |
|---|---|---|
| builds: native `--clean`, wasm clean, relay | rc 0 | 11 s, 12 s, 10 s |
| fresh clone, empty `EM_CACHE`, `setup-emsdk.sh --with-ports` and `build-wasm.sh` | rc 0; `config.js`, `data.js`, `iwads.js` in `build/wasm/bin` | 38 s |
| `tests/web/data.js` | 159 of 159 | 47 s |
| `tests/web/iwad-table.js` | 40 of 40 | 0.2 s |
| `tests/web/smoke.js`, `demo-page.js`, `persist.js`, `exits.js` | 36/36, 11/11, 12/12, 18/18 | 32 s, 95 s, 71 s, 16 s |
| `demo-hash.sh` | 11 of 11 | 347 s |
| `savegame-portable.sh`, `savegame-old.sh`, `savegame-malformed.sh` | 117/117, 12/12, 8/8 | 579 s, 133 s, 57 s |
| `bots-native-wasm.sh`, `bots-level-start.sh` | identical (2,800 records, 557 aims), pass | 83 s, 21 s |
| `test-hot-join.sh`, three modes, with and without `--bots` | 6 of 6 | 46-57 s each |
| `test-relay.sh`; `--bots --runs 3`; `test-relay-errors.sh` | pass | 96 s, 283 s, 143 s |
| `sprite-column-oob.sh`, `draw-independence.sh` | pass | 61 s, 92 s |
| `asan-demos.sh --rebuild` | 53 known, 0 new (its hot-join comparison FAILs as before: L29) | 282 s |
