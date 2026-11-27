# F3: bots and joining a game in progress

## Goal

A game with bots can be joined in progress and stays in step on every machine, the players already there included. Adding a bot with a long name no longer smashes the server's stack. We also find out whether native and wasm bots make the same moves, for the mixed native and browser games of D1. It fixes `bugs.md` L23 and L24.

## Read first

- [`README.md`](README.md): D1, D2, D4.
- [`code-facts.md`](code-facts.md):
  - §4 (the join);
  - §5 (consistency and the repair download);
  - §7 (the floats: bot aiming uses `atan`, `b_game.c:742`; the bot node grid uses `float` and `ceil` at level start, `b_node.c`);
  - §8 (the savegame, now portable: F2);
  - §11 (the state hash).
- [`bugs.md`](bugs.md): L23, L24, L29 (a slow joiner diverges; not this brief), L43 (unbounded indices in the loader).
- The Outcomes of [00](00-baseline.md), [01](01-vnet-transport.md) and [F2](F2-portable-savegame.md). F2 is the model for the savegame work and its tests.
- The bot code:
  - `src/b_bot.h` (`bot_t`);
  - `src/b_game.c` (`B_BuildTiccmd`, `B_forget_stuff` at `:1612`, `Command_AddBot` at `:406`);
  - `src/b_search.c` (the path search);
  - `src/b_node.c`, `b_node.h` (the node grid, `SearchNode_t`);
  - `P_Archive_Bots` and `P_UnArchive_Bots`, `src/p_saveg.c:4126-4255`;
  - `Got_NetXCmd_AddBot`, `src/d_clisrv.c:4258`.

## What is known

- **Every machine runs every bot.** `G_Ticker` calls `B_BuildTiccmd` for every bot on every machine (`g_game.c:1761-1763`: "All clients run the bots, identically"). So everything in `bot_t` that a later ticcmd depends on is game state, exactly like a mobj's fields.
- **The savegame keeps only part of `bot_t`.** It keeps skill, `lastNumWeapons`, flags, `what`, `turn_timer` and the mobj pointers. It drops these:
  - the timers `blockedcount`, `avoidtimer`, `strafetimer`, `weaponchangetimer` and `runtimer`;
  - `lastMobjX` and `lastMobjY`;
  - `path` and `destNode`.
- **Saving changes the server's game.** `P_Archive_Bots` calls `B_forget_stuff` (`p_saveg.c:4181`), which clears `destNode` and `path` on the machine that saves. That is how upstream keeps a joiner, which starts with no path, in step with the server. But the players already in the game don't forget. When a third player joins, the server and the players already there can part.
  - The two-player hot-join test can't show this, because there the only other machine is the joiner.
  - A single-player save also changes the saving game.
- **What the tests show today:**
  - `tests/net/test-hot-join.sh --bots` fails at the first tic after the load (`bugs.md` L23).
  - `--together` with a bot passes.
  - The state hash records only whether a player is a bot (`test_dump.c:292`), not the bot's state.
- **L24:** `Command_AddBot` writes the player number, the colour and a name of up to `MAXPLAYERNAME` (21) bytes into `byte buf[10]` (`b_game.c:406`, `:428`).
- **Two unbounded player numbers, the same family as L43:**
  - `P_UnArchive_Bots` checks `playernum > MAXPLAYERS`, which should be `>=` (`p_saveg.c` after `READBYTE(save_p)` in that function).
  - `Got_NetXCmd_AddBot` masks the number with `0x7F` and indexes `playeringame[]` and `players[]` with it, unchecked.

## In scope

### 1. A bot's whole state in the savegame

