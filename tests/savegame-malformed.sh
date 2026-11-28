#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# A savegame with a bad bot section must be refused, not read past its buffer (brief F3 fix
# round 1, items 1 and 3), and a join of a savegame whose bots have no state is refused.
#
#   tests/savegame-malformed.sh                 # loads with build/asan (built if missing); saves with build/native
#   tests/savegame-malformed.sh --bin FILE      # another game binary to load with (e.g. an ASan build of an older tree)
#   tests/savegame-malformed.sh --keep          # keep the work directory and print it
#
# A real savegame with two bots on a big map (Freedoom 1 E4M8: the grid is large, so that a
# path length that fits the grid is still far past the end of a truncated file) is changed
# in the bots' state section, and each variant is loaded with -testload:
#   truncated-long    the first bot's path length set to 60000, the file cut right after it
#   truncated-mid     the file cut in the middle of the first bot's record
#   oversized-n       the path length 2,000,000, the file whole
#   bad-node          a path of one node whose x is 99999
#   bad-player        a bot record for player 31 (no such bot)
# Each must be refused (an exit status that is not 0 and not a signal's, a message that says
# "bad bot state" or "corrupted"), with no AddressSanitizer report. Also:
#   control           the savegame as it is: loads
#   no-state-net      the netgame savegame (what a join sends) with the bot state removed, as a
#                     build from before F3 writes it: refused, and the message names that build
#   no-state-game     the same with a game header (a savegame file): loads, the new fields empty
# and no sanitizer report from a site that is not in tests/asan-known.txt.
# Exit status: 0 pass, 1 fail, 2 bad set-up.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/build/asan/bin/doomlegacy"
nat="$root/build/native/bin/doomlegacy"
keep=0
bin_set=0
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) bin="${2:?}"; bin_set=1; shift 2 ;;
        --keep) keep=1; shift ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
iwad="$root/testdata/freedoom1.wad"
[ -f "$iwad" ] || { echo "no $iwad (scripts/fetch-test-data.sh)" >&2; exit 2; }
[ -x "$nat" ] || { echo "no native binary at $nat (scripts/build-native.sh)" >&2; exit 2; }
# (rebuilt when it is missing or older than a source file: a stale binary reads an older layout)
if [ "$bin_set" = 0 ] && { [ ! -x "$bin" ] || [ -n "$(find "$root/src" -name '*.[ch]' -newer "$bin" -print -quit)" ]; }; then
    echo "building the ASan binary (build/asan) ..."
    ( cd "$root" && REAL_CC="gcc -fsanitize=address,undefined -fsanitize-recover=all -fno-sanitize=alignment -fno-omit-frame-pointer -g" \
        scripts/build-native.sh --build build/asan --clean > "${TMPDIR:-/tmp}/asan-build.log" 2>&1 ) || { echo "ASan build failed" >&2; exit 2; }
fi
[ -x "$bin" ] || { echo "no game binary at $bin" >&2; exit 2; }
bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"

work="$(mktemp -d "${TMPDIR:-/tmp}/savegame-malformed.XXXXXX")"
if [ "$keep" = 1 ]; then echo "work directory: $work"; else trap 'rm -rf "$work"' EXIT; fi
export SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy
export ASAN_OPTIONS="halt_on_error=0:detect_leaks=0"

# a real save: E4M8, two bots, at tic 12 (a bot game on this map is slow later); a netgame header
# (what a join sends) and a game header
mkdir -p "$work/mk/h"
( cd "$work/mk" && timeout -s KILL 120 "$nat" -home "$work/mk/h" -iwad "$iwad" -nosound -nomusic -noendtext -skill 3 \
    -warp 4 8 +botgen 1 +botrandseed 136 -testaddbots 10 2 -nodraw -testdump x.bin \
    -testsave 12 net.sav -testsave 12 game.sav game -testquit 12 > out.txt 2>&1 )
[ -s "$work/mk/net.sav" ] && [ -s "$work/mk/game.sav" ] || { echo "could not make the savegames:" >&2; tail -n 5 "$work/mk/out.txt" >&2; exit 2; }

python3 -I - "$work/mk" <<'PY' || { echo "could not change the savegames" >&2; exit 2; }
import struct, sys
d = sys.argv[1]
def sect(b):
    i = b.rfind(b'\xfd\xf1')
    assert i > 0 and b.endswith(b'\xff\xfd\xfc'), "no bot state section"
    rec = i + 2 + 4                      # after the marker and oksector (the walking bob is in the players' records since 10150)
    assert b[rec] < 32, "first record is not a player"
    nfield = rec + 1 + 7 * 4 + 8         # the path length
    return i, rec, nfield
