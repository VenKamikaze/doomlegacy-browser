#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Native against wasm: play every demo on both builds with -timedemo and
# -testdump, and compare the per-tic state files record for record.
#
#   tests/demo-hash.sh                      # all 11 demos, native and wasm
#   tests/demo-hash.sh --only fd1demo2      # demos whose name matches (grep -E)
#   tests/demo-hash.sh --fast-math          # also: the native -ffast-math build, as information
#   tests/demo-hash.sh --jobs 3             # demos run at once (default 3)
#   tests/demo-hash.sh --native-bin FILE --wasm-dir DIR
#
# Needs scripts/build-native.sh, scripts/build-wasm.sh, scripts/fetch-test-data.sh.
# For --fast-math: scripts/build-native.sh --fast-math. Each demo is played with
# -timedemo (as fast as possible; under -testdump the game quits at the end of a
# timed demo, with status 0). A run passes if both builds exit 0 and the files are
# identical. On a difference the first differing tic is printed and both builds are
# run again with -teststate at that tic, to show the state lines that differ.
# Exit status: 0 if all pass, 1 if any fails, 2 on bad set-up.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native="$root/build/native/bin/doomlegacy"
fastbin="$root/build/native-fastmath/bin/doomlegacy"
wasmdir="$root/build/wasm/bin"
only="."
jobs=3
fast=0
while [ $# -gt 0 ]; do
    case "$1" in
        --only) only="${2:?}"; shift 2 ;;
        --jobs) jobs="${2:?}"; shift 2 ;;
        --fast-math) fast=1; shift ;;
        --native-bin) native="${2:?}"; shift 2 ;;
        --wasm-dir) wasmdir="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

[ -x "$native" ] || { echo "no native binary at $native (scripts/build-native.sh)" >&2; exit 2; }
[ -f "$wasmdir/doomlegacy.wasm" ] || { echo "no wasm build in $wasmdir (scripts/build-wasm.sh)" >&2; exit 2; }
[ "$fast" = 0 ] || [ -x "$fastbin" ] || { echo "no fast-math binary at $fastbin (scripts/build-native.sh --fast-math)" >&2; exit 2; }
for f in freedoom1 freedoom2 doom1; do
    [ -f "$root/testdata/$f.wad" ] || { echo "no testdata/$f.wad (scripts/fetch-test-data.sh)" >&2; exit 2; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/demo-hash.XXXXXX")"
trap 'rm -rf "$work"' EXIT
diffpy="$root/tests/tools/testdump-diff.py"

iwad_of() {
    case "$1" in
        fd1*) echo "$root/testdata/freedoom1.wad" ;;
        fd2*) echo "$root/testdata/freedoom2.wad" ;;
        d1*)  echo "$root/testdata/doom1.wad" ;;
    esac
}

# run_native BIN DIR IWAD DEMO [game args]: leaves DIR/o.bin, DIR/out.txt, DIR/exit
run_native() {
    local bin="$1" dir="$2" iwad="$3" demo="$4"; shift 4
    mkdir -p "$dir"; cp "$demo" "$dir/"
    ( cd "$dir" && SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 600 "$bin" -home "$dir" \
        -iwad "$iwad" -nosound -nomusic -noendtext \
        -timedemo "$(basename "$demo")" -testdump o.bin "$@" > out.txt 2>&1; echo $? > exit )
}

# run_wasm DIR IWAD DEMO [game args]
run_wasm() {
    local dir="$1" iwad="$2" demo="$3"; shift 3
    mkdir -p "$dir"
    node "$root/tests/tools/run-wasm.js" --wasm "$wasmdir" --timeout 600 --iwad "$iwad" --demo "$demo" \
        --get o.bin="$dir/o.bin" --get o.bin.state="$dir/o.bin.state" \
        -- -timedemo "$(basename "$demo")" -testdump o.bin "$@" > "$dir/out.txt" 2>&1
    echo $? > "$dir/exit"
}

