# F4: Hot join over a lossy link

## Goal

A client joining a game in progress stays in step with the server when datagrams are lost, duplicated or reordered, as they are on a real internet link. This holds over the UDP driver and through the vnet relay. Four bugs are fixed together:
- L31: `PT_STATE` (pause/unpause) packets can't be put in order;
- L35: a lossy join diverges on the joiner's first tics;
- L54: a rare angle and aiming difference about 47 tics after a join, without loss;
- L53, for games without bots: the walking bob is not in the savegame.

Brief 04 (browser netplay) depends on this: a browser player always joins over a lossy, jittery link.

## Read first

- `bugs.md` **L31, L35, L54, L53** (and L29, which is related but stays with brief 04). Each entry has the evidence, the reproductions and what was tried.
- `code-facts.md` §2 (driver and `doomcom`), §3 (start-up), **§4 (the join, step by step)**, §5 (consistency), §8 (savegame layout: the bob lives in `SYNC_botstate` today), §11 (the state hash), §13 (the vnet driver).
- The Outcome of [01](01-vnet-transport.md): its AC4 was narrowed to latency only because of L31 and L35, and `test-relay.sh`'s default impairment became `lat=30`.
- The Outcomes of [F2](F2-portable-savegame.md) and [F3](F3-bots-hot-join.md): the savegame version (`SG_PORTABLE_BASE + 149`), the optional sections, and how F3 saved the bob only with bots so a bot-less save stayed F2's bytes.
- `tests/net/test-hot-join.sh`, `tests/net/test-relay.sh` (`--impair`, `--keep`, `--state`), and `tests/tools/testdump-diff.py`.
- `src/d_clisrv.c`: `state_handler`, `CL_Queue_Pause`, `server_cfg_handler`, `ExpandTics`, `SV_Add_Join_Waiting`, `SV_Send_AddPlayer`. `src/d_net.c:52-53` and `:456-590` (reliable packets, no receive window).

## In scope

### 1. A reproducible lossy join without root (test tooling first)

- Add a test-only impairment of the game's own datagrams, so the UDP path can be made lossy without `iptables` or root. Examples: `-testimpair loss=3,dup=2,reorder=3,seed=N` in the network layer, or a small UDP proxy in `tests/tools/`. It must:
  - be off unless asked for;
  - be deterministic for a given seed, so a failing run can be replayed;
  - log what it did (counts of dropped, duplicated and reordered datagrams).
- Give `tests/net/test-hot-join.sh` a lossy mode (e.g. `--lossy SPEC`) and a `--runs N` option, if it has none, that reports "k of N passed".
- Before any fix, measure the failure rates on `claudeai` and record them in the Outcome as the baseline:
  - the lossy hot-join;
  - `test-relay.sh --impair lat=30,jit=10,loss=3,dup=2,reorder=3`;
  - the plain hot-join (L54), over many runs.

### 2. L31: order the pause and unpause packets

- Add a sequence number to `PT_STATE`. Appending one byte to `state_pak_t` is the suggestion in L31: older readers ignore it.
- The client's pause queue is ordered by (gametic, sequence).
- An entry for a gametic the client has not run yet is applied whatever the order it arrived in.
- Duplicates are dropped.
- Explain what a peer without the byte does, and why mixed builds are safe or refused.

### 3. L35 and L54: find the cause, then fix it

- Diagnose with packet traces and `-teststate` around the join. L35's first suspect is a stale `PT_SERVERTICS` from before the join, carrying another player mask and arriving late. L54 shows the same symptom (the joiner runs other players' ticcmds that the server did not run), without loss.
- The Outcome states each cause with evidence (the packets and tics involved). If L54 turns out to have a different cause, say so; fix it here if it is in the join's tic handling, otherwise log it with what was found.
- Fix in the smallest way that addresses the cause, in the netcode's style. Do not mask it, for example by forcing a repair or widening the consistency check.

### 4. L53 for every game: save the walking bob

- Save every player's `bob_momx` and `bob_momy` in every savegame, not only in games with bots.
- Bump the portable savegame version (10149 to 10150) and keep loading 10149 saves, whose bob starts at 0 as before.
- A join between a 10150 server and an F3 (10149) client, or the other way round, is refused with the existing clear version message, so test it.
- Include the bob in the state hash for every game, so the tests see it.
- Update `code-facts.md` §8 and §11.