- **Audit `bot_t` and everything else a bot's decisions read** that is not already in the savegame or rebuilt the same way on every machine at level start. Check in particular:
  - the A* scratch fields of `SearchNode_t` (`visited`, `cost`, `f`, `heuristic` and the rest): are they reset before every search, or do they carry over from one search to the next?
  - any `static` in `b_game.c`, `b_search.c`, `b_look.c` and `b_node.c` that persists across tics;
  - `B_Random`'s state (code-facts §5 says the repair copies it; check that the savegame holds it too);
  - anything that depends on the order bots were added.

  List what you found in the Outcome, and what each item does now.
- **Save all of it in the portable layout,** field by field at fixed widths, as F2 did. `destNode` and every node of `path` are written as grid coordinates or indices into `botNodeArray`, never as pointers, and rebuilt on load.
- **Remove `B_forget_stuff` from the save path,** so that writing a savegame no longer changes the saving machine's game. Keep `B_forget_stuff` where it is still needed (for example when a bot is created or destroyed).
- **Old saves still load.** A savegame of the 1.48 or 1.49 bot layout, and one from F2's build (`claudeai` at `bc6df14`), must still load. Old bot data is read as it is today, with the new fields at their defaults.
  - The portable layout has not been released, so you may extend it without a new version number. If you do, a join between F2's build and this one must still be refused cleanly or work, never misread.
  - Say what you chose and why, and record it in `code-facts.md` §8.
- **The state hash:** add the bot state to `-testdump` (`src/test_dump.c`), so the tests compare the bots themselves and not only their effects. The 11 demos have no bots, so their hashes must not move.

### 2. L24 and the player numbers

- **Size the `Command_AddBot` buffer** for the longest name and its terminator, for example `byte buf[2 + MAXPLAYERNAME + 1]`.
- **Bound the player number** in `P_UnArchive_Bots` (`>=`, and abort the load as other loader errors do) and in `Got_NetXCmd_AddBot` (ignore the command and warn). These are small and sit in the code you are changing. The rest of L43 stays out of scope.

### 3. Native against wasm bots (measure first, then make them the same)

**Changed by the user's decision of 27 Nov 2026:** the brief first said to measure and stop. The user allowed changes of bot behaviour (bots are a feature of this port, not of Doom). So: measure on the unchanged bot code and report; then replace the libm `atan` of `B_AimWeapon` by a deterministic integer or table version (the engine's `tantoangle`), keep the aim close and report the largest difference; then the native-against-wasm comparison on the new code must be identical, and it is an acceptance check. The same for any other libm call or float on a per-tic path. Demo compatibility may break if stated in the docs (the user, the same day).

- **Run the same bot game on both builds** and compare the `-testdump` records tic by tic. Use one or two bots in a level with monsters, so that they aim and shoot, from the same start, with no human input, for at least 35 × 60 tics. A demo is no good for this: during playback the demo's ticcmds replace the bot's (`g_game.c:1765-1767`), so a different aim would never show.
- **Report the first tic where they differ, if any, and what differs.** If they differ, trace it to its cause: `atan` in `B_AimWeapon`, the node grid's floats, or something else.
- If they agree, say how often the bots aimed (how many `atan` calls in the run), so we know the test reached the code.
- Then change the aim (see above) and rerun on the new code; the script prints the number of aims.

### 4. Tests

- **`tests/net/test-hot-join.sh --bots`** must pass. Make it add two bots with long names, so that it also covers L24, and make it a default part of what the coordinator runs.
- **A three-machine check:** the server, a player there from the start, and a player who joins in progress, with bots. All three `-testdump` files must agree on every tic they share. This is what shows the save-time forgetting. Extend `tests/net/test-relay.sh` with `--bots`, or the UDP hot-join test with a third machine, whichever is simpler and fits the machine limits.
- **The native and wasm bot run of item 3:** a script under `tests/`, bounded, printing the first difference or "identical" with the record count and the `atan` call count.
- **The savegame tests:**
  - `tests/savegame-portable.sh` gets a bot case: a save with bots is byte-identical on native and wasm, and the state at load equals the state at save, bot state included.
  - `tests/savegame-old.sh` still passes.

