#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Regression test for F1 (bugs.md L1): the 24/32 bpp column drawer read
# dc_source[4294967295] for sprites on 64-bit builds and segfaulted as soon as the
# player's weapon was drawn.
#
#   tests/sprite-column-oob.sh                 # quick: 10 s of -warp 1 1 per IWAD
#   tests/sprite-column-oob.sh --full          # also play DEMO1 of each IWAD to the end
#   tests/sprite-column-oob.sh --bin FILE      # test another binary
#   tests/sprite-column-oob.sh --secs N        # length of the quick runs
#
# Needs scripts/build-native.sh and scripts/fetch-test-data.sh first; IWADs that
# are missing from testdata/ are skipped (and reported). Quick case: the game must
# still be running when the timeout stops it (status 124); a crash is 139. Full
# case: the demo must play to its end, where the game quits with status 0.
# Under SDL_VIDEODRIVER=dummy the game draws with R_DrawColumn_32 (in the default
# mode and with -bpp 8 or 24), so that is the drawer this exercises.
# Exits 0 when every case passes, 1 otherwise.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/build/native/bin/doomlegacy"
secs=10
full=0
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) bin="${2:?}"; shift 2 ;;
        --secs) secs="${2:?}"; shift 2 ;;
        --full) full=1; shift ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

pass=0
fail=0
skip=0
check() {  # check NAME WANT GOT
    if [ "$2" = "$3" ]; then
        echo "PASS  $1"
        pass=$((pass + 1))
    else
        echo "FAIL  $1 (exit $3, want $2)"
        fail=$((fail + 1))
    fi
}

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
for set in "freedoom1 fd1demo1" "freedoom2 fd2demo1" "doom1 d1demo1"; do
    read -r iwad demo <<< "$set"
    if [ ! -f "$root/testdata/$iwad.wad" ]; then
        echo "SKIP  $iwad (no testdata/$iwad.wad)"
        skip=$((skip + 1))
        continue
    fi
    for bpp in default 24; do
        extra=(-warp 1 1)
        [ "$bpp" = default ] || extra+=(-bpp "$bpp")
        "$root/scripts/run-headless.sh" --bin "$bin" --iwad "$root/testdata/$iwad.wad" \
            --demo none --timeout "$secs" -- "${extra[@]}" > "$log" 2>&1
        check "$iwad -warp 1 1, bpp $bpp: still running after ${secs}s" 124 $?
    done
    if [ "$full" = 1 ]; then
        "$root/scripts/run-headless.sh" --bin "$bin" --iwad "$root/testdata/$iwad.wad" \
            --demo "$root/testdata/demos/$demo.lmp" --timeout 900 > "$log" 2>&1
        check "$iwad $demo played to the end" 0 $?
    fi
done

echo "$pass passed, $fail failed, $skip skipped"
[ "$fail" = 0 ] && [ "$pass" -gt 0 ]
