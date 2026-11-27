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
# "map e1m4" starts another level. The state text (-teststate) of tic 599 (the old level)
# must show bots with a destination, path nodes and mobj pointers, so that the check has
# something to see. The first record of the new level (the first with map 4, level time 0) must
# show, for every bot: no destination, no path, and every one of the eight mobj pointers
# NULL or the number of a live mobj of the new level (a pointer the old level left shows as -2:
# not a live thinker; the new level reuses the old one's memory, so that alone can be fooled).
# B_Level_Start also prints how many pointers, destinations and path nodes are set when it
# is done ("TEST: bots at level start"): the last call, for the new level, must say 0 of each.
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
    -testdump o.bin -testcmd 600 "map e1m4" -teststate 599 603 -testquit 603 > out.txt 2>&1 )
python3 -I - "$work/o.bin.state" <<'PY'
import re, sys
PTRS = ('bbestseen', 'bbest', 'benemy', 'bmissile', 'bunseenenemy', 'bunseenmate', 'blast', 'bmate')
recs, cur = [], None
for l in open(sys.argv[1]):
    if l.startswith('tic '):
        cur = {'map': int(re.search(r'map=(\d+)', l).group(1)), 'lt': int(re.search(r'leveltime=(\d+)', l).group(1)), 'bots': []}
        recs.append(cur)
    elif cur is not None and l.startswith('player') and ' bot=1 ' in l:
        f = dict(re.findall(r'(\w+)=(-?\d+)', l))
        cur['bots'].append({'dest': 'bdestx' in f, 'path': l.count('bpathx='), 'ptrs': [int(f[k]) for k in PTRS]})
fail = 0
old = [r for r in recs if r['map'] == 3]
new = [r for r in recs if r['map'] == 4 and r['lt'] == 0]
if not old or not new:
    print('  FAIL the state text has no record of the old level and no first record of the new one'); sys.exit(1)
o, n = old[-1], new[0]
nd = sum(b['dest'] for b in o['bots']); npn = sum(b['path'] for b in o['bots']); npt = sum(1 for b in o['bots'] for p in b['ptrs'] if p >= 0)
print('old level, last record: %d bots, %d with a destination, %d path nodes, %d mobj pointers set' % (len(o['bots']), nd, npn, npt))
if len(o['bots']) == 3 and nd > 0 and npn > 0 and npt > 0:
    print('  ok   three bots with a destination, a path and mobj pointers before the change')
else:
    print('  FAIL the game had nothing for a level change to clear'); fail = 1
nd = sum(b['dest'] for b in n['bots']); npn = sum(b['path'] for b in n['bots'])
stale = sum(1 for b in n['bots'] for p in b['ptrs'] if p < -1)
print('first record of the new level: %d bots, %d with a destination, %d path nodes, %d mobj pointers that are not live mobjs' % (len(n['bots']), nd, npn, stale))
if len(n['bots']) == 3 and nd == 0 and npn == 0:
    print('  ok   no destination and no path in the new level')
else:
    print('  FAIL a bot kept a destination or a path across the level change'); fail = 1
if stale == 0:
    print('  ok   every mobj pointer is NULL or a live mobj of the new level')
else:
    print('  FAIL a bot kept a mobj pointer of the old level'); fail = 1
sys.exit(fail)
PY
fail=$?
# The strict check: B_Level_Start itself counts what is still set when it is done (the hash
# looks a pointer up by address in the new level's thinkers, and the new level reuses the memory
# the old one freed, so a stale pointer can look live there). The last line is the new level's.
line="$(grep -a '^TEST: bots at level start' "$work/out.txt" | tail -n 1)"
echo "B_Level_Start, last call: ${line#TEST: bots at level start: }"
if printf '%s' "$line" | grep -q ': 3 bots, 0 pointers, 0 destinations, 0 path nodes$'; then
    echo "  ok   B_Level_Start leaves no pointer, no destination and no path node set (3 bots)"
else
    echo "  FAIL B_Level_Start left something set, or did not run for the new level"; fail=1
fi
if [ "$fail" = 0 ]; then echo "bots-level-start: PASS"; else echo "bots-level-start: FAIL"; fi
exit "$fail"
