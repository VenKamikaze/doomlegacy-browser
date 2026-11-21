#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Compiler wrapper: runs the real compiler with -fno-fast-math -ffp-contract=off as the LAST
# arguments (-ffp-contract=off: no fused multiply-add, which gcc would otherwise
# use on a target that has it; clang's wasm build has none and the wasm build
# passes the same flag). The upstream Makefile adds -ffast-math (src/Makefile:1357) and has no
# switch for it, and every other flag source (OPTS, OPTINC, make_options) lands
# before or is reset, so the only place left that wins is the end of the line.
# Used as CC_EXPLICIT_CMD by scripts/build-native.sh and scripts/build-wasm.sh.
#
#   REAL_CC       the compiler to run (default gcc)
#   CC_WRAP_ECHO  set to print each final command line on stderr
set -euo pipefail
[ -n "${CC_WRAP_ECHO:-}" ] && echo "cc-no-fast-math: ${REAL_CC:-gcc} $* -fno-fast-math -ffp-contract=off" >&2
exec ${REAL_CC:-gcc} "$@" -fno-fast-math -ffp-contract=off
