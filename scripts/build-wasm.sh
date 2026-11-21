#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Build the Emscripten (WebAssembly) version into build/wasm/bin/doomlegacy.{js,wasm}.
#
#   scripts/build-wasm.sh              # incremental build, 4 jobs
#   scripts/build-wasm.sh -j2          # other make options are passed through
#   scripts/build-wasm.sh clean        # remove build/wasm
#   EMSDK_DIR=/opt/emsdk scripts/build-wasm.sh
#   EM_CACHE=/tmp/cache scripts/build-wasm.sh   # a private Emscripten cache (seed it with
#                                               # scripts/setup-emsdk.sh --with-ports)
#
# Needs Emscripten 6.0.13 (scripts/setup-emsdk.sh --with-ports). Software renderer
# only (D5). The rules are in scripts/wasm.mk. Without -ffast-math.
set -euo pipefail

case "${1:-}" in
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_DIR="${EMSDK_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/doomlegacy-browser/emsdk}"

if [ ! -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    echo "build-wasm: no emsdk in $EMSDK_DIR; run scripts/setup-emsdk.sh --with-ports first" >&2
    exit 1
fi
# emsdk_env.sh clears EM_CACHE; put a caller's value back.
saved_cache="${EM_CACHE:-}"
# shellcheck disable=SC1091
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
[ -z "$saved_cache" ] || export EM_CACHE="$saved_cache"

case "$(emcc --version | head -1)" in
    *" 6.0.13 "*) ;;
    *) echo "build-wasm: expected Emscripten 6.0.13, got: $(emcc --version | head -1)" >&2; exit 1 ;;
esac

cd "$root"
jobs=(-j4)
for a in "$@"; do case "$a" in -j*) jobs=() ;; esac; done
exec make -f scripts/wasm.mk "${jobs[@]}" "$@"