# one demo: prints one result block to $work/<demo>.result; status in $work/<demo>.status
one() {
    local demo="$1" name iwad r t0 t1 t2 t3 t4
    name="$(basename "$demo" .lmp)"; iwad="$(iwad_of "$name")"; r="$work/$name.result"
    {
        t0=$(date +%s)
        run_native "$native" "$work/$name/native" "$iwad" "$demo"
        t1=$(date +%s)
        run_wasm "$work/$name/wasm" "$iwad" "$demo"
        t2=$(date +%s)
        local ne we ok=1 info
        ne="$(cat "$work/$name/native/exit")"; we="$(cat "$work/$name/wasm/exit")"
        echo "== $name: native exit $ne ($((t1-t0)) s), wasm exit $we ($((t2-t1)) s)"
        [ "$ne" = 0 ] || { echo "   FAIL native did not exit 0"; ok=0; }
        [ "$we" = 0 ] || { echo "   FAIL wasm did not exit 0"; ok=0; }
        if [ -s "$work/$name/native/o.bin" ] && [ -s "$work/$name/wasm/o.bin" ]; then
            info="$(python3 -I "$diffpy" "$work/$name/native/o.bin" "$work/$name/wasm/o.bin")"
            if [ $? -eq 0 ]; then
                echo "   ok native == wasm: $info"
            else
                echo "   FAIL native != wasm: $info"; ok=0
                local tic
                tic="$(printf '%s\n' "$info" | sed -n 's/^first difference at tic \([0-9]*\).*/\1/p' | head -1)"
                if [ -n "$tic" ]; then
                    rm -rf "$work/$name/s1" "$work/$name/s2"
                    run_native "$native" "$work/$name/s1" "$iwad" "$demo" -teststate "$tic"
                    run_wasm "$work/$name/s2" "$iwad" "$demo" -teststate "$tic"
                    echo "   state lines that differ at tic $tic (native < > wasm):"
                    python3 -I "$root/tests/tools/state-diff.py" "$work/$name/s1/o.bin.state" "$work/$name/s2/o.bin.state" 6 | cut -c1-230 | sed 's/^/     /'
                fi
            fi
        else
            echo "   FAIL no dump file from one of the runs"; ok=0
        fi
        if [ "$fast" = 1 ]; then
            t3=$(date +%s)
            run_native "$fastbin" "$work/$name/fast" "$iwad" "$demo"
            t4=$(date +%s)
            if [ -s "$work/$name/fast/o.bin" ]; then
                info="$(python3 -I "$diffpy" "$work/$name/native/o.bin" "$work/$name/fast/o.bin")"
                if [ $? -eq 0 ]; then echo "   info: -ffast-math native build: identical ($((t4-t3)) s)"
                else echo "   info: -ffast-math native build differs: $info"; fi
            else
                echo "   info: -ffast-math native build produced no dump (exit $(cat "$work/$name/fast/exit"))"
            fi
        fi
        echo $ok > "$work/$name.status"
    } > "$r" 2>&1
}

demos=()
for d in "$root"/testdata/demos/*.lmp; do
    [ -f "$d" ] || continue
    basename "$d" .lmp | grep -Eq "$only" && demos+=("$d")
done
[ ${#demos[@]} -gt 0 ] || { echo "no demos match '$only' (scripts/fetch-test-data.sh)" >&2; exit 2; }

start=$(date +%s)
running=0
for d in "${demos[@]}"; do
    one "$d" &
    running=$((running+1))
    if [ "$running" -ge "$jobs" ]; then wait -n; running=$((running-1)); fi
done
wait

pass=0; fail=0
for d in "${demos[@]}"; do
    n="$(basename "$d" .lmp)"
    cat "$work/$n.result"
    if [ "$(cat "$work/$n.status" 2>/dev/null)" = 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); fi
done
echo
echo "demo-hash: $pass passed, $fail failed, $(( $(date +%s) - start )) s"
[ "$fail" = 0 ]