### 5. Defaults and docs

- `test-relay.sh`'s default impairment goes back to `lat=30,jit=10,loss=3,dup=2,reorder=3`.
- Update `building.md` (commands and times), `code-facts.md` §4, and `bugs.md`: mark the fixed entries with the fix; new entries start at L63.

## Out of scope

- L29, the slow joiner, which stays with brief 04, though record anything found that bears on it.
- L43, the loader hardening.
- Any change to game logic outside the join's networking and the savegame's bob.
- Changing vnet (`ext/vnet` is read-only).

## Acceptance criteria

1. **AC1, baseline:** the failure rates of §1, measured before any fix, are in the Outcome with their commands.
2. **AC2, lossy UDP join:** `test-hot-join.sh` in its lossy mode at `loss=3,dup=2,reorder=3`, at least 10 runs with different seeds. All pass after the fix, where the baseline failed.
3. **AC3, lossy relay join:** `test-relay.sh --impair lat=30,jit=10,loss=3,dup=2,reorder=3` passes at least 5 of 5, and `--bots` 3 of 3. This impairment is the default again.
4. **AC4, L31:** a test makes `PT_STATE` arrive out of order on purpose (both L31 cases: swapped within one gametic, and an older gametic after a newer one), and the client applies the pauses at the right tics. It fails without the fix.
5. **AC5, L35 and L54:**
   - each cause is explained with evidence;
   - a seeded reproduction fails before the fix and passes after it (or, for L54 if its cause is elsewhere, the evidence and a log entry);
   - the plain `test-hot-join.sh` passes 30 of 30, and `--bots` 30 of 30.
6. **AC6, L53:**
   - a bot-less save and load keeps the bob (`savegame-portable.sh` checks it, or a new check does);
   - a moving human at the join no longer differs; show it with a test that moves a player across the join, e.g. with `-testcmd`;
   - 10149 saves still load (`savegame-old.sh` or a new case);
   - a mixed-version join is refused with the message.
7. **AC7, failure proofs:** each new test or check fails when its fix is reverted. Show it, then restore the fix. No test is loosened.
8. **AC8, nothing else breaks:**
   - `demo-hash.sh` 11 of 11 (native against wasm);
   - `savegame-portable.sh`, `savegame-old.sh`, `savegame-malformed.sh`, `bots-native-wasm.sh`, `bots-level-start.sh`;
   - every `test-hot-join.sh` mode;
   - `test-relay.sh` (also `--dedicated`) and `test-relay-errors.sh`;
   - `sprite-column-oob.sh`, `draw-independence.sh`;
   - `asan-demos.sh` with no new site;
   - the six browser tests in `tests/web/`.

## Dependencies

F3 (merged). Before 04.

## Notes

- Git: branch `browser/F4-hot-join-lossy` from `claudeai`. Push after each commit. Never merge, never touch `claudeai` or `master`, never open a PR, never force-push.
- Upstream-style, small commits for the netcode fixes, each with its bug number, so they could be offered upstream.
- The machine has 4 cores and each game takes a whole one: run one multi-process test at a time. Many-run measurements take long; run them in the background and say how long they took.
- Never commit game data or built binaries.
- Estimate: about a third of brief 00; more if L35 is deeper.

## Outcome

Status: **done by the implementer, 28 Nov 2026 (review pending).** All eight criteria pass, on the final commits; the code changed after the first full runs of AC2, AC3 and AC5 (the zeroed thinkers, below), so a smaller set was run again on the final code (counts below).

