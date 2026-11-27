#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Do native and wasm bots make the same moves? (brief F3, in-scope item 3 and AC6.)
#
#   tests/bots-native-wasm.sh                  # Freedoom 1 E1M3, skill 4, 2 bots, 2,800 tics
#   tests/bots-native-wasm.sh --tics N         # another length (default 2800; at least 2,100 = 35 * 60)
#   tests/bots-native-wasm.sh --map "1 2"      # episode and map (default "1 3")
#   tests/bots-native-wasm.sh --native-bin FILE --wasm-dir DIR
#   tests/bots-native-wasm.sh --keep           # keep the work directory and print it
#
# The same game is played on both builds from the same start with no human input (the
# host is player 0 and stands still; a demo would not do: during playback the demo's
# ticcmds replace the bots'): two bots with long names are added at tic 10
# (-testaddbots), the level has monsters, so the bots aim and shoot. Both write
# -testdump files (the state hash includes every bot's whole state) and print how many
# times a bot computed its aim and a hash of every aim value. Real time (35 tics
# a second), both builds at once: about 90 s.
#
# Passes when the two files are identical for every tic, the run has at least the
# requested tics, the bots aimed (at least 100 aim calls, the same number on both) and
# the hashes of the aim values are the same. Otherwise prints the first differing tic
# and the parts of the state that differ (tests/tools/testdump-diff.py).
# Exit status: 0 identical, 1 different, 2 bad set-up.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native="$root/build/native/bin/doomlegacy"
wasmdir="$root/build/wasm/bin"
tics=2800
map="1 3"
keep=0
while [ $# -gt 0 ]; do
    case "$1" in
        --tics) tics="${2:?}"; shift 2 ;;
        --map) map="${2:?}"; shift 2 ;;
        --native-bin) native="${2:?}"; shift 2 ;;
        --wasm-dir) wasmdir="${2:?}"; shift 2 ;;
        --keep) keep=1; shift ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ "$tics" -ge 2100 ] || { echo "--tics must be at least 2100 (35 * 60)" >&2; exit 2; }
[ -e "$native" ] && native="$(cd "$(dirname "$native")" && pwd)/$(basename "$native")"
[ -x "$native" ] || { echo "no native binary at $native (scripts/build-native.sh)" >&2; exit 2; }
[ -f "$wasmdir/doomlegacy.wasm" ] || { echo "no wasm build in $wasmdir (scripts/build-wasm.sh)" >&2; exit 2; }
iwad="$root/testdata/freedoom1.wad"
[ -f "$iwad" ] || { echo "no $iwad (scripts/fetch-test-data.sh)" >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/bots-native-wasm.XXXXXX")"
if [ "$keep" = 1 ]; then echo "work directory: $work"; else trap 'rm -rf "$work"' EXIT; fi
mkdir -p "$work/n/h" "$work/w"
args=(-skill 4 -warp $map +botgen 1 +botrandseed 136 -testaddbots 10 2 -nodraw -testdump o.bin -testquit "$tics")

( cd "$work/n" && SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 400 "$native" -home "$work/n/h" \
    -iwad "$iwad" -nosound -nomusic -noendtext "${args[@]}" > out.txt 2>&1; echo $? > exit ) &
( node "$root/tests/tools/run-wasm.js" --wasm "$wasmdir" --timeout 400 --iwad "$iwad" \
    --get o.bin="$work/w/o.bin" -- "${args[@]}" > "$work/w/out.txt" 2>&1; echo $? > "$work/w/exit" ) &
wait

fail=0
for w in n w; do
    [ "$(cat "$work/$w/exit" 2>/dev/null)" = 0 ] || { echo "FAIL the $w run exited $(cat "$work/$w/exit" 2>/dev/null)"; fail=1; }
done
[ "$fail" = 0 ] || { tail -n 3 "$work/n/out.txt"; tail -n 3 "$work/w/out.txt"; exit 1; }
nline="$(grep -a '^TEST: bot aim' "$work/n/out.txt")"; wline="$(grep -a '^TEST: bot aim' "$work/w/out.txt")"
natan="$(printf '%s' "$nline" | sed -n 's/.*calls: \([0-9]*\).*/\1/p')"
echo "native: $nline"
echo "wasm:   $wline"
res="$(python3 -I "$root/tests/tools/testdump-diff.py" "$work/n/o.bin" "$work/w/o.bin")"; rc=$?
echo "state files: $res"
n="$(python3 -I "$root/tests/tools/testdump-diff.py" --info "$work/n/o.bin" | sed 's/ records.*//')"
[ "$rc" = 0 ] || fail=1
[ "$n" -ge "$tics" ] || { echo "FAIL only $n records, wanted $tics"; fail=1; }
[ "${natan:-0}" -ge 100 ] || { echo "FAIL the bots aimed only ${natan:-0} times: the run did not reach the aiming code"; fail=1; }
[ "$nline" = "$wline" ] || { echo "FAIL the aim counts or hashes differ"; fail=1; }
if [ "$fail" = 0 ]; then echo "bots-native-wasm: identical, $n records, $natan aim calls"; else echo "bots-native-wasm: FAIL"; fi
exit "$fail"
