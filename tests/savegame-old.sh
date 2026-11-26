#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# The savegame of the build from before brief F2 (acceptance 4 and 5), and a join between the
# two builds.
#
#   tests/savegame-old.sh                 # all of it
#   tests/savegame-old.sh --no-join       # without the join between the builds (the last part)
#   tests/savegame-old.sh --old REV       # another old revision (default 72924ef, claudeai before F2)
#   tests/savegame-old.sh --keep          # keep the work directory (and the old build) and print it
#   tests/savegame-old.sh --native-bin FILE
#
# Needs scripts/build-native.sh, scripts/fetch-test-data.sh and git. The old revision is built
# here, in a temporary `git worktree` outside the source tree (removed afterwards), with this
# tree's src/test_dump.c and src/test_dump.h copied in, which is all it needs to write a savegame
# at a tic (-testsave) and to load one (-testload). Its ext/vnet is not checked out, so its
# i_vnet.c is built as stubs. No savegame is ever committed: they are made in the work directory.
#
# AC4 (L30). The demo d1demo3 is played to tic 1200 by the old build, which writes the
#   savegame its join sends, then loads it (-testload). The state of the game as loaded must
#   equal the state it was saved in; on the old build it does not, and the state lines that
#   differ are printed: the sectors' soundtarget is among them, which no savegame held. (The old
#   build also loses the height of corpses, flags3 and the ceiling height of things; the new
#   build carries those too, see bugs.md L36 to L39.) The same on the new build: equal.
# AC5. The old build writes a savegame with the header of a savegame file at the same tic
#   (-testsave TIC FILE game): the old layout, version 149. The new build loads it
#   (-testload) on native and plays on 1,099 tics with exit status 0; the sector effects, the
#   sectors and the random state it holds are the ones the old build had when it saved (the
#   hashes of the specials, the world and the random state are equal). The new build refuses the
#   old layout when it is sent by a server (the netgame header, what a join sends): it says so
#   and loads nothing.
# Join. An old server and a new client, and a new server and an old client, over UDP on
#   loopback: the client must say why it cannot join ("the server is an older build" or "wrong
#   version") and must not start the game.
#
# Exit status: 0 if everything passed, 1 if not, 2 on bad set-up.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native="$root/build/native/bin/doomlegacy"
oldrev="72924ef"
join=1
keep=0
while [ $# -gt 0 ]; do
    case "$1" in
        --old) oldrev="${2:?}"; shift 2 ;;
        --no-join) join=0; shift ;;
        --keep) keep=1; shift ;;
        --native-bin) native="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -x "$native" ] || { echo "no native binary at $native (scripts/build-native.sh)" >&2; exit 2; }
native="$(cd "$(dirname "$native")" && pwd)/$(basename "$native")"
for f in freedoom1 doom1; do
    [ -f "$root/testdata/$f.wad" ] || { echo "no testdata/$f.wad (scripts/fetch-test-data.sh)" >&2; exit 2; }
