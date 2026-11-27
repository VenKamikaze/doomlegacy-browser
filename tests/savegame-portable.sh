#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# The savegame is the same on x86_64 (native) and wasm32, and a game loaded from one
# plays on the same on both (brief F2, acceptance 1 to 3).
#
#   tests/savegame-portable.sh                # all cases
#   tests/savegame-portable.sh --only d1demo3 # cases whose demo name matches (grep -E); "bots" is the game with bots
#   tests/savegame-portable.sh --full         # also load every wasm-written save (see below)
#   tests/savegame-portable.sh --jobs 3       # runs at once (default 3: one core each)
#   tests/savegame-portable.sh --keep         # keep the work directory and print it
#   tests/savegame-portable.sh --native-bin FILE --wasm-dir DIR
#
# Needs scripts/build-native.sh, scripts/build-wasm.sh, scripts/fetch-test-data.sh.
#
# AC1 (sizes): `-testsizes` on both builds prints the bytes one record of each sector
#   effect takes in a savegame; there must be 13 lines, none with `roundtrip FAIL` (every saved
#   field comes back as it was written), the sizes must be the table's, and the two outputs identical.
# AC2 (same bytes): for each case, a demo is played with -timedemo -nodraw on native and
#   on wasm, and the game writes the savegame the join sends (-testsave TIC FILE) at the
#   listed tics; the two files of a tic must be byte-identical. (-nodraw: the renderer
#   sets the automap flag ML_MAPPED on lines, which a savegame holds when it differs from
#   the map, and what is seen depends on the screen. The config file of the game's home
#   is empty at the start: `botrandom` is a network variable that the game changes and
#   saves in it.) What each save holds is printed: the thinkers of each type and the
#   sectors with a soundtarget, as the game counted them when it wrote the file and when
#   it loaded it back: the two must be the same.
# AC3 (cross loads): every native-written save is loaded by native and by wasm
#   (-timedemo DEMO -testload FILE: the demo only sets the compatibility settings the
#   saving game had; the game then takes over and plays 1,099 tics with no input), and
#   the two -testdump files must be identical; the first record of each (the state as
#   loaded) must equal the record the saving game wrote at the save tic: players, mobjs,
#   sectors and lines, sector effects, random state, with the soundtarget of every
#   sector. A save written by wasm is loaded the same way (the first save of each demo;
#   all of them with --full: they are byte for byte the native ones, AC2).
#
# Exit status: 0 if everything passed, 1 if not, 2 on bad set-up.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native="$root/build/native/bin/doomlegacy"
wasmdir="$root/build/wasm/bin"
only="."
jobs=3
full=0
keep=0
playtics=1100          # the loaded game runs to this gametic; it starts at 1: 1,099 tics
mintics=1050           # 35 * 30
while [ $# -gt 0 ]; do
    case "$1" in
        --only) only="${2:?}"; shift 2 ;;
        --jobs) jobs="${2:?}"; shift 2 ;;
        --full) full=1; shift ;;
        --keep) keep=1; shift ;;
        --native-bin) native="${2:?}"; shift 2 ;;
        --wasm-dir) wasmdir="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

[ -e "$native" ] && native="$(cd "$(dirname "$native")" && pwd)/$(basename "$native")"
[ -x "$native" ] || { echo "no native binary at $native (scripts/build-native.sh)" >&2; exit 2; }
[ -f "$wasmdir/doomlegacy.wasm" ] || { echo "no wasm build in $wasmdir (scripts/build-wasm.sh)" >&2; exit 2; }
for f in freedoom1 freedoom2 doom1; do
    [ -f "$root/testdata/$f.wad" ] || { echo "no testdata/$f.wad (scripts/fetch-test-data.sh)" >&2; exit 2; }
done

# The cases: demo and the tics to save at. Chosen from a census of the thinkers at every
# 200th tic of the 11 demos, so that between them the saves hold active doors, platforms and
# floors, every kind of light effect the demos have, and sectors with a soundtarget:
#   d1demo1  600 platform; 1800 two doors
#   d1demo2  400 door; 1000 two platforms
#   d1demo3  800 door + platform; 1200 two doors + platform; 1600 floor
#   fd1demo3 2000 two doors, 289 sectors with a soundtarget
#   fd1demo4 600 door + fire flicker; 3000 nothing moving, 95 soundtargets
#   fd2demo1 2600 door, 149 soundtargets
#   fd2demo3 200 three floors and a fire flicker, no soundtarget
cases=(
    "d1demo1:600,1800"
    "d1demo2:400,1000"
    "d1demo3:800,1200,1600"
    "fd1demo3:2000"
    "fd1demo4:600,3000"
    "fd2demo1:2600"
    "fd2demo3:200"
)

