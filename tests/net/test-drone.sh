#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# A client with no player (a drone, -left) connects to a running server: the server must go on
# making tics (bugs.md L31, the tics a joining node is sent are kept, but only for a node that was
# sent a savegame and whose player is yet to be added; a drone stays in a join state for good).
#
#   tests/net/test-drone.sh [--bin FILE] [--keep DIR]
#
# A server (Freedoom 1 E1M1, headless, real time) plays 8 s; a drone connects; 8 s later the server's
# -testdump file must have at least 200 more tics (35 a second would give 280); the drone and the server
# must still be running. (A drone logs nothing when it is accepted.) Exit status: 0 pass, 1 fail, 2 bad set-up.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin="$root/build/native/bin/doomlegacy"
iwad="$root/testdata/freedoom1.wad"
keep=""
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) bin="${2:?}"; shift 2 ;;
        --keep) keep="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -x "$bin" ] || { echo "no game binary at $bin (scripts/build-native.sh)" >&2; exit 2; }
[ -f "$iwad" ] || { echo "no $iwad (scripts/fetch-test-data.sh)" >&2; exit 2; }
bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
if [ -n "$keep" ]; then mkdir -p "$keep"; work="$(cd "$keep" && pwd)"; else work="$(mktemp -d "${TMPDIR:-/tmp}/drone.XXXXXX")"; fi
pids=()
cleanup() { for p in "${pids[@]}"; do kill -KILL "$p" 2>/dev/null; done; wait 2>/dev/null; [ -n "$keep" ] || rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$work/s" "$work/c"
export SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy
common=(-iwad "$iwad" -nosound -nomusic -noendtext -skill 3)
tics() { [ -f "$1" ] && echo $(( $(stat -c %s "$1") / 28 )) || echo 0; }
port_s=$((20000 + RANDOM % 20000))
( cd "$work/s" && exec "$bin" -home "$work/s" "${common[@]}" -server 1 -udpport "$port_s" -warp 1 1 -testdump s.bin > out.txt 2>&1 ) &
pids+=($!)
sleep 8
before="$(tics "$work/s/s.bin")"
( cd "$work/c" && exec "$bin" -home "$work/c" "${common[@]}" -connect 127.0.0.1 -udpport "$port_s" -clientport $((port_s + 1)) -left > out.txt 2>&1 ) &
pids+=($!)
sleep 8
after="$(tics "$work/s/s.bin")"
fail=0
if kill -0 "${pids[0]}" 2>/dev/null; then echo "  ok   the server was still running"; else echo "  FAIL the server was not running"; fail=1; fi
if kill -0 "${pids[1]}" 2>/dev/null; then echo "  ok   the drone was still running"; else echo "  FAIL the drone was not running"; tail -3 "$work/c/out.txt"; fail=1; fi
if [ "$((after - before))" -ge 200 ]; then echo "  ok   the server made $((after - before)) tics in the 8 s after the drone connected (at tic $before)"
else echo "  FAIL the server made only $((after - before)) tics in the 8 s after the drone connected (at tic $before): it stopped making tics"; fail=1; fi
[ "$fail" = 0 ] && echo "drone: PASS" || echo "drone: FAIL"
exit "$fail"
