#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# The order of the PT_STATE pause changes on the client (brief F4, bugs.md L31).
#
#   tests/net/pause-order.sh [--bin FILE]
#
# PT_STATE carries a sequence number now, and the client orders its pause changes by (server
# gametic, sequence). The game's own check (-testpauseorder) gives the client's pause code
# the changes of a server's timeline in every order of arrival, each on time (before the client
# has run the tic it names), with and without a duplicate of each, and checks that `paused`
# before every tic is what the server had. The timelines are: a pause and an unpause for the
# same gametic (the pair of a join in progress, L31 case 2: swapped), for the next gametic
# (L31 case 1: the unpause first, then the older pause), and two longer ones; the sequence numbers
# wrap in half of the cases. One more case: a pause that arrives after a later unpause was applied,
# for a tic the client has passed, is dropped.
#
# Exit status: 0 pass, 1 fail, 2 bad set-up.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin="$root/build/native/bin/doomlegacy"
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) bin="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -x "$bin" ] || { echo "no game binary at $bin (scripts/build-native.sh)" >&2; exit 2; }
iwad="$root/testdata/freedoom1.wad"
[ -f "$iwad" ] || { echo "no $iwad (scripts/fetch-test-data.sh)" >&2; exit 2; }
home="$(mktemp -d "${TMPDIR:-/tmp}/pause-order.XXXXXX")"
trap 'rm -rf "$home"' EXIT
out="$(cd "$home" && SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy "$bin" -home "$home" -iwad "$iwad" \
    -nosound -nomusic -noendtext -testpauseorder 2>&1)"; rc=$?
printf '%s\n' "$out" | grep '^TEST: pauseorder'
cases="$(printf '%s\n' "$out" | sed -n 's/^TEST: pauseorder: \([0-9]*\) cases, 0 failures$/\1/p')"
if [ "$rc" = 0 ] && [ "${cases:-0}" -ge 200 ]; then echo "pause-order: PASS ($cases cases)"; exit 0; fi
echo "pause-order: FAIL (exit $rc)"; exit 1
