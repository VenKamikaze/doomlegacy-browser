#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# A bot forgets its destination and path at a level change (brief F3 fix round 1, item 9;
# bugs.md L52).
#
#   tests/bots-level-start.sh                 # build/native/bin/doomlegacy
#   tests/bots-level-start.sh --bin FILE      # another game binary (to show the check fails without the fix)
#
# Freedoom 1 E1M3, skill 4, three bots added with +addbot (the first takes the host's own
# slot, which B_SpawnBot never resets, bugs.md L48). At tic 600 the console command
# "map e1m4" starts another level. The savegame census (-testsave) before the change must
# show bots with a destination and path nodes (the check has something to see), and the
# census 3 and 9 tics after it must show none: nothing of the old level's grid is kept.
# Exit status: 0 pass, 1 fail, 2 bad set-up.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/build/native/bin/doomlegacy"
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) bin="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
iwad="$root/testdata/freedoom1.wad"
[ -x "$bin" ] && [ -f "$iwad" ] || { echo "no game binary or no $iwad" >&2; exit 2; }
bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
work="$(mktemp -d "${TMPDIR:-/tmp}/bots-level-start.XXXXXX")"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/h"
( cd "$work" && SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout -s KILL 120 "$bin" -home "$work/h" -iwad "$iwad" \
    -nosound -nomusic -noendtext -skill 4 -warp 1 3 +botgen 1 +botrandseed 136 +addbot +addbot +addbot -nodraw \
    -testdump o.bin -testcmd 600 "map e1m4" -testsave 599 a.sav -testsave 603 b.sav -testsave 609 c.sav \
    -testquit 609 > out.txt 2>&1 )
census() { grep -a '^TEST: save holds' "$work/out.txt" | sed -n "$1p" | sed -n 's/.*bot \([0-9]*\) bot-dest \([0-9]*\) bot-path-node \([0-9]*\).*/\1 \2 \3/p'; }
fail=0
read -r b0 d0 p0 <<< "$(census 1)"; read -r b1 d1 p1 <<< "$(census 2)"; read -r b2 d2 p2 <<< "$(census 3)"
echo "before the change: ${b0:-?} bots, ${d0:-?} with a destination, ${p0:-?} path nodes"
echo "3 tics after:      ${b1:-?} bots, ${d1:-?} with a destination, ${p1:-?} path nodes"
echo "9 tics after:      ${b2:-?} bots, ${d2:-?} with a destination, ${p2:-?} path nodes"
[ "${b0:-0}" = 3 ] && [ "${d0:-0}" -gt 0 ] && [ "${p0:-0}" -gt 0 ] && echo "  ok   three bots, with a destination and a path, before the change" \
    || { echo "  FAIL the game had no bots with a destination and path to forget"; fail=1; }
[ "${b1:-0}" = 3 ] && [ "${d1:-1}" = 0 ] && [ "${p1:-1}" = 0 ] && [ "${d2:-1}" = 0 ] && [ "${p2:-1}" = 0 ] \
    && echo "  ok   no destination and no path after the level change" \
    || { echo "  FAIL a bot kept a destination or path across the level change"; fail=1; }
if [ "$fail" = 0 ]; then echo "bots-level-start: PASS"; else echo "bots-level-start: FAIL"; fi
exit "$fail"
