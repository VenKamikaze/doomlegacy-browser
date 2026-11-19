#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Run the native game with no window and no sound, in a temporary home, for a
# bounded time.
#
#   scripts/run-headless.sh                                   # plays freedoom1 DEMO1, exits by itself
#   scripts/run-headless.sh --iwad testdata/freedoom2.wad --demo testdata/demos/fd2demo1.lmp
#   scripts/run-headless.sh --demo none -- -warp 1 1          # no demo; extra game args after --
#   scripts/run-headless.sh --timeout 30 --home /tmp/dlhome   # keep the config/savegame dir
#
# Options:
#   --bin FILE      game binary (default build/native/bin/doomlegacy)
#   --iwad FILE     IWAD (default testdata/freedoom1.wad)
#   --demo FILE     demo to play with -playdemo, or "none" (default
#                   testdata/demos/fd1demo1.lmp). With -playdemo the game
#                   quits by itself (exit 0) at the end of the demo
#                   (G_CheckDemoStatus, singledemo -> I_Quit).
#   --timeout SECS  stop the game after SECS (default 120); then the exit status is 124
#   --home DIR      use DIR as the game's -home (kept); default: a temporary
#                   directory, deleted afterwards
#
# The game runs with its working directory set to the demo's directory (or the
# repository root with --demo none), so use absolute paths in extra arguments.
# Sets SDL_VIDEODRIVER=dummy and SDL_AUDIODRIVER=dummy, passes -nosound -nomusic
# -noendtext, and returns the game's own exit status (124 on timeout).
# Fails early (status 2) if the binary, IWAD or demo is missing: run
# scripts/build-native.sh and scripts/fetch-test-data.sh first.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/build/native/bin/doomlegacy"
iwad="$root/testdata/freedoom1.wad"
demo="$root/testdata/demos/fd1demo1.lmp"
secs=120
home=""
extra=()
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) bin="${2:?}"; shift 2 ;;
        --iwad) iwad="${2:?}"; shift 2 ;;
        --demo) demo="${2:?}"; shift 2 ;;
        --timeout) secs="${2:?}"; shift 2 ;;
        --home) home="${2:?}"; shift 2 ;;
        --) shift; extra=("$@"); break ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

[ -x "$bin" ] || { echo "no game binary at $bin (run scripts/build-native.sh)" >&2; exit 2; }
[ -f "$iwad" ] || { echo "no IWAD at $iwad (run scripts/fetch-test-data.sh)" >&2; exit 2; }
iwad="$(cd "$(dirname "$iwad")" && pwd)/$(basename "$iwad")"
bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"
args=(-iwad "$iwad" -nosound -nomusic -noendtext)
if [ "$demo" != none ]; then
    [ -f "$demo" ] || { echo "no demo at $demo (run scripts/fetch-test-data.sh)" >&2; exit 2; }
    # g_game.c keeps the demo name in a 32-byte buffer (DEMONAME_LEN) and silently
    # truncates longer paths, so run from the demo's directory with a bare name.
    demo_dir="$(cd "$(dirname "$demo")" && pwd)"
    demo_name="$(basename "$demo")"
    if [ "${#demo_name}" -gt 32 ]; then
        echo "demo file name longer than 32 bytes, which the game truncates: $demo_name" >&2
        exit 2
    fi
    # The game also tries the name as a lump first (its first 8 characters).
    args+=(-playdemo "$demo_name")
fi

made_home=""
if [ -z "$home" ]; then
    made_home="$(mktemp -d "${TMPDIR:-/tmp}/doomlegacy-home.XXXXXX")" || { echo "mktemp failed" >&2; exit 125; }
    home="$made_home"
    trap 'rm -rf -- "$made_home"' EXIT
else
    mkdir -p "$home"
fi

cd "${demo_dir:-$root}"
# timeout(1) forwards INT/TERM/HUP to the game, so a Ctrl-C stops it too.
status=0
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy DOOMWADDIR="$(dirname "$iwad")" \
    timeout -k 5 "$secs" "$bin" -home "$home" "${args[@]}" "${extra[@]}" || status=$?
[ "$status" = 124 ] && echo "run-headless: stopped after ${secs}s" >&2
exit "$status"