for kind in ('net', 'game'):
    b = open(f'{d}/{kind}.sav', 'rb').read()
    i, rec, nf = sect(b)
    open(f'{d}/control-{kind}.sav', 'wb').write(b)
    open(f'{d}/no-state-{kind}.sav', 'wb').write(b[:i] + b[len(b) - 2:])
    if kind != 'net':
        continue
    big = b[:nf] + struct.pack('<i', 60000) + b[nf + 4:]
    open(f'{d}/truncated-long.sav', 'wb').write(big[:nf + 4 + 16])
    open(f'{d}/truncated-mid.sav', 'wb').write(b[:rec + 10])
    open(f'{d}/oversized-n.sav', 'wb').write(b[:nf] + struct.pack('<i', 2000000) + b[nf + 4:])
    n = struct.unpack_from('<i', b, nf)[0]
    one = struct.pack('<iii', 1, 99999, 0)
    open(f'{d}/bad-node.sav', 'wb').write(b[:nf] + one + b[nf + 4 + 8 * n:])
    bp = bytearray(b); bp[rec] = 31
    open(f'{d}/bad-player.sav', 'wb').write(bytes(bp))
PY

pass=0; fail=0
ok()  { echo "  ok   $*"; pass=$((pass+1)); }
bad() { echo "  FAIL $*"; fail=$((fail+1)); }

load() {   # load NAME FILE -> $dir/out.txt, $dir/exit
    local name="$1" file="$2" dir="$work/load-$1"
    mkdir -p "$dir/h"; cp "$file" "$dir/in.sav"
    ( cd "$dir" && timeout -s KILL 120 "$bin" -home "$dir/h" -iwad "$iwad" -nosound -nomusic -noendtext -nodraw \
        -testload in.sav -testquit 5 > out.txt 2>&1; echo $? > exit )
}
refused() {   # refused NAME FILE [message regex]
    local name="$1" re="${3:-bad bot state|corrupted}" e
    load "$name" "$2"
    e="$(cat "$work/load-$name/exit")"
    if grep -q "AddressSanitizer" "$work/load-$name/out.txt"; then
        bad "$name: AddressSanitizer: $(grep -m1 'AddressSanitizer' "$work/load-$name/out.txt" | cut -c1-120)"
    elif [ "$e" -ne 0 ] && [ "$e" -ne 134 ] && [ "$e" -ne 137 ] && [ "$e" -ne 139 ] && grep -Eq "$re" "$work/load-$name/out.txt"; then
        ok "$name: refused (exit $e)"
    else
        bad "$name: not refused cleanly (exit $e, expected an exit status that is not 0, 134, 137 or 139, and /$re/)"
        tail -n 3 "$work/load-$name/out.txt" | cut -c1-160
    fi
}
echo "== loads with $bin"
load control-net "$work/mk/control-net.sav"
if [ "$(cat "$work/load-control-net/exit")" = 0 ] && grep -q "TEST: loaded" "$work/load-control-net/out.txt" \
   && ! grep -q AddressSanitizer "$work/load-control-net/out.txt"; then ok "control: the savegame as written loads"
else bad "control: does not load"; tail -n 3 "$work/load-control-net/out.txt"; fi
for v in truncated-long truncated-mid oversized-n bad-node bad-player; do refused "$v" "$work/mk/$v.sav"; done
refused no-state-net "$work/mk/no-state-net.sav" "build before the bot changes"
load no-state-game "$work/mk/no-state-game.sav"
if [ "$(cat "$work/load-no-state-game/exit")" = 0 ] && grep -q "TEST: loaded" "$work/load-no-state-game/out.txt"; then
    ok "no-state-game: a savegame file without the bot state loads, the new fields empty"
else bad "no-state-game: does not load"; tail -n 3 "$work/load-no-state-game/out.txt"; fi
newsites="$(python3 -I "$root/tests/tools/sanitizer-sites.py" --unknown "$root/tests/asan-known.txt" "$work"/load-*/out.txt)"
if [ -n "$newsites" ]; then bad "a sanitizer report from a site that is not in tests/asan-known.txt"; printf '%s\n' "$newsites" | head -5; fi
echo "savegame-malformed: $pass passed, $fail failed"
[ "$fail" = 0 ]
