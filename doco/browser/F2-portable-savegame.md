# F2: portable savegame (x86_64 and wasm32)

## Goal

A savegame written by a 64-bit native build loads into the wasm32 build, and the other way round, and both then play on identically. A savegame also keeps each sector's `soundtarget`. The savegame is what a player joining a game in progress downloads (D2), and what a repair sends, so this is what lets a browser player join a native host's game in progress, and a native player join a browser host's (D1, D4). It fixes `bugs.md` L19 and L30.

## Read first

- [`README.md`](README.md): D1, D2, D4, D5.
- [`code-facts.md`](code-facts.md) §4 (the join), §5 (consistency and the repair download), §8 (savegame portability: the raw writes and the size table), §11 (the state hash).
- [`bugs.md`](bugs.md): L19, L30, and L22 (`dropoffz`, fixed in 00: the field-by-field mobj writes are the model).
- The Outcomes of [00](00-baseline.md) (the state hash, `tests/demo-hash.sh`, `tests/tools/run-wasm.js`) and [01](01-vnet-transport.md).
- `src/p_saveg.c`. The join sends what `P_Savegame_Write_header( NULL, 1 )` and `P_Savegame_Save_game()` write (`d_clisrv.c:2460-2464`), and loads it with `P_Savegame_Read_header( .., 1 )` and `P_Savegame_Load_game()` (`d_clisrv.c:2495-2514`).

## In scope

### 1. Write a fixed layout

- **Every write of raw struct memory** in the savegame must become a fixed layout, written field by field with the existing `WRITE*`/`READ*` macros, as the mobjs are. The same layout must hold on x86_64 and wasm32. That covers:
  - `WRITE_SECTOR_THINKER` (ceilings, plats, doors, floors, the light effects, light faders, elevators, `p_saveg.c:1803-1812`, used at `:1848-2311`);
  - `WRITE_THINKER` and the `SE_HEADER_SIZE` macros (`:1777-1790`): scrollers, friction, pushers;
  - the `WRITE144_*` variants, if they are still written;
  - anything else your audit finds. Read every `WRITEMEM`/`READMEM` and every `sizeof` in the write and read paths, and list in the Outcome what you found and what each one does now.
- **Pointers** inside those structs (for example a pusher's source mobj, or a ceiling's links) are written as the indices the file already uses for pointers (`WRITE_MobjPointerID`, `WRITE_SECTOR_PTR`, `:1464-1474`), or rebuilt on load. They are never written as raw bytes.
- **Booleans and enums** are written at a fixed width.

### 2. Versions

- **Format version:** the new format gets a savegame version of its own, so the reader knows which layout it has. Pick a number that cannot clash with an upstream release's, and say how you chose it.
- **Old saves:** saves in the old format must still load on the same kind of machine. Keep the old raw read path for old versions, and keep it out of the new-format path.
- **Mismatched builds:** a join between two builds with different formats must fail with a clear message, not a corrupt game. Check what the join already does about version mismatches, and add a check only if it is missing.

### 3. `soundtarget` (L30)

- **Save it:** save each sector's `soundtarget` as a mobj index, or none, and restore it on load.
- **The repair path:** `bugs.md` L30 says the repair path does not keep it either. Find out what a repair sends:
  - if it is the savegame, this fix covers it;
  - if a repair sends sector state some other way, make that keep `soundtarget` too, or say in the Outcome why it does not matter.

### 4. Test-only options

- **Save at a tic:** write the join's own savegame at gametic N of a demo or a game to a file, so that the same code path the join uses is the one under test.
- **Load:** load such a file, as a joining client does.
- **Quit at a tic:** stop after N tics.
- **Size report:** for each sector-effect type, print the number of bytes one record takes (written from a zeroed struct is enough), so native and wasm can be compared for every type, including the ones no demo reaches.
- **Rules for these options:** use `-test*` names. They change nothing when absent. Document them in `building.md`.
- **The wasm runner:** `tests/tools/run-wasm.js` needs a way to put a file into MEMFS (it has `--get` to bring files back, not a `--put`).

## Out of scope

- The other structs `code-facts.md` §8 lists as written field by field (mobjs, players, sectors): leave them as they are, unless the audit finds a raw copy in them.
- A big-endian build. The join refuses an endian mismatch already.
- Bots in the savegame (L23, F3).
- The loss and reordering problems of the join (L31, L35, F4).
- Changing what the state hash covers. If the hash misses something the savegame now carries, add it, and say so.

## Acceptance criteria