**What landed** (commits on `browser/F4-hot-join-lossy`, in order)
- `e1cf486` `-testimpair SPEC` (`test_dump.c`, called from `HSendPacket`): a seeded lossy send for any driver, no root; `test-hot-join.sh --lossy SPEC --seed N --runs N`.
- `1240895` L35, L54: `servertic_handler` counted a section's ticcmds by tics.
- `9cd98b4` L35: the sections of a tic packet are recorded for the packet's own length.
- `e6dea08` L31: a sequence number in `PT_STATE` (`state_pak_t.seq`), the client's queue ordered by (gametic, sequence), duplicates and superseded changes dropped; `-testpauseorder`, `tests/net/pause-order.sh`.
- `c58a1c9` L53: savegame 10150 holds every player's walking bob, in every game; the hash holds it; `-testwalk`; `tests/savegame-f3.sh`.
- `a2f581d` L31: the join's pause and unpause 10 tics ahead in `PT_STATE` (**superseded** by `336ed5e`, which removes its code; it would be dropped, with `336ed5e`'s removal of it, if the netcode were offered upstream; it stays in the history because its failure is part of the evidence). **Test-only commits:** `e1cf486` (its hook in `HSendPacket` is test code, off without `-testimpair`), `1c45771`, `c2e912f`, and the test files in the others. **Netcode fixes that could go upstream, one bug each:** `1240895`, `9cd98b4`, `8863a63`, `e6dea08`, `712a29f`/`6ad704a`, `336ed5e`/`4803432`, `608d06c`, `b720221`.
- `1c45771`, `c2e912f` tests: `test-hot-join.sh` compares the files as they were while both games ran; `test-relay.sh` impairs with loss, duplication and reordering by default again, and no longer stops on an arithmetic error when a game was killed.
- `712a29f` the tics of a joining node are kept (text commands of the tics between the savegame's and the node's becoming a client were erased before they were sent).
- `336ed5e` L31: the join's pause and unpause are a net command in the tic stream, `XD_NETWAIT`.
- `b720221` savegame load: the sector effects are allocated zeroed. A latent bug that F4 exposed (below, `bugs.md` L67).
- `565dd36` the old-layout refusal comes before the 10149 one; version refusals are logged; the tests that joined builds, the malformed-savegame offsets and `asan-known.txt` follow.
- the docs commit (`building.md`, `code-facts.md` §4, §8, §11, `bugs.md`, this Outcome, `README.md`).

**Baseline (AC1)**, measured on `build/baseline` (the code of `claudeai` plus `-testimpair`, nothing fixed), 4 cores, one test at a time:

| What | Command | Result | Time |
|---|---|---|---|
| lossy hot join | `tests/net/test-hot-join.sh --bin build/baseline/bin/doomlegacy --lossy loss=3,dup=2,reorder=3 --runs 10 --seed 1` | **2 of 10 passed** (seeds 1, 4, 5, 6, 7, 8, 9, 10 failed; first differences at join+31 to +38 tics, except seed 4 which was L31) | 575 s |
| relay, full impairment | `tests/net/test-relay.sh --bin build/baseline/bin/doomlegacy --impair-only --runs 5` (default impairment then `lat=30,jit=10,loss=3,dup=2,reorder=3`) | **1 of 5 passed** | 257 s |
| plain hot join (L54) | `tests/net/test-hot-join.sh --bin build/baseline/bin/doomlegacy --runs 30` | **30 of 30 passed**: L54 did not show in 30 runs (the coordinator saw 1 in 64) | 1,693 s |

(An earlier batch of the relay baseline, with the script before its arithmetic fix, ended after 4 runs: 2 passed.)

