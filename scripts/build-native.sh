#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Build the native Linux SDL2 binary with the upstream Makefile.
#
#   scripts/build-native.sh                   # build/native/bin/doomlegacy
#   scripts/build-native.sh --build DIR       # another build directory (relative to the repo)
#   scripts/build-native.sh --clean           # make clean first
#   scripts/build-native.sh -- DEBUG=1        # extra make variables after --
#
# Options come from scripts/make_options_native (OS=LINUX SMIF=SDL SDL2=1
# HAVE_MIXER=1). The upstream dependency step writes one shared temp file
# (dep/sed.dep) from every rule, so it is not safe under -j: this runs
# `make depend` serially, then compiles with -j$JOBS (default: nproc).
# common/legacy.wad is copied next to the binary, where the game looks for it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="build/native"
clean=0
extra=()
while [ $# -gt 0 ]; do
    case "$1" in
        --build) build="${2:?--build needs a directory}"; shift 2 ;;
        --clean) clean=1; shift ;;
        --) shift; extra=("$@"); break ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

cd "$root"
args=(BUILD="$build" MAKE_OPTIONS="$root/scripts/make_options_native" "${extra[@]}")
mkdir -p "$build"
make --no-print-directory "${args[@]}" dirs >/dev/null
[ "$clean" = 1 ] && make --no-print-directory "${args[@]}" clean
make --no-print-directory "${args[@]}" depend
make --no-print-directory "${args[@]}" -j"${JOBS:-$(nproc)}"
cp common/legacy.wad "$build/bin/legacy.wad"
echo "built $root/$build/bin/doomlegacy"