## Out of scope

- **Changing how bots think or aim** beyond what item 3 and the determinism of the state need (the user's decision of 27 Nov 2026 allows the changes that item 3 makes, not a redesign).
- **The rest of L43** (sector, line and inventory indices).
- **L29** (a slow joiner), **L31 and L35** (a lossy link, F4).
- **Bot names and colours** from `rand()` (`cv_bot_gen == 4`, outside `G_Ticker`), unless the audit shows they reach the game state.

## Acceptance criteria

1. **Join with bots, two machines.** `tests/net/test-hot-join.sh --bots`, with two bots with long names, passes in the default, `--together` and `--no-force` modes, with the bot state in the hash.
2. **Join with bots, three machines.** The three-machine check passes in at least three runs out of three. On `claudeai` before this chunk, it fails; show both. If the old build passes anyway (for example because the forgotten path never changed a ticcmd in that run), find a run that shows the problem, such as a longer one, or a level where the bots follow long paths, and say what it took. If none does, report it rather than weakening the check.
3. **No save-time side effect.** A game that writes a savegame (with `-testsave`) at tic N plays on with `-testdump` records identical to the same game that does not save, for at least 35 × 30 tics after N.
4. **Savegames:**
   - a savegame with bots is byte-identical on native and wasm;
   - the state at load equals the state at save, bots included, on both builds;
   - old saves load, as in-scope item 1 says;
   - `tests/savegame-portable.sh` and `tests/savegame-old.sh` pass.
5. **L24 is fixed.** On `claudeai` before this chunk, adding a bot with a long name aborts the server ("stack smashing detected"), or the ASan build reports it. On the change, it doesn't. Show both.
6. **Native against wasm bots** (changed by the user's decision of 27 Nov 2026; before, this criterion was the report of a measurement, and a difference stopped the brief): measured on the unchanged bot code and reported; then, with the aim from the table, `tests/bots-native-wasm.sh` must give identical files for at least 35 × 60 tics with at least 100 aims, and must fail when the two builds differ (shown with libm `atan` put back in the native build only). The largest difference in aim from the old code is reported. `tests/demo-hash.sh` stays 11 of 11.
7. **Nothing else changed:**
   - `tests/demo-hash.sh` 11 of 11;
   - `tests/draw-independence.sh`;
   - `tests/sprite-column-oob.sh` 6 of 6;
   - `tests/net/test-hot-join.sh` in its three modes without bots;
   - `tests/net/test-relay.sh`;
   - `tests/net/test-relay-errors.sh`;
   - `tests/asan-demos.sh --rebuild` with no new site. Update the line numbers in `tests/asan-known.txt` if your change moves them, and check each is the same site.
8. **Each new check fails when what it checks is broken.** Show each with a throwaway patch, reverted afterwards. For example:
   - drop one bot timer from the save: AC1 and AC4 fail;
   - put `B_forget_stuff` back in the save path: AC2 and AC3 fail;
   - shrink the buffer back: AC5 fails.

## Dependencies

00, 01 and F2 (done).

## Notes

- **Git:** work on `browser/F3-bots-hot-join` in `doomlegacy-browser`, from `claudeai`.
  - Commit at each milestone and push only that branch.
  - Never merge, never touch `claudeai` or `main`, never open a pull request, never force-push.
  - `ext/vnet` and `jfsw-browser` are read-only.
- **Commits:** end each with the attribution lines the coordinator gives you. No model names in commits or docs.
- **Upstream style:** keep the changes in `p_saveg.c`, `b_game.c` and `d_clisrv.c` small and in upstream's style, as F2 did. Put the fixes of upstream bugs in commits of their own where you can, and put the test hooks in `src/test_dump.c`.
- **Machine limits:** each headless game uses 100% of a core (L7), and the container has 4 cores. A three-machine test uses three of them, so run one multi-process test at a time, and kill every process you start. The relay tests are sensitive to timing.
- **Blocked hosts:** report a blocked host; don't work around it.
- **Stop and report** if the fix needs any of these:
  - a change to the network protocol beyond the savegame;
  - (removed by the user on 27 Nov 2026: a change to how bots think, and a difference between native and wasm bots; item 3 now fixes the second.)

## Outcome

Status: **implemented, 27 Nov 2026; awaiting review.** All eight criteria pass. Two scope changes by the user on 27 Nov 2026 came in the middle of the work (bot behaviour may change; demo compatibility may break if the docs say so): see "Decisions for the coordinator". The bot-state work found two things the brief did not name (the address in `regulate()`, `oksector`: `bugs.md` L45, L46) that the join could not have carried.

**What landed** (commits on the branch, in order)
- `9c50bd8` L24 and the two player numbers, in upstream's style, alone: `byte buf[2 + MAXPLAYERNAME + 1]`; `Got_NetXCmd_AddBot` skips the command with a warning for a number of `MAXPLAYERS` or more; `P_UnArchive_Bots` tests `>=` and aborts the load.
- `742d270` `regulate()` in `b_look.c` takes the player number, not the address of the mobj (L45). A change of bot behaviour, alone.
- `3ea7743` the savegame holds a bot's whole state: section `SYNC_botstate`, `oksector` saved and reset at level start (L46); `B_forget_stuff` is out of the save path.
- `f1534b2` the state hash holds the bots; `-testaddbots`; `tests/net/test-hot-join.sh --bots`, `tests/net/test-relay.sh --bots`.
- `e631aa2` bot aiming without libm: `B_Slope_Angle` from `tantoangle` (user's decision of 27 Nov 2026). A change of bot behaviour, alone (the counters and `BOT_AIM_COMPARE` of the measurement are in it).
- the next commits: `tests/bots-native-wasm.sh`; the bots stage of `tests/savegame-portable.sh`; the hash leaves out `specialsector` (L44) and the colour translation of `tflags`; the line numbers of `tests/asan-known.txt`; the docs.

**The audit** (what a bot's decisions read, and what each does now; the same table is in `code-facts.md` §8)
- Saved before and still: skill, `lastNumWeapons`, flags, what, turn timer, the eight mobj pointers; `B_Random`'s index (misc section).
- Lost before, saved now (32 bits each): `blockedcount`, `avoidtimer`, `strafetimer`, `weaponchangetimer`, `runtimer`, `lastMobjX`, `lastMobjY`.
- `destNode` and the path: were cleared on the saving machine by `B_forget_stuff` (saving changed the saving game) and empty on the joiner; now saved as grid coordinates (rebuilt on load, bounds checked), nothing is forgotten when saving. `B_forget_stuff` stays, unused.
- `oksector` (`b_node.c`): kept between path queries, never saved, stale across levels (L46): saved, and NULL at every level start.
- `regulate()`: the address of the bot's mobj (L45): the player number.
- `atan` in `B_AimWeapon`: libm: `tantoangle` and integers.
- `SearchNode_t` scratch (`visited`, `cost`, `f`, `heuristic`, `pprevious`): not state: each is set when a node is first pushed in a search before anything reads it, `visited` is reset for all nodes after each search. `heapArray[size]` read by `B_PQTrickleDown` is always a slot written earlier in the same search.
- Statics: `bot_speed_frac` and `bot_run_tics` are set again for each bot with the default speed `botskill` (scratch; hashed otherwise); `bot_looker_mobj`, `bot_dest_mobj`, `bot_last_sector`, `last_s`, `bot_door_found`, `bot_tele_dest_found`, `botteledestx/y`, `botteletype` are set at the start of each query. The node grid is built at level start from lines and sectors alone (`players[0].mo` is NULL then), the same everywhere. Bots run in player-number order; `botinfo` (names, colours) is the server's own and never reaches a ticcmd.
- **Not changed, open:** a pointer a bot holds to a mobj that was removed (an item another player picked up) dangles until the bot looks again. No run showed it. The loader makes it NULL.

**Versioning choice.** No new version number (the portable version stays 10149): the state is an optional section after the bots, so a savegame without bots is F2's bytes. F2's build reading an F3 savegame with bots stops at the new sync byte ("Legacy save game sync error", "Can't load the level"): refused, never misread. F3 reading an F2 savegame (file or join) loads it with the new fields empty. `code-facts.md` §8.

**Native against wasm bots** (E1M3 of Freedoom 1, skill 4, two bots with 9-letter names added at tic 10, no human input, `-nodraw`, 2,800 tics, both builds at once, `tests/bots-native-wasm.sh`)
- On the unchanged bot code (pre-F3 `b_look.c` and `atan`): **different, first difference at tic 111** (random state, players), before any `atan`: the address in `regulate()` (L45). The atan counts also differ (573 and 687).
- With L45 fixed and libm `atan` still in both builds: **identical, 2,800 records, 779 `atan` calls, the same hash of all 64 bits of every result.** So glibc and Emscripten's `atan` agreed on this run; it is not proof for all inputs.
- With `B_Slope_Angle` (the change the user allowed): **identical, 2,800 records, 779 aims, same hash of the aim values.** Largest difference from the libm aim over three runs of two bots (E1M1: 36 aims, E1M2: 699, E1M3: 779): **5 units of the 65,536 per turn of `cmd.aiming` (0.03 degree)** (1 unit on E1M1, 5 on E1M2 and E1M3).
- Failure proof: libm `atan` put back in the native build only: first difference at **tic 101**, aim hashes `44dcf61d` against `6083667b`.
- No other libm call or float is on a bot's per-tic path (`b_look.c`, `b_search.c`, `b_game.c`: grepped). The node grid's `float` and `ceil` agree on both builds (the runs above are identical, grid included).

**Tests and numbers** (all on this machine, 4 cores, one test at a time)
- `tests/net/test-hot-join.sh --bots` (two bots with long names, state hashed): default 56 s, `--together` 45 s, `--no-force` 57 s, all PASS; also `--join-after 25 --play 60` PASS (2,144 identical records, tics 887 to 3030). The bot-less runs in the three modes: PASS, 56, 45, 57 s. Identical records, default: 1,439 (tics 360 to 1798).
- `tests/net/test-relay.sh --bots` (server, A from the start, B joins in progress, bots with long names): 3 of 3 PASS (136 s for three runs; later 45 s once more). `tests/net/test-relay.sh` (clean and impaired): PASS 95 s. `tests/net/test-relay-errors.sh`: PASS 143 s.
- `tests/savegame-portable.sh`: AC1 sizes, 7 demos with 12 saves, and the bots stage: all pass (116 checks, 573 s on the first full run, which also showed the colour translation, below; the bots stage alone passes 3 of 3 afterwards, 147 s each). The stage: the game that wrote two saves and the game that wrote none, 2,800 identical records (1,100 after the last save); saves at tic 1300 and 1700 (19,179 and 19,718 bytes) byte for byte the same on native and wasm; they hold 2 bots and 201 path nodes between them (one with a destination); each loaded by native and by wasm plays on 1,100 identical tics; the first record equals the saver's.
- `tests/savegame-old.sh`: PASS, 130 s (it builds the pre-F2 tree with this `test_dump.c`). The F2 build (`bc6df14`) saves still load (no section: bots start empty).
- `tests/bots-native-wasm.sh`: identical, 2,800 records, 779 aims, 83 s.
- `tests/demo-hash.sh`: 11 of 11 (284 s; again after the last change to the hash, see below). `tests/draw-independence.sh` PASS 92 s. `tests/sprite-column-oob.sh` PASS 61 s. `tests/asan-demos.sh --rebuild`: 53 sites, all known, 0 new, after renumbering nine `p_saveg.c` lines in `tests/asan-known.txt` (the same nine sites: shifts of negative values and `1 << i`); its hot-join ASan run still diverges at a slow client (L29, reports only).

**Failure proofs (AC8)** (throwaway patches, reverted; builds in `build/<name>`)
- Before the chunk (`bc6df14`), three machines with bots: the server aborts at tic 10 with "stack smashing detected" (L24; `+botgen 1 +botrandseed 136` names of 9 letters). With only L24 and L45 applied to it, the three-machine test fails: server and A agree, B differs from its first tic (360) and is kicked at tic 474.
- `weaponchangetimer` dropped from the save: `test-hot-join.sh --bots` fails at tic 361 with "Consistency failure" in the log; the bots stage of `savegame-portable.sh` fails (the state as loaded differs from the saver's at tic 1300).
- `B_forget_stuff` back in the save path: `test-relay.sh --bots` fails in 2 of 3 runs (B differs at tic 365; 3 of 6 runs over two batches); the bots stage fails "saving changed the game: first difference at tic 1301". Server and A stay the same in these runs (a forgotten path is mostly found again the same way); the failures are B's.
- `byte buf[10]` back: `test-hot-join.sh --bots` ends in 3 s, "stack smashing detected".
- Pointer in `regulate()` back: `--bots` hot join fails at tic 361 (the first tic after the load); native against wasm, tic 111.
- libm `atan` in the native build only: tic 101 (above).
- Each shown on the build named; the checks that failed are the ones named.

**Decisions for the coordinator**
1. **Changes of bot behaviour, by the user's decision of 27 Nov 2026**, each in a commit of its own: `regulate()` uses the player number instead of an address (needed: without it a bot game cannot be the same on two machines, and `--bots` fails at the first tic); the aim comes from `tantoangle` (at most 5 of 65,536 units from `atan`); `oksector` is saved and reset at a level start.
2. **Demo compatibility is broken for demos recorded with bots, stated in `bugs.md` L47 and `building.md`.** During playback `G_Ticker` still runs the bots, then replaces the ticcmd (`g_game.c:1765-1767`); `B_Random` and the bot code's own changes to the game (zeroing the bot's momentum at an edge, `damagecount`, `MF_JUSTHIT`) stay. A demo with bots recorded on the pre-F3 build (E1M3, skill 4, 1,600 tics): played twice on that build, the files differ from tic 12 (it did not reproduce even before); on the F3 build they differ from tic 12 too. So bot demos were already not reproducible, and are not now. The 11 demos have no bots and are unchanged: `tests/demo-hash.sh` 11 of 11. I'll leave the README's settled decisions to you.
3. **The three-machine check sees the join's own state more easily than the forgetting.** With the save-time forget back, the server and A stay in step in every run I made; B parts. The brief's expected failure (the server parting from a player already there) did not show, as the brief allowed for ("a forgotten path never changed a ticcmd"); I did not find a run where it does. I report it rather than weakening the check.
4. **`+addbot` on the command line makes the host a bot** (L48), which is why the old `--bots` test was never a test of a human host. The tests add bots with `-testaddbots TIC N` (test-only, `src/test_dump.c`).
5. **The hash leaves out `specialsector` (L44, not saved) and the colour translation bits of `tflags`** (a loaded game re-sends the bots' colours from a table that differs from run to run; found when one savegame loaded twice differed at tic 4). Both are cosmetic or message-text only. The 11 demos still agree native against wasm.
6. **Open, not changed:** bots keep pointers to mobjs that were removed. An F2 build joining an F3 server with bots is refused with a sync error rather than a version message. The rest of L43 and L29 are untouched.
7. The F3 build's `-testsave` and the old build's (`bc6df14`) were used as `old` and `old2` in the scratchpad with a copy of this tree's `test_dump.c`; nothing of them is committed.

### Fix round 1 (27 Nov 2026, after the independent review)

Commits: `a54f34d` (grid, level start, rounded aim, `regulate`), `7045548` (loader and refusal), `523a6fe` (tests, hash), `7d4bd8b` (docs, `-testcmd`), `890cb0b` (`bots-level-start.sh`), and the commit of this section. The container restarted before the round began; the work was redone from the committed tree and pushed at each step.

1. **The loader read past the buffer (should-fix 1).** `P_UnArchive_Botstate` bounds the path length by `numbotnodes`, reads in pieces of 1,024 nodes, checks each piece against the bytes the file has (`SG_have`: `extfile.bufcnt` for a file, the buffer size otherwise) and against `save_game_abort`, and checks every node against the grid. New `tests/savegame-malformed.sh` (26 s): a real E4M8 bot savegame, truncated with a path length of 60,000, cut mid-record, a length of 2,000,000, a node at x = 99999, a record for player 31, each loaded under ASan: all refused. On the ASan build of the tree before the fix (`be5e9ba`): truncated-long is an AddressSanitizer heap-buffer-overflow in `read_32`, bad-node loads, no-state is not refused (4 of 9 checks fail).
2. **The node grid depended on slot 0 (should-fix 2).** The doc row was wrong: `players[0].mo` is set when `B_Init_Nodes` runs if slot 0 is in the game, because `P_SetupLevel` spawns the players first. Then `B_CheckNodePosition` (the player's radius) and traversals that count solid, non-shootable map things apply; with slot 0 empty one lines-only traversal runs. (a) At a join or `-testload` the saved mobjs are not in place when the grid is built (the level is made from the WAD first), so the things are the fresh map spawns on every machine, as at the server's level start: no divergence from moved or destroyed things. (b) Slot 0 empty on one side does change the grid: measured on E1M3, the grid hash is `-569677420` with slot 0 (the old code, and the fix: identical) and `-667500429` when the mobj is NULL, and `oksector` differs too. Fixed: `B_Build_Nodes` uses a probe with the player's radius, so the grid is the one the common case builds, whoever is in the game (bot behaviour in a normal game is unchanged: the same grid hash as before). The grid is in the state hash (`B_Grid_Hash`, once per level), so the join tests compare it. Not reachable by a test (a dedicated server cannot load a level, L33), so the proof is the measurement. `bugs.md` L51; the `code-facts.md` §8 row is rewritten.
3. **Builds before F3 (should-fix 3).** An F3 client refuses a join whose savegame has bots but no `SYNC_botstate`: "the server's savegame has bots without their state: it is from a build before the bot changes (F3), whose bots play differently. Join refused." A savegame file without it still loads (single player), the new fields empty: my choice, since a single-player load has no peer to part from. `code-facts.md` §8 and `building.md` say plainly that builds before F3 cannot share a bot game with F3. `savegame-malformed.sh` checks both (no-state-net refused, no-state-game loads); the old tree loads the stripped join savegame.
4. **The bot tests did not check for bots (minor 4).** `-testdump` prints `TEST: bots in game: N at gametic T` on a change; `test-hot-join.sh --bots` requires 2 in the server's and the client's log, `test-relay.sh --bots` in all three. With `-testaddbots 10 0` (broken) both fail ("the log says there were 2 bots in the game", 2 of 2 and 3 of 3 checks), though the hot-join files still compare identical. The stale "FAILS today" help text is gone.
5. **The colour mask (minor 5).** Logged as `bugs.md` L49 with the reasoning (not a join desync; `teamplay` Color reads `skincolor`); the mask is commented in `test_dump.c`. I did not hash `skincolor`: after a single-player `-testload` the local `botinfo` table gives it a different value on every run, which is the flakiness the mask was added for.
6. **Aim error (minor 6).** The slope index is rounded to the nearest table entry. Over 3,000,000 random inputs: 6 units cut off, **3 rounded**. Measured on E1M1, E1M2, E1M3 (skill 4, two bots): largest difference from libm `atan` **3** units of 65,536 (0.016 degree), 1,109 aims. `tests/bots-native-wasm.sh`: identical, 2,800 records, 557 aims, same hash of the aim values (83 s); `tests/demo-hash.sh` 11 of 11.
7. **Floats (minor 7).** `code-facts.md` §7 now says that `b_node.c:42-45` converts through `float` every tic (IEEE single precision, an exact power-of-two division), the same on x86_64 and wasm, with the identical native and wasm bot runs as the evidence. Not converted.
8. **`regulate()` (minor 8).** The `>>1` is gone: players 2 and 3 have different phases.
9. **Stale pointers (minor 9).** `B_Level_Start`, called from `B_Init_Nodes`, clears every bot's destination, path and eight pointers at each level start (`bugs.md` L52). New `tests/bots-level-start.sh` (22 s): three bots (one at slot 0, which `B_SpawnBot` never resets), `map e1m4` at tic 600 (`-testcmd`, new): before the change 3 bots with 3 destinations and 19 path nodes, after it 0 and 0. With the call removed (throwaway): 1 destination and 7 path nodes survive in the new level, and the test fails.
10. **Logged only.** `bugs.md` L50: a savegame does not hold `gametic`; a single-player load (and `-testload`, which restarts it at 1) differs from the saver's continuation when something reads the absolute `gametic`, and the bots do. Not an effect on a join: the client's `gametic` is the server's. Not logged before.

**Tests of the round** (this machine, one at a time): `tests/bots-native-wasm.sh` identical 2,800 records, 557 aims, 83 s; `tests/bots-level-start.sh` PASS 22 s; `tests/savegame-malformed.sh` 8 of 8 PASS 26 s; hot-join `--bots` default 56 s, `--together` 45 s, `--no-force` 57 s, and the same three without bots (56, 45, 57 s): all PASS; `tests/net/test-relay.sh --bots` 3 of 3 PASS (135 s); `tests/net/test-relay.sh` PASS 96 s; `test-relay-errors.sh` PASS 143 s; `tests/savegame-old.sh` PASS 133 s; `tests/demo-hash.sh` 11 of 11 (318 s); `tests/draw-independence.sh` PASS 92 s; `tests/sprite-column-oob.sh` 6 of 6 PASS 61 s; `tests/asan-demos.sh --rebuild` 53 sites, 0 new (251 s; nine `p_saveg.c` lines renumbered in `tests/asan-known.txt`, the same nine sites). **The whole `tests/savegame-portable.sh`: 117 passed, 0 failed, 14 saves, 575 s.** Its first run after the changes failed one check, which is the check doing its job: with the new bot behaviour the saves at tics 1300 and 1700 of the bot game held no path ("no save holds a bot path"), so the saves are now at tics 800 (a destination and 13 path nodes) and 1700.

**Open decisions:** none new. The guard on the stage means a later bot change that empties the paths at both tics will say so rather than pass.

### Fix round 2 (27 Nov 2026)

- `tests/bots-level-start.sh` now reads the state text (`-teststate 599 603`): at tic 599 (old level) three bots must have a destination, 19 path nodes and 10 mobj pointers set; the first record of the new level (map 4, level time 0, found by its header, not by a fixed distance) must show no destination, no path, and every one of the eight pointers of every bot NULL or a live mobj (a pointer left from the old level shows as -2). 21 s, PASS. With `B_Level_Start` cut down to `B_forget_stuff` (destination and path only): destination and path pass, **4 stale pointers**, FAIL, 21 s.
- `code-facts.md` §8 and `building.md`: the join refusal covers only a savegame that already holds bots, the version is still 10149, so a build before F3 and an F3 build can join a bot-less game and part silently if a bot is added later. No version bump (for the user).
- `code-facts.md` §8: `grid=` is hashed only when a bot exists.