1. **Same bytes per record.** Every sector-effect type writes the same number of bytes on native and wasm. The size report's output is identical on both builds, for every type in the table in `code-facts.md` §8 and any others the audit finds.
2. **Byte-identical saves.** The same demo, saved at the same gametic by native and by wasm, gives byte-identical savegame files, apart from fields that legitimately differ, such as a time or a description. Name any such fields and why they differ. Do this at several gametics, in at least three demos, chosen so that between them the saves hold:
   - active doors, ceilings, floors and plats;
   - the light effects;
   - a `soundtarget` that is set.

   Print what each save holds, as counts per thinker type plus the number of sectors with a `soundtarget`. List every type that no demo produces; AC1 covers those types.
3. **Cross loads play on identically.** A save written by native, loaded by both native and wasm, plays on with no input for at least 35 × 30 tics with identical `-testdump` records. The same holds for a save written by wasm. The loaded game's state at the load tic must also equal the saver's state at the save tic: the same state-hash record, `soundtarget` included.
4. **L30 is fixed.** On `claudeai` before this chunk, the "state at load equals state at save" check of AC3 fails at a save tic where a `soundtarget` is set. On the change, it passes. Show both.
5. **Old saves still load.** A save written by the build from before this chunk (`claudeai` at `72924ef`) loads into the new build on native and plays on. The test builds the old commit itself, in a temporary worktree outside the source tree, and never commits a savegame.
6. **The join still works over UDP and the relay:**
   - `tests/net/test-hot-join.sh` (all three modes);
   - `tests/net/test-relay.sh --runs 2`;
   - `tests/net/test-relay-errors.sh`.
7. **Nothing else changed.** `tests/demo-hash.sh` 11 of 11, `tests/draw-independence.sh`, `tests/sprite-column-oob.sh` 6 of 6, and `tests/asan-demos.sh` with no new site. Demos never touch the savegame, so their hashes must not move.
8. **Each new check fails when what it checks is broken.** Show each with a throwaway patch, reverted afterwards. For example:
   - put one raw write back: AC1 and AC2 fail;
   - drop `soundtarget` from the save: AC4 fails;
   - read an old save through the new path: AC5 fails.

## Tests

- `tests/savegame-portable.sh`: AC1 to AC4, native and wasm, bounded, printing what each save holds. Reuse `tests/tools/testdump-diff.py` and `run-wasm.js`.
- `tests/savegame-old.sh` (or a mode of the first): AC5.
- Everything in AC6 and AC7.
- Report the counts and times for each.

## Dependencies

00 and 01 (done).

## Notes

- **Git:** work on `browser/F2-portable-savegame` in `doomlegacy-browser`, from `claudeai`.
  - Commit at each milestone and push only that branch.
  - Never merge, never touch `claudeai` or `main`, never open a pull request, never force-push.
  - `ext/vnet` and `jfsw-browser` are read-only.
- **Commits:** end each with the attribution lines the coordinator gives you. No model names in commits or docs.
- **Upstream-style changes:** these are upstream bugs, so keep the change in `p_saveg.c` in upstream's style, small and reviewable, so it could be offered upstream. Put the test hooks in `src/test_dump.c` where you can, with only small calls from upstream files.
- **Machine limits:** builds use `-j4`. Each headless game uses 100% of a core (L7) and the container has 4 cores, so run one multi-process test at a time. The relay tests are timing sensitive.
- **Floating point:** the wasm build has no `-ffast-math` either (00). If native and wasm play on differently after a load, find out why before changing any test.
- **Blocked hosts:** report a blocked host; don't work around it.
- **Stop and report** if the fix needs a change to the network protocol beyond the savegame's own version, or if a raw write cannot be made portable without changing the simulation.

## Outcome

Status: **implemented, 26 Nov 2026**, on branch `browser/F2-portable-savegame` (pushed, not merged). All eight criteria pass; the numbers and the failure proofs are below. Besides what the brief asked for, the check "state as loaded equals state as saved" found five more things a savegame lost (`bugs.md` L36 to L40); they are fixed here because AC3 cannot pass without them (see "Decisions for the coordinator").

