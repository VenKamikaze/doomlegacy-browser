#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Build the native Linux SDL2 binary with the upstream Makefile.
#
#   scripts/build-native.sh                   # build/native/bin/doomlegacy
#   scripts/build-native.sh --build DIR       # another build directory (relative to the repo)
#   scripts/build-native.sh --clean           # make clean first
#   scripts/build-native.sh -- DEBUG=1        # extra make variables after --
#   scripts/build-native.sh --fast-math       # keep upstream's -ffast-math (build/native-fastmath)
#
# Options come from scripts/make_options_native (OS=LINUX SMIF=SDL SDL2=1
# HAVE_MIXER=1). The upstream dependency step writes one shared temp file
# (dep/sed.dep) from every rule, so it is not safe under -j: this runs
# `make depend` serially, then compiles with -j$JOBS (default: nproc).
# The build is WITHOUT -ffast-math by default: upstream adds it unconditionally
# (src/Makefile:1357), so the compiler is run through scripts/cc-no-fast-math.sh,
# which puts -fno-fast-math last on every command line. The game is lockstep and
# float results must not depend on the optimiser. --fast-math builds as upstream
# does, for comparison. REAL_CC chooses the compiler (default gcc; it may include
# flags, e.g. REAL_CC="gcc -fsanitize=address").
# common/legacy.wad is copied next to the binary, where the game looks for it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="build/native"
clean=0
fast=0
build_set=0
extra=()
while [ $# -gt 0 ]; do
    case "$1" in
        --build) build="${2:?--build needs a directory}"; build_set=1; shift 2 ;;
        --fast-math) fast=1; shift ;;
        --clean) clean=1; shift ;;
        --) shift; extra=("$@"); break ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

cd "$root"
[ "$fast" = 1 ] && [ "$build_set" = 0 ] && build="build/native-fastmath"
args=(BUILD="$build" MAKE_OPTIONS="$root/scripts/make_options_native")
if [ "$fast" = 0 ]; then
    export REAL_CC="${REAL_CC:-gcc}"
    args+=("CC_EXPLICIT_CMD=$root/scripts/cc-no-fast-math.sh")
fi
args+=("${extra[@]}")
mkdir -p "$build"
# Objects built with other flags must not be reused: a change of --fast-math,
# REAL_CC or the extra variables forces a clean rebuild of that build directory.
stamp="fast=$fast REAL_CC=${REAL_CC:-} extra=${extra[*]:-} wrapper=$(cksum < "$root/scripts/cc-no-fast-math.sh" | cut -d" " -f1)"
if [ -d "$build/objs" ] && [ "$(cat "$build/.flags" 2>/dev/null)" != "$stamp" ]; then
    echo "build flags changed since the last build in $build: rebuilding from scratch"
    clean=1
fi
make --no-print-directory "${args[@]}" dirs >/dev/null
[ "$clean" = 1 ] && make --no-print-directory "${args[@]}" clean
make --no-print-directory "${args[@]}" depend
make --no-print-directory "${args[@]}" -j"${JOBS:-$(nproc)}"
cp common/legacy.wad "$build/bin/legacy.wad"
printf '%s\n' "$stamp" > "$build/.flags"
echo "built $root/$build/bin/doomlegacy"