work="$(mktemp -d "${TMPDIR:-/tmp}/savegame-portable.XXXXXX")"
if [ "$keep" = 1 ]; then echo "work directory: $work"; else trap 'rm -rf "$work"' EXIT; fi
diffpy="$root/tests/tools/testdump-diff.py"
atpy="$root/tests/tools/dump-at.py"

iwad_of() {
    case "$1" in
        fd1*) echo "$root/testdata/freedoom1.wad" ;;
        fd2*) echo "$root/testdata/freedoom2.wad" ;;
        d1*)  echo "$root/testdata/doom1.wad" ;;
    esac
}

# run_native DIR IWAD [files to copy into DIR...] -- game args
run_native() {
    local dir="$1" iwad="$2"; shift 2
    local f
    mkdir -p "$dir"; rm -rf "$dir/.doomlegacy"
    while [ "$1" != "--" ]; do cp "$1" "$dir/"; shift; done; shift
    ( cd "$dir" && SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 300 "$native" -home "$dir" \
        -iwad "$iwad" -nosound -nomusic -noendtext "$@" > out.txt 2>&1; echo $? > exit )
}

# run_wasm DIR IWAD [--demo FILE | --put FILE | --get PATH=NAME]... -- game args
run_wasm() {
    local dir="$1" iwad="$2"; shift 2
    local opts=()
    mkdir -p "$dir"
    while [ "$1" != "--" ]; do
        case "$1" in
            --get) opts+=(--get "${2%%=*}=$dir/${2#*=}"); shift 2 ;;
            *) opts+=("$1" "$2"); shift 2 ;;
        esac
    done; shift
    node "$root/tests/tools/run-wasm.js" --wasm "$wasmdir" --timeout 400 --iwad "$iwad" "${opts[@]}" \
        -- "$@" > "$dir/out.txt" 2>&1
    echo $? > "$dir/exit"
}

# ---- stage 0: the sizes (AC1) ----
pass=0; fail=0
ok()   { echo "   ok   $*"; pass=$((pass+1)); }
bad()  { echo "   FAIL $*"; fail=$((fail+1)); }

start=$(date +%s)
iw1="$(iwad_of fd1demo1)"
run_native "$work/sizes-native" "$iw1" -- -testsizes
run_wasm "$work/sizes-wasm" "$iw1" -- -testsizes
grep '^size ' "$work/sizes-native/out.txt" > "$work/sizes-native.txt"
grep '^size ' "$work/sizes-wasm/out.txt" > "$work/sizes-wasm.txt"
echo "== AC1: bytes one record of each sector effect takes in a savegame"
# What one record takes (docs: code-facts.md section 8). A change of the layout changes this
# table with it; a change on both builds that the table does not know fails AC1.
expected_sizes="ceiling 37 door 35 floor 27 plat 41 flash 21 strobe 21 glow 10 fireflicker 13 lightfade 9 elevator 22 scroll 37 friction 13 pusher 33"
for w in native wasm; do
    f="$work/sizes-$w.txt"
    if [ ! -s "$f" ]; then
        bad "$w printed no sizes (exit $(cat "$work/sizes-$w/exit"))"; continue
    fi
    [ "$(wc -l < "$f")" = 13 ] && ok "$w printed 13 size lines" || bad "$w printed $(wc -l < "$f") size lines, not 13"
    if grep -q 'roundtrip FAIL' "$f"; then
        bad "$w: a record does not survive write, read and write: $(grep 'roundtrip FAIL' "$f" | sed 's/^size //; s/ roundtrip FAIL//' | tr '\n' ' ')"
    else
        ok "$w: every record survives write, read and write, field by field"
    fi
    got="$(awk '{printf "%s%s %s", (NR>1?" ":""), $2, $3}' "$f")"
    [ "$got" = "$expected_sizes" ] && ok "$w: the sizes are the expected ones" \
        || bad "$w: the sizes are not the expected ones: [$got] against [$expected_sizes]"
done
if cmp -s "$work/sizes-native.txt" "$work/sizes-wasm.txt"; then
    ok "native and wasm print the same sizes: $(awk '{printf "%s=%s ", $2, $3}' "$work/sizes-native.txt")"
else
    bad "native and wasm print different sizes (native < > wasm):"
    diff "$work/sizes-native.txt" "$work/sizes-wasm.txt" | sed 's/^/        /'
fi

# ---- stage 1: the saves, native and wasm, one run of each per demo (AC2) ----
sel=()
for c in "${cases[@]}"; do
    echo "${c%%:*}" | grep -Eq "$only" && sel+=("$c")
