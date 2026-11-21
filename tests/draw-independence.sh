#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# The state hash must not depend on drawing or on pacing: the same demo gives the
# same -testdump file when played
#   1. with -timedemo (as fast as possible, drawing: the reference, as in demo-hash.sh),
#   2. with -timedemo -nodraw (no drawing at all),
#   3. with -playdemo (real time, drawing, paced by the clock).
#
#   tests/draw-independence.sh                       # one demo per IWAD
#   tests/draw-independence.sh --demos "d1demo3 fd2demo3"
#   tests/draw-independence.sh --bin FILE            # another game binary
#
# Default demos: d1demo3 (63 s in real time), fd2demo3 (82 s), fd1demo4 (92 s), one per
# IWAD, run side by side. Exit status: 0 if every file matches, 1 if not, 2 on bad set-up.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/build/native/bin/doomlegacy"
demos="d1demo3 fd2demo3 fd1demo4"
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) bin="${2:?}"; shift 2 ;;
        --demos) demos="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -e "$bin" ] && bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
[ -x "$bin" ] || { echo "no game binary at $bin (scripts/build-native.sh)" >&2; exit 2; }
work="$(mktemp -d "${TMPDIR:-/tmp}/draw-indep.XXXXXX")"
trap 'rm -rf "$work"' EXIT

run() { # run NAME MODE: leaves $work/NAME/MODE/{o.bin,exit}
    local name="$1" mode="$2" iwad d args
    case "$name" in fd1*) iwad=freedoom1 ;; fd2*) iwad=freedoom2 ;; d1*) iwad=doom1 ;; esac
    d="$work/$name/$mode"; mkdir -p "$d"; cp "$root/testdata/demos/$name.lmp" "$d/"
    case "$mode" in
        timed)  args=(-timedemo "$name.lmp") ;;
        nodraw) args=(-timedemo "$name.lmp" -nodraw) ;;
        real)   args=(-playdemo "$name.lmp") ;;
    esac
    ( cd "$d" && SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 600 "$bin" -home "$d" \
        -iwad "$root/testdata/$iwad.wad" -nosound -nomusic -noendtext "${args[@]}" -testdump o.bin \
        > out.txt 2>&1; echo $? > exit )
}

start=$(date +%s)
for n in $demos; do
    [ -f "$root/testdata/demos/$n.lmp" ] || { echo "no demo $n (scripts/fetch-test-data.sh)" >&2; exit 2; }
    for m in timed nodraw real; do run "$n" "$m" & done
done
wait

fail=0
for n in $demos; do
    echo "== $n"
    for m in nodraw real; do
        ec="$(cat "$work/$n/$m/exit")"; ec0="$(cat "$work/$n/timed/exit")"
        if [ "$ec" != 0 ] || [ "$ec0" != 0 ]; then echo "   FAIL $m: exit status $ec (timed: $ec0)"; fail=1; continue; fi
        res="$(python3 -I "$root/tests/tools/testdump-diff.py" "$work/$n/timed/o.bin" "$work/$n/$m/o.bin")"
        if [ $? = 0 ]; then echo "   ok   timed == $m: $res"; else echo "   FAIL timed != $m: $res"; fail=1; fi
    done
done
echo "draw-independence: $([ $fail = 0 ] && echo PASS || echo FAIL), $(( $(date +%s) - start )) s"
exit "$fail"