**Causes, with evidence**
- **L35, cause A: `servertic_handler` counted ticcmds by tics** (`1240895`). `num_cmds` is the number of ticcmds in a packet section (players times tics) and the loop took one off per *tic*. A client that is behind is sent one `PT_SERVERTICS` of up to 30 tics, 60 ticcmds with two players, and a datagram holds 45 (`NUM_SERVERTIC_CMD`): two sections with the same `starttic` and `numtics`. The first section (45 ticcmds) made the loop copy 30 tics, so the bytes after its ticcmds in the buffer (stale) went into the ticcmd slots of tics 22 to 30, and a section that came again after the other (a resend, a duplicate, reordering) overwrote the right ticcmds of tics the client had not run. Traced with `TRACE RX` lines (not committed): `start 377 end 407 n 31 ... off 0 ncmd 45 flags 8` and `off 45 ncmd 17 flags 1` (both sections), then `start 377 end 408 ... ncmd 45 flags 8` again while the client was at tic 407, and the first difference at tic 401/402: the joiner's own player, angle and aiming (1595932672) and position, whose ticcmd for tic 401 is the 46th, the first of the second section. The same values appeared in runs of different seeds.
- **L35, cause B: section bits recorded for the start tic only** (`9cd98b4`). `netseq[BTIC_INDEX(start_tic)]` holds which sections of the packet have come, and the client takes the packet's tics as present when it is 0xFF. The single-tic packet for tic 376 (complete, 0xFF) and the 30-tic packet starting at 376 share that slot. Trace of the run: `start 376 end 377 ... flags 0`, then `start 376 end 406 need 385 ... ncmd 45 flags 8` and no second section of it ever, then `need 406`: the client ran tics 398 to 405 on the ticcmds of tics 366 to 373. First difference at tic 399, player 1 (the joiner). The fix remembers the packet's length with the bits and starts again when it differs. Not the stale `PT_SERVERTICS` with another player mask that the brief suspected: in every trace the client's mask went from 1 to 3 at its second packet and stayed 3.
- Steps: with only B fixed, 9 of 10 lossy runs passed on seeds 1 to 10 (the failure, seed 4, was L31's: `pause 1 for gametic 361` ignored as older after `pause 0 for 366`); with B and the sequence numbers but not A, 5 of 8 on seeds 20 to 27, each failure with the A signature (`ncmd 45` packets resent after their second section). (Two runs of an intermediate batch, seeds 4 and 8, are not counted: I edited `test-hot-join.sh` while the batch ran it.)
- **L54: probably the same causes, not proven.** The symptom is the same (the joiner's player, stale ticcmd, the same values in runs, about 36 to 47 tics after the join), neither cause needs loss (a long resent packet in two sections is enough, and a client that runs a tic between the two sections), and the plain test passes 30 of 30 after. But 30 plain runs on the unfixed code all passed, so I never had a failing plain run to trace. Logged as such in `bugs.md`.
- **L31, the order of `PT_STATE`** (`e6dea08`). `tests/net/pause-order.sh` feeds the client's pause code every arrival order of four server timelines (a pause and an unpause for one gametic, for the next gametic, and two longer), each change on time, with and without duplicates, sequence numbers wrapping in half: 285 cases. With the old rule transplanted into the same frame (newest gametic wins, same gametic replaced): **140 of 285 fail**, e.g. `1@0 0@0` (the unpause first) leaves the client paused for ever. With the new code 0 of 285.
- **L31, the pause itself** (`336ed5e`). The sequence number was not enough. Through the relay with loss, jitter and reordering the *client that was already in the game* (not the joiner) ran a tic paused that the server ran unpaused, in 3 of 5 runs (and 1 of 5 in the baseline): the server's pause and unpause for a join are announced for one gametic (the server did not pause one tic: `wait_timer 90` at time 434 and the unpause at time 434, logged on the server), the client was at that gametic when the pause came, applied it, ran the tic paused, and the unpause came after. A lead of 10 tics (`a2f581d`) gave 5 of 5 relay and 9 of 10 lossy; the failure (seed 107) was the *joiner* receiving `pause 0 for server gametic 371` at its own gametic 372: the `PT_STATE` was lost and sent again after about 14 tics (the resend timeout of a new node is `ping + 4 * varping`, 400 ms), and the joiner runs the catch-up tics faster than that. So the pause went into the tic stream (`XD_NETWAIT`), where a client cannot run a tic without it. **That exposed a bug of its own** (`712a29f`): the server cleared the text commands of the tics from the joiner's savegame on before the joiner was active, so the joiner missed the pause (3 of 8 hot joins failed with it; the server's packets to the joiner never had tic 360's text, the client's `ExtraDataTicker` found it empty). `SV_Send_Tic_Update` now stops clearing, and making tics, at the lowest `nettics` of a joining node. This also means any other text command in that window (a chat line, a variable) reached a joiner only by luck before.
- **L53** (`c58a1c9`): the bob is in each player's record (after `deltaviewheight`), version 10150. The state hash holds `bob_momx` and `bob_momy` for every game.
- **A latent bug in the savegame loader, found by AC8** (`b720221`, `bugs.md` L67). The first F4 commit, which only added test code, made the bots stage of `tests/savegame-portable.sh` fail (save at tic 1700, native load against wasm load, first difference at tic 2), deterministically, while the F3 tip passed: bisected over `14152ce` (pass), `e1cf486`, `1240895`, `e6dea08`, `c58a1c9` (all fail). Native and wasm consumed different numbers of `P_Random` calls in tic 1 (`PR` trace: 14 more at `p_enemy.c:2039`, `P_LookForMonsters`, on wasm); the friends class-list was empty on native and held two non-mobj thinkers (lights) on wasm. The loader calls `P_AddThinker` on a sector effect before it sets `thinker.function`, `P_UpdateClassThink` sorts by that function, and the block from `Z_Malloc` held a freed mobj's. So a joiner could have a different friends list than the server's, which a bot or dog walks. It is not seen by the hash. Fixed by allocating those thinkers zeroed; the bots stage passes (22 of 22), the full `savegame-portable.sh` 117 of 117.
- **The server's wait is not a wait** (`bugs.md` L64, for brief 04 and L29): `SV_network_wait_timer( 90 )` counts handler calls, not tics. Headless it ends within a tic, with the joiner's node in `NOS_join_timeout`; the join works because the joiner catches up from the savegame's tic. Not changed.

**Acceptance criteria** (counts on `336ed5e`'s netcode; the sets re-run on the final tree, `b720221` and `565dd36`, are named)
1. **AC1, baseline:** the table above, with commands.
2. **AC2, lossy UDP join:** `tests/net/test-hot-join.sh --lossy loss=3,dup=2,reorder=3 --runs 10 --seed 101`: **10 of 10** passed (566 s), against 2 of 10 on the baseline. The script checks from each game's own counters that datagrams were lost, duplicated and reordered (about 40 lost, 25 duplicated, 35 reordered per machine in a run). Final tree: 3 of 3 (seeds 301 to 303, 171 s).
3. **AC3, lossy relay join:** `tests/net/test-relay.sh --impair-only --runs 5` with the default impairment `lat=30,jit=10,loss=3,dup=2,reorder=3`: **5 of 5** (248 s); `--bots`: **3 of 3** (150 s). Baseline 1 of 5. Final tree: 2 of 2 and 2 of 2 bots; the clean cases, `--dedicated` (44 s) and `test-relay-errors.sh` (143 s) pass.
4. **AC4, L31:** `tests/net/pause-order.sh`, 285 of 285; 140 of 285 fail with the old rule (below). The relay and hot-join tests exercise the real packets.
5. **AC5:** the causes are above. A seed does **not** replay a failure (the dice are rolled in the same order, but which datagram each roll hits depends on timing), so the seeded lossy test is a rate: 2 of 10 before, 10 of 10 after. The replayable proof is `tests/net/servertic-sections.sh` (fix round 1, below). L54: no failing plain run existed to reproduce. Plain `test-hot-join.sh --runs 30`: **30 of 30** (1,693 s); `--bots --runs 30`: **30 of 30** (1,692 s). Final tree: 3 of 3 and 3 of 3.
6. **AC6, L53:**
   - a bot-less save and load keeps the bob: `tests/savegame-f3.sh` (a demo game, no bots, the player walking at tic 1200: bob not 0 in the save and in the loaded game, and the state hash, which holds the bob, equal), and the 12 saves of `tests/savegame-portable.sh` (117 checks, 574 s);
   - a moving human at the join: `tests/net/test-hot-join.sh --walk 330 400` (`-testwalk`: the host runs forward across the join, at server tic about 361, with a bob of 574126): passes; with the bob dropped at load it fails at tic 361;
   - 10149 saves still load: `savegame-f3.sh` (a 10149 file, from the build of `14152ce`, loads and plays 1,099 tics) and `tests/savegame-old.sh` (12 of 12, 208 s);
   - a mixed-version join: refused both ways. `NETWORK_VERSION` 27 refuses it first ("Incompatible client", logged by the server and by the client since `565dd36`, which is the clear version message a joiner gets); the savegame check behind it, "Invalid savegame: wrong version", is tested by `-testload` of the server's savegame both ways (`savegame-f3.sh`, 10 of 10, 210 s).
7. **AC7:** below.
8. **AC8**, all on the final tree unless noted:
   - `tests/demo-hash.sh` **11 of 11** (289 s, native against wasm; the hash holds the bob now);
   - `tests/savegame-portable.sh` 117 passed, 0 failed (574 s); `savegame-old.sh` 12 of 12 (208 s); `savegame-malformed.sh` 8 of 8 (25 s); `bots-native-wasm.sh` identical, 2,800 records (83 s); `bots-level-start.sh` PASS (21 s);
   - every `test-hot-join.sh` mode: default, `--together` (47 s), `--no-force` (56 s), `--bots`, `--together --bots` (45 s), `--no-force --bots` (56 s), `--lossy`, `--walk`: PASS;
   - `test-relay.sh` (clean and impaired, 187 s for 2 runs of each), `--dedicated` (44 s), `test-relay-errors.sh` (143 s): PASS;
   - `sprite-column-oob.sh` 6 of 6 (60 s), `draw-independence.sh` PASS (92 s);
   - `asan-demos.sh`: 53 sites, 53 known, **0 new**, after renumbering 11 lines of `tests/asan-known.txt` (the same sites, shifted by the new code in `p_saveg.c` and `g_game.c`); its hot join with the ASan build (the reproduction of `bugs.md` L29) now **passes**: 1,461 identical records, where it parted about 50 tics after the join before;
   - the six browser tests of `tests/web/`: smoke 36, demo-page 11, persist 12, exits 18, data 159, iwad-table 40 passed (the wasm build with the new netcode).

**Failure proofs (AC7)**
Each by a throwaway patch to the final code, built and run, then `git checkout`:
- **L31, order** (`pause-order.sh`): the old algorithm transplanted into `CL_Pause_Change` (the newest gametic wins, an entry for the same gametic replaces the old): 140 of 285 cases fail.
- **L35, cause A** (the ticcmds counted by tics again): lossy 10 seeds (101 to 110): **9 of 10** passed (seed 103 failed). Weak alone: it needs a section that arrives again after its second.
- **L35, cause B** (section bits for the start tic only): lossy seeds 101 to 110: 10 of 10 passed. **Not shown to fail alone**; its evidence is the trace (above), and it is rare.
- **L35, A and B both put back** (seeds 201 to 210): **3 of 10 passed** (failed 202 to 208). On the baseline 2 of 10.
- **The joining node's tics held** (`712a29f`): with the clearing back, `test-hot-join.sh --runs 10 --state "356 380"` (the state files slow the machine, which exposed the race): 9 of 10 (seed 4 failed); in earlier batches of the same configuration before the fix 4 of 8, 6 of 10 and 4 of 8 passed, and 12 of 12 after it.
- **The pause in the tic stream** (against the `PT_STATE` pause): the baseline relay, 1 of 5; with only the sequence number, 3 of 5 and 4 of 6; with the 10-tic lead 5 of 5 relay and 9 of 10 lossy; with `XD_NETWAIT` and the held tics 5 of 5, 3 of 3, 10 of 10.
- **L53, the bob** (the load drops it): `test-hot-join.sh --walk 330 400` fails at tic 361 (`total, players`); `savegame-f3.sh` fails 4 of its checks (with the refusal also taken out); both restored.
- **The zeroed thinkers** (`b720221`): the bots stage of `savegame-portable.sh` failed deterministically (the same two hashes in 8 runs, on `e1cf486`, `1240895`, `e6dea08`, `c58a1c9` and the head) and passes (22 of 22) with it; it passed on `14152ce`.
- No check was loosened. The test files changed are: `test-hot-join.sh` (new options; the files are compared as they were while both games ran), `test-relay.sh` (default; a count that no longer stops the script), `savegame-old.sh` and `savegame-f3.sh` (the join checks accept the refusal by `NETWORK_VERSION`), `savegame-malformed.sh` (the offsets of the bot section, which has no bob block now), and `asan-known.txt` (line numbers). The one change of a comparison I considered, ignoring a client's last record when it has left the level in `testdump-diff.py`, was not made; the harness copies the files before the stop instead.

**Compatibility decisions**
- **`PT_STATE` with older peers.** `state_pak_t` has one more byte (`seq`) and the packet is one byte longer. A reader of before F4 ignores the byte (it reads the fields it knows). A new reader takes a packet whose length has no such byte as having no number: it makes one up, so such packets keep arrival order, as before. In practice mixed builds never meet: `NETWORK_VERSION` is 27 (`XD_NETWAIT` is a new net command that an older build drops as unknown, which would run the join's pause tics unpaused), and the server refuses a client of another number ("Incompatible client").
- **Savegame 10150 against 10149.** A 10149 *file* still loads, the bob starting at 0 as before (and its bots section's bob block is still read). A *join* between the two builds is refused both ways with the existing message "Invalid savegame: wrong version": an F4 client refuses a 10149 savegame from a server (`read_netgame && sg_version < 150`), and F3's build, which knows 149 as the highest, refuses 10150. `tests/savegame-f3.sh` runs all four, and the two joins over UDP. (They are refused first by `NETWORK_VERSION` when the client asks to join: the savegame check is what protects a build that is not refused there, and the file loads.)

**What is not tested**
- L54 itself: it never failed in 30 plain runs of the unfixed code; the fix is by its likely cause.
- A real window or browser: the wait of a join (`bugs.md` L64) lasts longer there, and the hold of a joiner's tics (`712a29f`, `6ad704a`) lasts as long as a node that was sent a savegame has its player still to be added: the server makes at most `BACKUPTICS` tics ahead of the node's savegame tic meanwhile, then stops making them. Brief 04 and L29.
- `PT_STATE` for players waiting for the next game (`SV_Add_game_start_waiting_players`): the only sender left; its sequence number is tested by `pause-order.sh`, the path itself by no test.
- Loss above 3%, more than 3 machines, bots with the relay impaired beyond 3 runs.
- A double loss of the same reliable packet, a joiner more than 32 tics behind (L29).
- The wasm build against the new netcode (the browser tests of `tests/web` run it, see AC8; no browser netplay yet: brief 04).

**Times** (4 cores, one test at a time): baseline lossy 10 runs 575 s, relay 5 runs 257 s, plain 30 runs 1,693 s; after: lossy 10 runs 566 s, relay 5 runs 248 s, relay `--bots` 3 runs 150 s, plain 30 runs 1,693 s, `--bots` 30 runs 1,692 s; one `test-hot-join.sh` run 56 s; `pause-order.sh` 0.1 s; `savegame-f3.sh` 210 s; `savegame-portable.sh` 574 s; `demo-hash.sh` 289 s; `asan-demos.sh` 205 s; the six web tests 29, 87, 79, 12, 39 and 0.1 s.

### Fix round 1 (28 Nov 2026, after the review: merge after fixes)

Commits: `6ad704a`, `8863a63`, `608d06c`, `4803432`, `0364797`, `0b39476` and the docs commit.
1. **The hold froze the server for a drone** (`6ad704a`). A client with no player (`-left`) stays in `NOS_join`, so the hold of `712a29f` stopped `maketic` at its join tic + 31 (the reviewer saw tic 180). It holds only for a node in `NOS_join_savegame` to `NOS_join_timeout` **with `join_waiting` set**: the state range alone is not enough, since another joiner's wait that times out moves every node in a join state, a drone included, to `NOS_join_timeout`. The limit on where a text command may be placed (`net_textcmd_handler`) uses the same hold now (`tic_hold`; 5 of the review). `tests/net/test-drone.sh`: 280 tics in the 8 s after the drone connects with the fix, **35 with the old condition** (fails).
2. **L35 cause B was only partly fixed** (`8863a63`): the section bits were set in every slot a packet covers, read only at the start slot. They are set at the start slot only. The sequence: the first section of (101, 30), the packet (100, 3) whole, the first section of (101, 30) again took `cl_need_tic` to 131 without the second section.
3. **A test that needs no timing** (`8863a63`, `tests/net/servertic-sections.sh`, `-testservertics`): `servertic_handler` is given packets made by hand, 5 cases (sections in order, swapped, the first again after both; the 1-tic packet then the first section of 30; the sequence of item 2). Failure proofs, each fix put back alone: ticcmds counted by tics (`1240895`): `sections swapped` fails, 15 wrong ticcmds; without `9cd98b4`'s length check: `1-tic packet, then the first section of 30` fails (`cl_need_tic` 130, want 101); bits set in every slot: the sequence of item 2 fails (131, want 103); all restored, 5 of 5. This replaces the seeded runs as the proof for L35; where this Outcome said a seed replays a failure it was wrong (corrected above, in `building.md` and in the script's help).
4. **A second joiner during a wait diverged from its first tic** (`608d06c`; the same on `14152ce`). `paused` is not in the savegame and `XD_NETWAIT` is sent only when a wait starts. The misc section of the savegame ends with the byte of `paused` (10150) and a client that gets the savegame from a server takes it; a savegame file does not pause the game it loads into. `tests/net/test-two-joiners.sh` (server `-testunpausedelay 140`, client A, client B a second later): B identical to the server; **without the fix B differs at its first tic (255)** and a repair follows. The user pause is covered by the same byte; not tested.
5. **`XD_NETWAIT` from the server only** (`4803432`): a client's text command could pause everybody. The byte is read first (a command must advance the pointer). Demo playback is let through (a demo has the server's commands under player 0); `demo-hash` 11 of 11 after. Not tested with a client that sends it (no console command does).
6. Tests (`0364797`): the hot-join pause check wants the pause line (a non-zero value) and the unpause line; the joins in `savegame-old.sh` and `savegame-f3.sh` want the one expected refusal, the new client's `Server N refuses connection: Incompatible client` (and not accepted) or the new server's `Incompatible client: legacy ...` (and no savegame sent), not either of two messages in either of two logs.
7. Hygiene (`0b39476`): the `NETWORK_VERSION` comment; comments I wrote say why, not "F4" or a bug number. History not rewritten.
8. Logged only: `bugs.md` L68 (more `P_AddThinker` calls before `.function` is set, at the level start and at run time); L54 is "probably fixed, not proven; watch for it"; the hold's duration is stated correctly in `code-facts.md` §4 and above.

Re-run after the fixes, one at a time, on the final tree: `servertic-sections.sh` 5 of 5; `pause-order.sh` 285 of 285; `test-drone.sh` PASS (16 s); `test-two-joiners.sh` PASS (34 s); lossy hot join 10 of 10 (seeds 401 to 410, 567 s); plain 10 of 10 (563 s), `--bots` 10 of 10 (564 s); relay impaired 5 of 5 (245 s), `--bots` 3 of 3 (155 s), clean 45 s, `--dedicated` 44 s, `test-relay-errors.sh` 142 s: PASS; `savegame-portable.sh` 117 of 117 (576 s); `savegame-old.sh` 12 of 12 (209 s); `savegame-f3.sh` 10 of 10 (210 s); `savegame-malformed.sh` 8 of 8; `demo-hash.sh` 11 of 11 (297 s); `asan-demos.sh` 53 known, 0 new, its hot join PASS (216 s, one `asan-known.txt` line renumbered).

### Fix round 2 (28 Nov 2026, re-review: merge after a one-line fix)
- `XD_NETWAIT` is ignored unless it comes from the server, in demo playback too: the exception for demos was wrong (in 1.48 demos `AddLmpExtradata` and `ReadLmpExtraData` keep each item's player byte, so server commands keep `SERVER_PID`) and would have run, in playback, a client's `XD_NETWAIT` that the server ignored when the demo was recorded.
- `tic_hold` is set with `next_tic_send` in `TryRunTics`'s "start a game after a demo" branch, where `SV_Send_Tic_Update` is skipped.
- **10150 savegames written by the tree from `c58a1c9` to `5303ed1` have no pause byte (added in `608d06c`) and will not load.** 10150 was never merged, so the version number was not raised; `code-facts.md` §8 says so.
- `test-drone.sh` and `test-two-joiners.sh` no longer print bash's "Killed" job messages.
- Re-run: `demo-hash.sh` 11 of 11 (297 s; demo playback unaffected); `test-drone.sh` PASS (16 s); `test-two-joiners.sh` PASS (34 s); one plain hot join PASS (57 s); one lossy hot join PASS (56 s); `savegame-f3.sh` 10 of 10 (210 s); `savegame-portable.sh` savegame-portable: 117 passed, 0 failed, 14 saves, 577 s.
