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

Status: not started.
