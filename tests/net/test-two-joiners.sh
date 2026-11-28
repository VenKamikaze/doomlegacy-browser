#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# A second client joins while the server is paused for the first one's join (bugs.md L31).
#
#   tests/net/test-two-joiners.sh [--bin FILE] [--gap S] [--keep DIR]
#
# A server (Freedoom 1 E1M1, headless, real time) plays 8 s with -testunpausedelay 140, so that the
# network wait of a join keeps the game paused for 140 more tics. Client A joins; --gap seconds later
# (default 1) client B joins while the pause is on. The savegame B gets holds the pause state, and the
# XD_NETWAIT that ends the wait is in the tic stream, so B starts paused as the server is and is
# unpaused with everybody. After 25 s the files of the server and of both clients, copied while the
# games run, must agree for every tic each client has (testdump-diff.py --common), each client must
# have at least 400 tics, and no log may report a consistency fault, a repair or a kick.
# Exit status: 0 pass, 1 fail, 2 bad set-up.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin="$root/build/native/bin/doomlegacy"
iwad="$root/testdata/freedoom1.wad"
gap=1
keep=""
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) bin="${2:?}"; shift 2 ;;
        --gap) gap="${2:?}"; shift 2 ;;
        --keep) keep="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -x "$bin" ] || { echo "no game binary at $bin (scripts/build-native.sh)" >&2; exit 2; }
[ -f "$iwad" ] || { echo "no $iwad (scripts/fetch-test-data.sh)" >&2; exit 2; }
bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
if [ -n "$keep" ]; then mkdir -p "$keep"; work="$(cd "$keep" && pwd)"; else work="$(mktemp -d "${TMPDIR:-/tmp}/twojoin.XXXXXX")"; fi
pids=()
cleanup() { for p in "${pids[@]}"; do kill -KILL "$p" 2>/dev/null; done; [ -n "$keep" ] || rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$work/s" "$work/a" "$work/b"
export SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy
common=(-iwad "$iwad" -nosound -nomusic -noendtext -skill 3)
port_s=$((20000 + RANDOM % 20000))
( cd "$work/s" && exec "$bin" -home "$work/s" "${common[@]}" -server 1 -udpport "$port_s" -warp 1 1 \
    -testunpausedelay 140 -testdump s.bin > out.txt 2>&1 ) &
pids+=($!)
sleep 8
( cd "$work/a" && exec "$bin" -home "$work/a" "${common[@]}" -connect 127.0.0.1 -udpport "$port_s" \
    -clientport $((port_s + 1)) -testdump a.bin > out.txt 2>&1 ) &
pids+=($!)
sleep "$gap"
( cd "$work/b" && exec "$bin" -home "$work/b" "${common[@]}" -connect 127.0.0.1 -udpport "$port_s" \
    -clientport $((port_s + 2)) -testdump b.bin > out.txt 2>&1 ) &
pids+=($!)
sleep 25
for f in s/s a/a b/b; do cp "$work/$f.bin" "$work/$f.run" 2>/dev/null; done
fail=0
check() { if [ "$2" = 0 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
for w in a b; do
    n=$(( $(stat -c %s "$work/$w/$w.run" 2>/dev/null || echo 0) / 28 ))
    check "$w played at least 400 tics ($n)" $([ "$n" -ge 400 ] && echo 0 || echo 1)
    res="$(python3 -I "$root/tests/tools/testdump-diff.py" --common "$work/s/s.run" "$work/$w/$w.run" | head -3)"
    echo "  compare server and $w: $res"
    check "server and $w: every tic both files have is identical" $([ "${res#identical}" != "$res" ] && echo 0 || echo 1)
done
if grep -qiE "consistency (fault|failure)|Client repair|Report: gametic|Kick (node|player)" "$work"/*/out.txt; then
    check "no consistency fault, repair or kick in the logs" 1; grep -hiE "consistency (fault|failure)|Client repair|Report: gametic|Kick (node|player)" "$work"/*/out.txt | head -3
else check "no consistency fault, repair or kick in the logs" 0; fi
[ "$fail" = 0 ] && echo "two-joiners: PASS" || echo "two-joiners: FAIL"
exit "$fail"
