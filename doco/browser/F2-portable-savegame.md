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

(To be filled in by the implementer.)
