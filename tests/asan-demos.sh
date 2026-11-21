#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# AddressSanitizer (and UBSan) with recovery over all demos: every error is
# reported and the game keeps going, so one run lists every site.
#
#   tests/asan-demos.sh                    # build build/asan if missing, run all 11 demos
#   tests/asan-demos.sh --rebuild          # rebuild the ASan binary first
#   tests/asan-demos.sh --only fd1demo2    # demos whose name matches (grep -E)
#   tests/asan-demos.sh --jobs 3
#   tests/asan-demos.sh --keep DIR         # keep the raw logs in DIR
#   tests/asan-demos.sh --all-sites        # list the known sites too
#
# The build is gcc -O3 with -fsanitize=address,undefined -fsanitize-recover=all
# and -fno-sanitize=alignment (the zone allocator hands out 4-byte aligned blocks
# on 64-bit builds, so alignment reports flood the log: bugs.md L9), and without
# -ffast-math (scripts/build-native.sh). Each demo is played with -timedemo and
# -testdump (the game quits at the end of a timed demo) with
# ASAN_OPTIONS=halt_on_error=0:detect_leaks=0.
#
# Reports are grouped by site: for ASan "<kind> at <file>:<line> in <function>" (the
# top frame in game code), for UBSan "<file>:<line>:<col> <message>". tests/asan-known.txt
# lists the sites already in bugs.md (one per line: the site key, then a space and
# the L number). The script fails (exit 1) if a demo does not exit 0 or if a site
# that is not in that file appears. Sites in the file are counted and listed with
# their L number.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/build/asan/bin/doomlegacy"
only="."
jobs=3
rebuild=0
keep=""
all=0
while [ $# -gt 0 ]; do
    case "$1" in
        --rebuild) rebuild=1; shift ;;
        --only) only="${2:?}"; shift 2 ;;
        --jobs) jobs="${2:?}"; shift 2 ;;
        --keep) keep="${2:?}"; shift 2 ;;
        --all-sites) all=1; shift ;;
        --bin) bin="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

if [ "$rebuild" = 1 ] || [ ! -x "$bin" ]; then
    echo "building the ASan binary (build/asan) ..."
    REAL_CC="gcc -fsanitize=address,undefined -fsanitize-recover=all -fno-sanitize=alignment -fno-omit-frame-pointer -g" \
        "$root/scripts/build-native.sh" --build build/asan --clean > "${TMPDIR:-/tmp}/asan-build.log" 2>&1 \
        || { echo "ASan build failed, see ${TMPDIR:-/tmp}/asan-build.log" >&2; exit 2; }
fi
[ -e "$bin" ] && bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
[ -x "$bin" ] || { echo "no ASan binary at $bin" >&2; exit 2; }
for f in freedoom1 freedoom2 doom1; do
    [ -f "$root/testdata/$f.wad" ] || { echo "no testdata/$f.wad (scripts/fetch-test-data.sh)" >&2; exit 2; }
done

if [ -n "$keep" ]; then mkdir -p "$keep"; work="$(cd "$keep" && pwd)"; else
    work="$(mktemp -d "${TMPDIR:-/tmp}/asan-demos.XXXXXX")"; trap 'rm -rf "$work"' EXIT; fi

run_one() {
    local demo="$1" name iwad d
    name="$(basename "$demo" .lmp)"
    case "$name" in fd1*) iwad=freedoom1 ;; fd2*) iwad=freedoom2 ;; d1*) iwad=doom1 ;; esac
    d="$work/$name"; mkdir -p "$d"; cp "$demo" "$d/"
    ( cd "$d" && SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
        ASAN_OPTIONS=halt_on_error=0:detect_leaks=0:print_stacktrace=1 UBSAN_OPTIONS=print_stacktrace=0 \
        timeout 900 "$bin" -home "$d" -iwad "$root/testdata/$iwad.wad" -nosound -nomusic -noendtext \
        -timedemo "$name.lmp" -testdump o.bin > out.txt 2> err.txt; echo $? > exit )
}

demos=()
for d in "$root"/testdata/demos/*.lmp; do
    [ -f "$d" ] || continue
    basename "$d" .lmp | grep -Eq "$only" && demos+=("$d")
done
[ ${#demos[@]} -gt 0 ] || { echo "no demos match '$only'" >&2; exit 2; }

start=$(date +%s); running=0
for d in "${demos[@]}"; do
    run_one "$d" &
    running=$((running+1))
    if [ "$running" -ge "$jobs" ]; then wait -n; running=$((running-1)); fi
done
wait

# The hot-join test, with this build: only its sanitizer reports count here. Under ASan
# both machines run several times slower, and the two files part about 50 tics after
# the join (bugs.md L29), so the comparison itself is the job of tests/net/test-hot-join.sh
# with the normal build. This run's result is printed for information.
hj=0
if [ "$only" = "." ]; then
    echo "hot-join test with the ASan build (reports only) ..."
    "$root/tests/net/test-hot-join.sh" --bin "$bin" --keep "$work/hot-join" > "$work/hot-join.out" 2>&1 || true
    grep -E "compare:|hot-join:" "$work/hot-join.out" | sed 's/^/  /'
    hjnew="$(python3 -I "$root/tests/tools/sanitizer-sites.py" --unknown "$root/tests/asan-known.txt" \
        "$work/hot-join/s/out.txt" "$work/hot-join/c/out.txt")"
    if [ -n "$hjnew" ]; then hj=1; echo "  NEW sites in the hot-join logs:"; printf '%s\n' "$hjnew" | sed 's/^/    /'; fi
fi

# Group: print "site-key<TAB>demo" for every report.
sites="$work/sites.txt"; : > "$sites"
bad=0
for d in "${demos[@]}"; do
    n="$(basename "$d" .lmp)"
    ec="$(cat "$work/$n/exit" 2>/dev/null || echo missing)"
    if [ "$ec" != 0 ]; then echo "FAIL $n: exit status $ec"; bad=1; fi
    python3 -I "$root/tests/tools/sanitizer-sites.py" "$work/$n/err.txt" "$work/$n/out.txt" \
        | sed "s/\$/\t$n/" >> "$sites"
done

known="$root/tests/asan-known.txt"
python3 -I - "$sites" "$known" "$all" <<'PY'
import sys, collections
sites_file, known_file, show_all = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
known = {}
try:
    for line in open(known_file):
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        key, _, ref = line.rpartition(" ")
        known[key.strip()] = ref
except FileNotFoundError:
    pass
count = collections.Counter()
demos = collections.defaultdict(set)
for line in open(sites_file):
    line = line.rstrip("\n")
    if not line:
        continue
    key, demo = line.rsplit("\t", 1)
    count[key] += 1
    demos[key].add(demo)
new = [k for k in count if k not in known]
print(f"{len(count)} sites: {len(count) - len(new)} known, {len(new)} new")
for k in sorted(count, key=lambda k: (k in known, k)):
    tag = known.get(k, "NEW")
    if tag == "NEW" or show_all:
        print(f"  {tag:5} {count[k]:8}x  {k}  [{', '.join(sorted(demos[k]))}]")
sys.exit(1 if new else 0)
PY
rc=$?
echo "asan-demos: $(( $(date +%s) - start )) s"
[ "$bad" = 0 ] && [ "$rc" = 0 ] && [ "$hj" = 0 ]