done
git -C "$root" rev-parse --verify -q "$oldrev^{commit}" > /dev/null || { echo "no revision $oldrev in this repository" >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/savegame-old.XXXXXX")"
pids=()
cleanup() {
    for p in "${pids[@]}"; do kill -KILL "$p" 2>/dev/null; done
    git -C "$root" worktree remove --force "$work/old" > /dev/null 2>&1
    git -C "$root" worktree prune
    [ "$keep" = 1 ] || rm -rf "$work"
}
trap cleanup EXIT
[ "$keep" = 0 ] || echo "work directory: $work"

pass=0; fail=0
ok()  { echo "   ok   $*"; pass=$((pass+1)); }
bad() { echo "   FAIL $*"; fail=$((fail+1)); }
start=$(date +%s)

# ---- the old build ----
echo "== the build of $oldrev, with this tree's test hooks"
git -C "$root" worktree add --detach -q "$work/old" "$oldrev" || { echo "cannot make the worktree" >&2; exit 2; }
cp "$root/src/test_dump.c" "$root/src/test_dump.h" "$work/old/src/"
if ( cd "$work/old" && scripts/build-native.sh --build "$work/old-build" > "$work/old-build.log" 2>&1 ); then
    old="$work/old-build/bin/doomlegacy"
    ok "built $oldrev: $(git -C "$root" log -1 --format=%s "$oldrev" | cut -c1-70)"
else
    tail -20 "$work/old-build.log"; echo "the old build failed" >&2; exit 2
fi
[ -x "$old" ] || { echo "no old binary" >&2; exit 2; }

demo=d1demo3; iwad="$root/testdata/doom1.wad"; tic=1200
export SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy

# run BIN DIR -- args: a fresh home in DIR, the demo copied in, a status in DIR/exit
run() {
    local bin="$1" dir="$2"; shift 3
    mkdir -p "$dir"; rm -rf "$dir/.doomlegacy"; cp "$root/testdata/demos/$demo.lmp" "$dir/"
    ( cd "$dir" && timeout 300 "$bin" -home "$dir" -iwad "$iwad" -nosound -nomusic -noendtext "$@" > out.txt 2>&1; echo $? > exit )
}

# ---- the old build writes its savegames (the join's and a savegame file's) at the tic ----
echo "== the old build saves at tic $tic of $demo"
run "$old" "$work/o-save" -- -timedemo "$demo.lmp" -nodraw -testdump o.bin -teststate "$tic" \
    -testsave "$tic" net.sav -testsave "$tic" file.sav game -testquit "$tic" &
pids+=($!)
run "$native" "$work/n-save" -- -timedemo "$demo.lmp" -nodraw -testdump o.bin -teststate "$tic" \
    -testsave "$tic" net.sav -testquit "$tic" &
pids+=($!)
wait
for d in o-save n-save; do
    [ "$(cat "$work/$d/exit")" = 0 ] && [ -s "$work/$d/net.sav" ] || { echo "the saving run in $d failed:"; tail -5 "$work/$d/out.txt"; exit 2; }
done
echo "   old build: $(grep '^TEST: save holds' "$work/o-save/out.txt" | head -1 | sed 's/^TEST: save holds: //' | tr ' ' '\n' | paste -d= - - | grep -v '=0$' | tr '\n' ' ')"
echo "   old save: $(stat -c %s "$work/o-save/net.sav") bytes; new save: $(stat -c %s "$work/n-save/net.sav") bytes"

# ---- AC4: state at load against state at save, old build then new build ----
echo "== AC4: the state as loaded against the state when saved (tic $tic)"
run "$old" "$work/o-load" -- -timedemo "$demo.lmp" -nodraw -testload "$work/o-save/net.sav" -testdump L.bin -teststate 1 -testquit 4
run "$native" "$work/n-load" -- -timedemo "$demo.lmp" -nodraw -testload "$work/n-save/net.sav" -testdump L.bin -teststate 1 -testquit 4
if info="$(python3 -I "$root/tests/tools/dump-at.py" "$work/o-save/o.bin" "$tic" "$work/o-load/L.bin" first)"; then
    bad "old build: the state as loaded equals the state when saved (it does not on the build from before F2): $info"
else
    ok "old build: the state as loaded differs from the state when saved, as before this chunk: $info"
    python3 -I "$root/tests/tools/state-diff.py" "$work/o-save/o.bin.state" "$work/o-load/L.bin.state" 2000 > "$work/o-diff.txt"
    echo "        state lines that differ (saved -> loaded), the sectors' soundtarget first:"
    { grep 'soundtarget' "$work/o-diff.txt" | head -4; grep -v 'soundtarget' "$work/o-diff.txt" | head -4; } | cut -c1-200 | sed 's/^/          /'
    echo "        $(grep -c 'soundtarget' "$work/o-diff.txt") sector lines differ in soundtarget, $(grep -vc 'soundtarget' "$work/o-diff.txt") lines in other fields"
fi
if info="$(python3 -I "$root/tests/tools/dump-at.py" "$work/n-save/o.bin" "$tic" "$work/n-load/L.bin" first)"; then
    ok "new build: the state as loaded equals the state when saved: $info"
else
    bad "new build: the state as loaded differs from the state when saved: $info"
fi

# ---- AC5: the old layout, loaded by the new build ----
echo "== AC5: the savegame file of the old build, loaded by the new build"
run "$native" "$work/n-old" -- -timedemo "$demo.lmp" -nodraw -testload "$work/o-save/file.sav" -testdump L.bin -teststate 1 -testquit 1100
e="$(cat "$work/n-old/exit")"
n="$(python3 -I "$root/tests/tools/testdump-diff.py" --info "$work/n-old/L.bin" 2>/dev/null | sed 's/ records.*//')"
if [ "$e" = 0 ] && [ "${n:-0}" -ge 1050 ]; then
    ok "the new build loaded it ($(grep -o 'loaded .*' "$work/n-old/out.txt" | head -1 | cut -c1-90)) and played on: exit $e, $n records"
else
    bad "the new build did not load the old savegame file and play on (exit $e, ${n:-0} records): $(tail -3 "$work/n-old/out.txt" | tr '\n' '|')"
fi
grep -q 'file.sav (game header, version 149)' "$work/n-old/out.txt" \
    && ok "the log says it is a version 149 savegame of the old layout, not the portable one" \
    || bad "the log does not show the old layout was read: $(grep 'TEST: loaded' "$work/n-old/out.txt")"
# What the old layout holds must come back: the sector effects and the random state (the hashes
# are equal), and the sectors, lines and sides (equal but for the sectors' soundtarget, which the old
# layout does not hold). The things are made again with the ceiling height of their sector.
for w in random specials; do
    python3 - "$work/o-save/o.bin" "$tic" "$work/n-old/L.bin" "$w" <<'EOF'
import struct, sys
NAMES = ("tic", "total", "random", "players", "mobjs", "world", "specials")
def rec(path, tic):
    d = open(path, "rb").read()
    for i in range(0, len(d), 28):
        r = struct.unpack_from("<7I", d, i)
        if tic == "first" or r[0] == int(tic):
            return r
a, b, w = rec(sys.argv[1], sys.argv[2]), rec(sys.argv[3], "first"), NAMES.index(sys.argv[4])
print(f"        {sys.argv[4]}: saved {a[w]:08x} loaded {b[w]:08x}")
sys.exit(0 if a[w] == b[w] else 1)
EOF
    [ $? = 0 ] && ok "old layout read: the $w state is the one the old build saved" \
               || bad "old layout read: the $w state differs from the one the old build saved"
done
python3 -I "$root/tests/tools/state-diff.py" "$work/o-save/o.bin.state" "$work/n-old/L.bin.state" 400 > "$work/old-layout-diff.txt"
other="$(grep -E ': (sector|line|side) [0-9]+:' "$work/old-layout-diff.txt" | grep -vE ': sector [0-9]+: soundtarget: -?[0-9]+ -> -?[0-9]+$')"
if [ -z "$other" ] && grep -q ': sector [0-9]*: soundtarget' "$work/old-layout-diff.txt"; then
    ok "old layout read: the sectors, lines and sides are the ones the old build saved, but for the soundtarget ($(grep -c 'soundtarget' "$work/old-layout-diff.txt") sectors that the old layout does not hold)"
else
    bad "old layout read: sectors, lines or sides differ from the saved ones: $(printf '%s' "$other" | head -3 | tr '\n' '|')"
fi
# A server's savegame of the old layout (the netgame header) is refused by the new build.
run "$native" "$work/n-refuse" -- -timedemo "$demo.lmp" -nodraw -testload "$work/o-save/net.sav" -testquit 4
if [ "$(cat "$work/n-refuse/exit")" != 0 ] && grep -q 'the server is an older build' "$work/n-refuse/out.txt"; then
    ok "the new build refuses the old layout when it is a server's: $(grep -o 'Invalid savegame[^\\]*' "$work/n-refuse/out.txt" | head -1)"
else
    bad "the new build did not refuse the server's savegame of the old layout: $(tail -2 "$work/n-refuse/out.txt" | tr '\n' '|')"
fi
# And the old build refuses a new savegame: its version is above any it knows.
run "$old" "$work/o-refuse" -- -timedemo "$demo.lmp" -nodraw -testload "$work/n-save/net.sav" -testquit 4
if [ "$(cat "$work/o-refuse/exit")" != 0 ] && grep -q 'wrong version' "$work/o-refuse/out.txt"; then
    ok "the old build refuses the new layout: $(grep -o 'Invalid savegame[^\\]*' "$work/o-refuse/out.txt" | head -1)"
else
    bad "the old build did not refuse the new savegame: $(tail -2 "$work/o-refuse/out.txt" | tr '\n' '|')"
fi

# ---- a join between the two builds ----
joinpair() {   # joinpair NAME SERVER_BIN CLIENT_BIN
    local name="$1" sbin="$2" cbin="$3" ps=$((20000 + RANDOM % 20000)) pc spid cpid i
    pc=$((ps + 1))
    mkdir -p "$work/$name/s" "$work/$name/c"
    ( cd "$work/$name/s" && exec "$sbin" -home "$work/$name/s" -iwad "$root/testdata/freedoom1.wad" -nosound -nomusic -noendtext \
        -skill 3 -server 1 -udpport "$ps" -warp 1 1 > out.txt 2>&1 ) &
    spid=$!; pids+=("$spid")
    for i in $(seq 1 30); do grep -q 'Starting Server\|E1M1\|Level' "$work/$name/s/out.txt" 2>/dev/null && break; sleep 1; done
    sleep 6
    ( cd "$work/$name/c" && exec "$cbin" -home "$work/$name/c" -iwad "$root/testdata/freedoom1.wad" -nosound -nomusic -noendtext \
        -connect 127.0.0.1 -udpport "$ps" -clientport "$pc" > out.txt 2>&1 ) &
    cpid=$!; pids+=("$cpid")
    for i in $(seq 1 40); do grep -q "Can't load the level\|Invalid savegame" "$work/$name/c/out.txt" 2>/dev/null && break; sleep 1; done
    sleep 2
    kill -TERM "$cpid" "$spid" 2>/dev/null; sleep 2; kill -KILL "$cpid" "$spid" 2>/dev/null
    wait 2>/dev/null
}
if [ "$join" = 1 ]; then
    echo "== a join between the old build and the new build, over UDP on loopback"
    joinpair old-server "$old" "$native"
    if grep -q 'the server is an older build' "$work/old-server/c/out.txt"; then
        ok "new client, old server: $(grep -h 'Invalid savegame' "$work/old-server/c/out.txt" | head -1)"
    else
        bad "new client, old server: no message that the savegame is of an older build: $(tail -3 "$work/old-server/c/out.txt" | tr '\n' '|')"
    fi
    joinpair new-server "$native" "$old"
    if grep -q 'wrong version' "$work/new-server/c/out.txt"; then
        ok "old client, new server: $(grep -h 'Invalid savegame' "$work/new-server/c/out.txt" | head -1)"
    else
        bad "old client, new server: no message that the savegame has a wrong version: $(tail -3 "$work/new-server/c/out.txt" | tr '\n' '|')"
    fi
fi

echo
echo "savegame-old: $pass passed, $fail failed, $(( $(date +%s) - start )) s"
[ "$fail" = 0 ]