done
echo "bots" | grep -Eq "$only" || [ ${#sel[@]} -gt 0 ] || { echo "no cases match '$only'" >&2; exit 2; }

save_run() {   # save_run DEMO TICS WHICH
    local demo="$1" tics="$2" which="$3" dir="$work/save/$1/$3" iwad args="" t last=0 gets=()
    iwad="$(iwad_of "$demo")"
    for t in ${tics//,/ }; do args="$args -testsave $t s$t.sav"; last=$t; gets+=(--get "s$t.sav=s$t.sav"); done
    if [ "$which" = native ]; then
        run_native "$dir" "$iwad" "$root/testdata/demos/$demo.lmp" -- -timedemo "$demo.lmp" -nodraw \
            -testdump o.bin $args -testquit "$last"
    else
        run_wasm "$dir" "$iwad" --demo "$root/testdata/demos/$demo.lmp" --get o.bin=o.bin "${gets[@]}" \
            -- -timedemo "$demo.lmp" -nodraw -testdump o.bin $args -testquit "$last"
    fi
}
export -f save_run run_native run_wasm iwad_of
export work root native wasmdir

list=()
for c in "${sel[@]}"; do d="${c%%:*}"; t="${c#*:}"; list+=("$d $t native" "$d $t wasm"); done
[ ${#list[@]} -eq 0 ] || printf '%s\n' "${list[@]}" | xargs -P "$jobs" -L 1 bash -c 'save_run "$@"' _

# ---- stage 2: the loads (AC3) ----
load_run() {   # load_run DEMO TIC WRITER LOADER
    local demo="$1" t="$2" writer="$3" loader="$4" iwad dir sav
    iwad="$(iwad_of "$demo")"
    dir="$work/load/$demo-$t-$writer-by-$loader"
    sav="$work/save/$demo/$writer/s$t.sav"
    [ -s "$sav" ] || { mkdir -p "$dir"; echo 99 > "$dir/exit"; return; }
    if [ "$loader" = native ]; then
        run_native "$dir" "$iwad" "$root/testdata/demos/$demo.lmp" "$sav" -- -timedemo "$demo.lmp" -nodraw \
            -testload "s$t.sav" -testdump L.bin -testquit "$playtics"
    else
        run_wasm "$dir" "$iwad" --demo "$root/testdata/demos/$demo.lmp" --put "$sav" --get L.bin=L.bin \
            -- -timedemo "$demo.lmp" -nodraw -testload "s$t.sav" -testdump L.bin -testquit "$playtics"
    fi
}
export -f load_run
export playtics

loads=()
for c in "${sel[@]}"; do
    d="${c%%:*}"; tics="${c#*:}"; tics="${tics//,/ }"; first=1
    for t in ${tics}; do
        for loader in native wasm; do loads+=("$d $t native $loader"); done
        if [ "$full" = 1 ] || [ "$first" = 1 ]; then
            for loader in native wasm; do loads+=("$d $t wasm $loader"); done
        fi
        first=0
    done
done
[ ${#loads[@]} -eq 0 ] || printf '%s\n' "${loads[@]}" | xargs -P "$jobs" -L 1 bash -c 'load_run "$@"' _

# ---- the checks ----
echo
echo "== AC2: the same save from native and from wasm; AC3: loads"
nsaves=0
for c in "${sel[@]}"; do
    demo="${c%%:*}"; tics="${c#*:}"; tics="${tics//,/ }"
    echo "-- $demo"
    for w in native wasm; do
        e="$(cat "$work/save/$demo/$w/exit" 2>/dev/null || echo missing)"
        [ "$e" = 0 ] || bad "$w saving run exited $e"
    done
    if [ -s "$work/save/$demo/native/o.bin" ] && [ -s "$work/save/$demo/wasm/o.bin" ]; then
        info="$(python3 -I "$diffpy" "$work/save/$demo/native/o.bin" "$work/save/$demo/wasm/o.bin")" \
            && ok "the saving games' state files are identical, native and wasm: $info" \
            || bad "the saving games differ: $info"
    else
        bad "no state file from a saving run"
    fi
    first=1; idx=0
    for t in ${tics}; do
        nsaves=$((nsaves+1)); idx=$((idx+1))
        ns="$work/save/$demo/native/s$t.sav"; ws="$work/save/$demo/wasm/s$t.sav"
        hs="$(grep '^TEST: save holds' "$work/save/$demo/native/out.txt" | sed -n "${idx}p" | sed 's/^TEST: save holds: //')"
        echo "   save at tic $t holds: $(printf '%s\n' "$hs" | tr ' ' '\n' | paste -d= - - | grep -v '=0$' | tr '\n' ' ')"
        if [ -s "$ns" ] && [ -s "$ws" ]; then
            if cmp -s "$ns" "$ws"; then ok "AC2 native save == wasm save, byte for byte ($(stat -c %s "$ns") bytes)"
            else bad "AC2 the saves differ: $(cmp "$ns" "$ws" 2>&1 | head -1)"; fi
        else
            bad "AC2 a save is missing (native $( [ -s "$ns" ] && echo yes || echo no ), wasm $( [ -s "$ws" ] && echo yes || echo no ))"
            continue
        fi
        for writer in native wasm; do
            [ "$writer" = native ] || [ "$full" = 1 ] || [ "$first" = 1 ] || continue
            ln="$work/load/$demo-$t-$writer-by-native"; lw="$work/load/$demo-$t-$writer-by-wasm"
            if [ "$(cat "$ln/exit" 2>/dev/null)" != 0 ] || [ "$(cat "$lw/exit" 2>/dev/null)" != 0 ]; then
                bad "AC3 $writer-written save: a loading run failed (native exit $(cat "$ln/exit" 2>/dev/null), wasm exit $(cat "$lw/exit" 2>/dev/null))"
                continue
            fi
            # the loads play on identically
            info="$(python3 -I "$diffpy" "$ln/L.bin" "$lw/L.bin")" && r=0 || r=1
            n="$(python3 -I "$diffpy" --info "$ln/L.bin" | sed 's/ records.*//')"
            if [ $r = 0 ] && [ "$n" -ge "$mintics" ]; then
                ok "AC3 $writer-written save loaded by native and by wasm: $info"
            else
                bad "AC3 $writer-written save: native load and wasm load differ or are short ($n records): $info"
            fi
            # the state as loaded equals the state when saved
            for l in native wasm; do
                lf="$work/load/$demo-$t-$writer-by-$l/L.bin"
                sf="$work/save/$demo/$writer/o.bin"
                info="$(python3 -I "$atpy" "$sf" "$t" "$lf" first)" \
                    && ok "AC3 state as loaded by $l == state at tic $t when $writer saved: $info" \
                    || { bad "AC3 state as loaded by $l != state at tic $t when $writer saved: $info"; }
            done
            # the load holds what the save held
            hw="$(grep '^TEST: save holds' "$work/save/$demo/$writer/out.txt" | sed -n "${idx}p" | sed 's/^TEST: save holds: //')"
            hl="$(sed -n 's/^TEST: load holds: //p' "$work/load/$demo-$t-$writer-by-native/out.txt" | head -1)"
            [ "$hw" = "$hl" ] && ok "AC3 the load holds what the save held (thinkers by type, soundtargets)" \
                || bad "AC3 the load holds something else: saved [$hw] loaded [$hl]"
        done
        first=0
    done
done

# ---- stage 3: a game with bots (brief F3, AC3 and AC4) ----
# Freedoom 1 E1M3, skill 4, two bots with long names added at tic 10, no human input, -nodraw.
# The saves at tics 1300 and 1700 hold bots with timers, a destination and a path (the census
# line "bot-path-node"). Checked:
#   - saving changes nothing: the game that wrote two saves and the same game that wrote none
#     have identical -testdump files for all 2,800 tics (1,100 after the last save);
#   - the same save from native and from wasm, byte for byte, and the saving games' files identical;
#   - each save loaded by native and by wasm (no demo: a plain single-player game): the two
#     files of the 1,100 tics after the load identical, and the first record (the state as
#     loaded, the bots' whole state included) equal to the record of the saving game at the save tic;
#   - the saves hold what is wanted: at least one with a bot path.
if echo "bots" | grep -Eq "$only"; then
    echo
    echo "== bots: AC3 (saving changes nothing) and AC4 (same save, same state as loaded)"
    bargs=(-skill 4 -warp 1 3 +botgen 1 +botrandseed 136 -testaddbots 10 2 -nodraw)
    bsave=(-testsave 1300 s1300.sav -testsave 1700 s1700.sav)
    bdir="$work/bots"
    run_native "$bdir/nsave" "$iw1" -- "${bargs[@]}" -testdump o.bin "${bsave[@]}" -testquit 2800 &
    run_native "$bdir/nplain" "$iw1" -- "${bargs[@]}" -testdump o.bin -testquit 2800 &
    run_wasm "$bdir/wsave" "$iw1" --get o.bin=o.bin --get s1300.sav=s1300.sav --get s1700.sav=s1700.sav \
        -- "${bargs[@]}" -testdump o.bin "${bsave[@]}" -testquit 2800 &
    wait
    for d in nsave nplain wsave; do
        [ "$(cat "$bdir/$d/exit" 2>/dev/null)" = 0 ] && ok "bots: the $d run exited 0" || bad "bots: the $d run exited $(cat "$bdir/$d/exit" 2>/dev/null)"
    done
    if info="$(python3 -I "$diffpy" "$bdir/nsave/o.bin" "$bdir/nplain/o.bin")"; then
        ok "AC3 bots: the game that saved twice and the game that did not have identical files: $info"
    else
        bad "AC3 bots: saving changed the game: $info"
    fi
    nrec="$(python3 -I "$diffpy" --info "$bdir/nsave/o.bin" | sed 's/ records.*//')"
    [ "$nrec" -ge $((1700 + mintics)) ] && ok "AC3 bots: $nrec records, at least $mintics after the last save" \
        || bad "AC3 bots: only $nrec records"
    if info="$(python3 -I "$diffpy" "$bdir/nsave/o.bin" "$bdir/wsave/o.bin")"; then
        ok "bots: the saving games' files are identical, native and wasm: $info"
    else
        bad "bots: the saving games differ, native and wasm: $info"
    fi
    pathnodes=0
    for t in 1300 1700; do
        nsaves=$((nsaves+1))
        hs="$(grep -a '^TEST: save holds' "$bdir/nsave/out.txt" | sed -n "$([ $t = 1300 ] && echo 1 || echo 2)p" | sed 's/^TEST: save holds: //')"
        echo "   save at tic $t holds: $(printf '%s\n' "$hs" | tr ' ' '\n' | paste -d= - - | grep -v '=0$' | tr '\n' ' ')"
        pathnodes=$((pathnodes + $(printf '%s' "$hs" | sed -n 's/.*bot-path-node \([0-9]*\).*/\1/p')))
        if [ -s "$bdir/nsave/s$t.sav" ] && cmp -s "$bdir/nsave/s$t.sav" "$bdir/wsave/s$t.sav"; then
            ok "AC4 bots: native save == wasm save, byte for byte ($(stat -c %s "$bdir/nsave/s$t.sav") bytes)"
        else
            bad "AC4 bots: the saves at tic $t differ or are missing"
        fi
    done
    [ "$pathnodes" -gt 0 ] && ok "bots: the saves hold bot paths ($pathnodes nodes)" \
        || bad "bots: no save holds a bot path: the test would not see a lost path"
    bload() {  # bload TIC LOADER
        local t="$1" l="$2" dir="$bdir/load-$1-$2"
        if [ "$l" = native ]; then
            run_native "$dir" "$iw1" "$bdir/nsave/s$t.sav" -- -nodraw -testload "s$t.sav" -testdump L.bin -testquit "$playtics"
        else
            run_wasm "$dir" "$iw1" --put "$bdir/nsave/s$t.sav" --get L.bin=L.bin \
                -- -nodraw -testload "s$t.sav" -testdump L.bin -testquit "$playtics"
        fi
    }
    for t in 1300 1700; do bload $t native & bload $t wasm & wait; done
    for t in 1300 1700; do
        ln="$bdir/load-$t-native"; lw="$bdir/load-$t-wasm"
        if [ "$(cat "$ln/exit" 2>/dev/null)" != 0 ] || [ "$(cat "$lw/exit" 2>/dev/null)" != 0 ]; then
            bad "AC4 bots: a loading run of the save at $t failed"; continue
        fi
        info="$(python3 -I "$diffpy" "$ln/L.bin" "$lw/L.bin")" && r=0 || r=1
        n="$(python3 -I "$diffpy" --info "$ln/L.bin" | sed 's/ records.*//')"
        if [ $r = 0 ] && [ "$n" -ge "$mintics" ]; then ok "AC4 bots: save at $t loaded by native and by wasm play on identically: $info"
        else bad "AC4 bots: save at $t, native load and wasm load differ or are short ($n records): $info"; fi
        for l in native wasm; do
            info="$(python3 -I "$atpy" "$bdir/nsave/o.bin" "$t" "$bdir/load-$t-$l/L.bin" first)" \
                && ok "AC4 bots: state as loaded by $l == state at tic $t when saved (bots included): $info" \
                || bad "AC4 bots: state as loaded by $l != state at tic $t when saved: $info"
        done
    done
fi

echo
echo "savegame-portable: $pass passed, $fail failed, $nsaves saves, $(( $(date +%s) - start )) s"
[ "$fail" = 0 ] && [ "$nsaves" -gt 0 ]
