#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# How the client takes the sections of a tic packet (bugs.md L35, L54), with no network and no timing.
#
#   tests/net/servertic-sections.sh [--bin FILE]
#
# The game's own check (-testservertics) gives servertic_handler tic packets made by hand, split as
# SV_Send_Tics splits a long one (45 ticcmds a datagram), in the orders a lossy link makes:
#   sections in order, swapped, and the first one again after both  (the ticcmds of a section were counted
#                                    in tics, so the first section wrote stale bytes over the later tics);
#   the packet of 1 tic, then the first section of one of 30 from the same tic  (the sections of the
#                                    one were taken for the other's, and cl_need_tic went to the end);
#   the first section of (101, 30), a late (100, 3), the first section of (101, 30) again  (the bits of
#                                    a packet were also set in the slots of the tics it covers).
# Each ticcmd holds its tic and player; the ticcmds in the slots must be those sent and cl_need_tic must go
# only as far as the tics that have come. Exit status: 0 pass, 1 fail, 2 bad set-up.
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
home="$(mktemp -d "${TMPDIR:-/tmp}/servertics.XXXXXX")"
trap 'rm -rf "$home"' EXIT
out="$(cd "$home" && SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy "$bin" -home "$home" -iwad "$iwad" \
    -nosound -nomusic -noendtext -testservertics 2>&1)"; rc=$?
printf '%s\n' "$out" | grep '^TEST: servertics'
cases="$(printf '%s\n' "$out" | sed -n 's/^TEST: servertics: \([0-9]*\) cases, 0 failures$/\1/p')"
if [ "$rc" = 0 ] && [ "${cases:-0}" -ge 5 ]; then echo "servertic-sections: PASS ($cases cases)"; exit 0; fi
echo "servertic-sections: FAIL (exit $rc)"; exit 1