**What landed** (commits on the branch: `71d2dd1` the three loader fixes alone, in upstream's style, `git format-patch -1 71d2dd1 --relative=src` gives a trunk patch; `8f3d329` the portable layout, the soundtarget, the test options; `64f98bf` the tests; and the documentation commit)

- `src/p_saveg.c`: every sector effect is written field by field at fixed widths (one `WRITE_<type>_fields` and `READ_<type>_fields` pair per type, 13 types); the raw macros (`WRITE_SECTOR_THINKER`, `WRITE_THINKER`, the dead `WRITE144_*`) are gone, the raw read macros stay for old savegames. The version in the header is `SG_PORTABLE_BASE + 149` = 10149. The sector `soundtarget` has an optional section of its own. `ceilingz` of a mobj and `viewheight`, `deltaviewheight` of a player are saved (portable layout only). Three loader fixes (L36 to L38).
- `src/test_dump.c`, `src/p_saveg.h`: the test options `-testsave`, `-testquit`, `-testload`, `-testsizes`, `-testcensus` (`building.md` section 10).
- `tests/savegame-portable.sh` (AC1 to AC3), `tests/savegame-old.sh` (AC4, AC5, the join between builds), `tests/tools/dump-at.py`, `tests/tools/run-wasm.js --put`, `tests/asan-known.txt` (nine line numbers moved).
- Docs: `code-facts.md` section 8 (the format, the table, the audit), `building.md` sections 8 and 10, `bugs.md` (L19 and L30 fixed, L36 to L42 new), README status.

**The version number.** Upstream's savegame versions are 144 to 149 (`MIN_READSAVE_VERSION`, `DL_VERSION`); its next ones will be 150, 151 and so on. The portable layout is `10000 + 149`: far above anything upstream is going to reach, and it still says which format the rest of the savegame is (149), so every `sg_version >= 149` test in the reader keeps working with `sg_version` set to 149 and a second flag, `sg_portable`. The reader of a build from before F2 sees 10149 above its maximum (149) and says "wrong version" by itself; the new reader refuses an old-layout savegame sent by a server ("the server is an older build", `P_Savegame_Read_header`, only for the netgame header: an old savegame file, with the header of a savegame file, still loads). The join compared the game version and `NETWORK_VERSION` and nothing about the savegame, so this check was missing; there is no change to the network protocol.

**The audit** (`code-facts.md` section 8 has it with the layout): every `WRITEMEM`, `READMEM`, `memcpy` and `sizeof` in the write and read paths of `p_saveg.c`:
- `WRITE_SECTOR_THINKER`, ten uses (ceilings, plats, doors, floors, lightflash, strobe, glow, fireflicker, lightfade, elevator) and `WRITE_THINKER`, three uses (scroll, friction, pusher): raw struct memory from a field to the end of the struct. Now field by field. The brief names `p_saveg.c:1803-1812` and `:1777-1790`; the second is inside an `#if 0` block (`SAVE_SE`), dead, left alone.
- `WRITE144_SECTOR_THINKER`, seven uses, and a `memcpy( &vld.type, ..., sizeof(vld) )`: behind `WRITE_LF_VER_144` and `WRITE_PLAT144`, which nothing defines. Not written, so not a portability problem; removed as dead code. The reads of version 144 stay.
- `WRITEMEM`/`READMEM` of `inventory_t`: two bytes, same on both builds; now two `WRITEBYTE`s (the same bytes).
- `memcpy` of the 8-byte flat names: fixed size, left. `save_p += sizeof(thinker_t)` for an obsolete friction thinker: only in a branch that is not compiled (`FRICTIONTHINKER` is defined); 12 bytes in the portable layout. `sizeof(int)`, `sizeof(boolean)` in the header: left, both 4 on both builds and checked. `Z_Malloc( sizeof(...) )`: allocation. `sizeof(long)`: comments.
- Found by the tests, not by reading: `ceilingz` (a derived value that is stale), `viewheight` and `deltaviewheight`, `flags3`, a corpse's `radius`, `height` and health (L36 to L40).

**Acceptance criteria**

1. **Same bytes per record: pass.** `-testsizes` on native and on wasm prints the same 13 lines: ceiling 37, door 35, floor 27, plat 41, flash 21, strobe 21, glow 10, fireflicker 13, lightfade 9, elevator 22, scroll 37, friction 13, pusher 33 (the record with its marker byte, and the byte after it for ceilings and plats), and `roundtrip ok` for each: a struct with every byte set to a value of its own is written, read into a zeroed struct and written again, and the two records are equal. That covers the types no demo produces. Before: 40/36, 32/28, 32/28, 40/40, 16, 8, 8/4, 24/20 (`code-facts.md` section 8).
2. **Byte-identical saves: pass.** 12 saves in 7 demos, native against wasm, each `cmp` identical (10,637 to 35,227 bytes). The saves hold (thinkers by type, sectors with a soundtarget; the test prints these for every save):

   | Demo, tic | Holds |
   |---|---|
   | `d1demo1` 600 | 1 platform, 2 flash, 4 strobe, 8 glow, 33 soundtargets |
   | `d1demo1` 1800 | 2 doors, 2 flash, 4 strobe, 8 glow, 55 soundtargets |
   | `d1demo2` 400 | 1 door, 8 flash, 4 glow, 50 soundtargets |
   | `d1demo2` 1000 | 2 platforms, 8 flash, 4 glow, 69 soundtargets |
   | `d1demo3` 800 | 1 door, 1 platform, 2 flash, 7 strobe, 7 glow, 4 scroll, 58 soundtargets |
   | `d1demo3` 1200 | 2 doors, 1 platform, 2 flash, 7 strobe, 7 glow, 4 scroll, 94 soundtargets |
   | `d1demo3` 1600 | 1 floor, 2 flash, 7 strobe, 7 glow, 4 scroll, 95 soundtargets |
   | `fd1demo3` 2000 | 2 doors, 3 flash, 1 strobe, 1 scroll, 289 soundtargets |
   | `fd1demo4` 600 | 1 door, 11 flash, 6 strobe, 22 glow, 1 fire flicker, 46 soundtargets |
   | `fd1demo4` 3000 | 11 flash, 6 strobe, 22 glow, 1 fire flicker, 95 soundtargets |
   | `fd2demo1` 2600 | 1 door, 4 flash, 2 strobe, 11 glow, 16 scroll, 149 soundtargets |
   | `fd2demo3` 200 | 3 floors, 7 flash, 2 strobe, 4 glow, 1 fire flicker, no soundtarget |

   Active doors, platforms, floors, every light type the demos have, scrollers and soundtargets are all in. **No demo produces** (`-testcensus` over the 11 demos and the title-loop demos the game plays after them, the maximum of each kind of thinker): ceilings (crushers), stopped ceilings and platforms, light fades, elevators, friction and pushers. AC1's size and trip check covers those. The only fields that differ between machines and are not game state: the automap flag `ML_MAPPED` in the lines section (what the renderer saw, `bugs.md` L41; the test plays `-nodraw`) and `botrandom`, a network variable the game changes and saves in its config (the test starts every run with an empty home).
3. **Cross loads: pass**, `tests/savegame-portable.sh --full`: **116 checks, 0 failed, 527 s**; without `--full` (the first wasm-written save of each demo only) 96 checks, 430 s. Every save, written by native and by wasm, loaded by native and by wasm (`-timedemo DEMO -testload FILE`): the two `-testdump` files of 1,100 records (1,099 tics after the load, at least 35 x 30) are identical; the first record of each, the state as loaded, equals the saver's record at the save tic (players, mobjs, sectors and lines with their soundtargets, sector effects, random state), and the thinkers by type and soundtargets the load holds are the ones the save held.
4. **L30: pass, both ways** (`tests/savegame-old.sh`, `d1demo3` tic 1200, 94 sectors with a soundtarget). On the build from before F2 (`72924ef` with this tree's `test_dump.c`): the state as loaded differs from the state as saved in `total`, `mobjs` and `world`, and 94 sector lines differ in `soundtarget` (`sector 0: soundtarget: 0 -> -1` and so on; the other 14 lines are mobj fields: `height` of corpses, L36, and `ceilingz`, L39). On the new build: `identical (tic 1200 and tic 1): total 5f565e9a`.
5. **Old saves load: pass.** The old build saves a savegame file at tic 1200 (13,733 bytes, version 149, the raw layout); the new build loads it (`-testload`), plays 1,099 tics and exits 0. The random state, the sector effects (the `specials` hash) and every sector, line and side are the ones the old build saved, but for the `soundtarget`, which the old layout does not hold. Also checked: the new build refuses the old layout when it is the server's savegame ("Invalid savegame: the server is an older build"), the old build refuses the new one ("wrong version"), and a join over UDP between the two builds, both ways, prints that line and loads nothing (the client goes back to searching, `bugs.md` L42). The old build is made by the test in a `git worktree` in `/tmp`, removed afterwards (`git worktree list` shows nothing left); no savegame is committed.
6. **The join still works: pass.** `tests/net/test-hot-join.sh` 57 s (1,439 identical records, tics 356 to 1,794), `--together` 46 s (1,436, from tic 1), `--no-force` 56 s (1,444); `tests/net/test-relay.sh --runs 2` PASS 192 s (two clean cases and two with `VNET_IMPAIR=lat=30`); `tests/net/test-relay-errors.sh` PASS 144 s.
7. **Nothing else changed: pass.** `tests/demo-hash.sh` 11 of 11 identical, 367 s; `tests/draw-independence.sh` PASS 93 s; `tests/sprite-column-oob.sh` 6 passed, 60 s; `tests/asan-demos.sh --rebuild`: 53 sites, 53 known, 0 new, 243 s (the nine savegame sites of `tests/asan-known.txt` are the same left shifts of L10, at their new line numbers; the hot-join part of that script fails its comparison as before, L29, and only its reports count).
8. **Each new check fails when what it checks is broken** (throwaway patches to `src/p_saveg.c`, each reverted with `git checkout` and the builds redone):
   - **A raw write back** (the door writes `sizeof` from `offsetof( vldoor_t, type )` raw): `tests/savegame-portable.sh --only d1demo2` printed `FAIL native and wasm print different sizes: < size door 41 roundtrip FAIL > size door 37 roundtrip FAIL`, `FAIL AC2 the saves differ: ... s400.sav ... s400.sav differ: char 14454` (the save with a door; the save with platforms only stayed identical) and `FAIL AC3 native-written save: a loading run failed (native exit 255, wasm exit 255)`; 6 passed, 4 failed.
   - **`soundtarget` dropped from the save** (`SG_soundtarget_detect` returns false): `--only 'd1demo3|fd2demo1'`: every save with a soundtarget fails, for example `FAIL AC3 state as loaded by native != state at tic 800 when native saved: records differ (tic 800 and tic 1): total, world` and `FAIL AC3 the load holds something else: saved [... soundtarget 58] loaded [... soundtarget 0]`, and only `total` and `world` differ (the soundtarget is in `world`); 17 passed, 24 failed. The same on the build from before F2 is AC4 above.
   - **An old save read as the new layout** (`sg_portable = 1` always): `tests/savegame-old.sh --no-join`: `FAIL the new build did not load the old savegame file and play on (exit 255, 0 records): Warn: LoadGame: Invalid sync | Legacy save game sync error | Error: -testload: .../file.sav is corrupted`, and the specials, random state and sectors checks fail; 4 passed, 6 failed.
   - **The refusal of the old layout removed**: `tests/savegame-old.sh`: `FAIL the new build did not refuse the server's savegame of the old layout: TEST: load holds: ...` (it loads it: same pointer size) and `FAIL new client, old server: no message that the savegame is of an older build`; 10 passed, 2 failed.

**Decisions for the coordinator**

- **L36 to L40 are fixed here, and they change what a load or a join does.** They are in `p_saveg.c` and each is small, but they are fixes to upstream behaviour the brief did not list: the loader reset a saved radius and height (corpses stood up), made a corpse with health 0 into -10, read `flags3` as 0 when it is the type's, made `ceilingz` from the sector (stale values differ), and a landed player had the default view height. Without them AC3 cannot pass: the state hash, which the brief says must be equal at load and at save, showed each of them in a different demo. L36 to L38 change no format and are in a commit of their own (message written for upstream, `git format-patch` gives a patch for `src/`); L39 and L40 add two fields to the portable layout. Say if you want any of them out; AC3 then needs a different way to compare.
- **A savegame taken in a demo needs the demo's settings to be loaded.** A demo changes the compatibility switches and `mobjinfo` (for example the blood: `G_Downgrade`); a savegame does not hold the demo version. `-testload` therefore runs under `-timedemo DEMO` (it keeps what the demo set up and takes over from it at the first tic). In a game that is joined all machines run the same version, so this is a property of the test, not a bug of the join.

**Concerns and what is not done**

- The loaded game of `-testload` is a single-player game, not a joining client: it shares `P_Savegame_Read_header( .., netgame )` and `P_Savegame_Load_game()` with `CL_Load_Received_Savegame`, not the `PT_SERVERCFG` handling around them. The join itself is tested by `test-hot-join.sh` (native, UDP) and not between a native and a wasm instance (brief 04 has the transport for that).
- The loaded games run in real time (35 tics a second), so a case takes 35 s; the whole of `--full` takes 9 minutes with three runs at once.
- A failed load in a join returns the client to searching without ending the game of the server (`bugs.md` L42); I did not change that.
- Bots are not in the savegame (L23, F3), view bobbing is not (L25), and the item respawn queue, FraggleScript and the body queue are not exercised by any demo; the savegame code for them was not touched.
- `-testcensus` made a full demo run take minutes (it walks the sectors every tic); it is used only to survey.
