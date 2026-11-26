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

### 3. Native against wasm bots (measure, don't fix)

- **Run the same bot game on both builds** and compare the `-testdump` records tic by tic. Use one or two bots in a level with monsters, so that they aim and shoot, from the same start, with no human input, for at least 35 × 60 tics. A demo is no good for this: during playback the demo's ticcmds replace the bot's (`g_game.c:1765-1767`), so a different aim would never show.
- **Report the first tic where they differ, if any, and what differs.** If they differ, trace it to its cause: `atan` in `B_AimWeapon`, the node grid's floats, or something else. Then stop and report with the options. Don't change the bot simulation in this brief.
- If they agree, say how often the bots aimed (how many `atan` calls in the run), so we know the test reached the code.

### 4. Tests

- **`tests/net/test-hot-join.sh --bots`** must pass. Make it add two bots with long names, so that it also covers L24, and make it a default part of what the coordinator runs.
- **A three-machine check:** the server, a player there from the start, and a player who joins in progress, with bots. All three `-testdump` files must agree on every tic they share. This is what shows the save-time forgetting. Extend `tests/net/test-relay.sh` with `--bots`, or the UDP hot-join test with a third machine, whichever is simpler and fits the machine limits.
- **The native and wasm bot run of item 3:** a script under `tests/`, bounded, printing the first difference or "identical" with the record count and the `atan` call count.
- **The savegame tests:**
  - `tests/savegame-portable.sh` gets a bot case: a save with bots is byte-identical on native and wasm, and the state at load equals the state at save, bot state included.
  - `tests/savegame-old.sh` still passes.

## Out of scope

- **Changing how bots think or aim,** including replacing `atan`. Item 3 only measures.
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
6. **Native against wasm bots:** measured and reported, as in-scope item 3 says. This criterion is the report. A difference is not a failure of this brief, but it stops the brief before any fix.
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
  - a change to how bots think;
  - a difference between native and wasm bots (item 3).

## Outcome

Status: **in progress.**
