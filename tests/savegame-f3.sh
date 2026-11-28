#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# The savegame of the build before F4 (version 10149) and this build's (10150, which holds every
# player's walking bob: bugs.md L25, L53), and a join between the two builds (brief F4, AC6).
#
#   tests/savegame-f3.sh                  # all of it
#   tests/savegame-f3.sh --no-join        # without the joins over UDP
#   tests/savegame-f3.sh --old REV        # another old revision (default 14152ce, claudeai before F4)
#   tests/savegame-f3.sh --keep           # keep the work directory and print it
#   tests/savegame-f3.sh --native-bin FILE
#
# Needs scripts/build-native.sh, scripts/fetch-test-data.sh and git. The old revision is built in a
# temporary `git worktree` outside the source tree (removed afterwards); it already has -testsave
# and -testload. No savegame is committed: they are made in the work directory.
#
# Load. The demo d1demo3 is played to tic 1200 by the old build, which writes a savegame file (-testsave
#   TIC FILE game) and the savegame a join sends (the netgame header). This build:
#   - loads the file (version 10149) and plays 1,099 tics on with status 0: old saves still load;
#   - refuses the join's savegame of 10149 with "Invalid savegame: wrong version", loading nothing;
#   - writes version 10150 itself, which the old build refuses with the same message;
#   - loads its own savegame and the state as loaded equals the state it was saved in, with the
#     players' bob (the state hash holds it): a game without bots keeps the bob.
# Join. An old server and a new client, and a new server and an old client, over UDP on loopback:
#   the client does not start the game and says why: "Incompatible client" (the server refuses the other
#   NETWORK_VERSION, 27 since F4, before any savegame is sent), or "Invalid savegame: wrong version" if a build
#   that is not refused there (an old build with the version raised) gets the savegame. The savegame check
#   itself is the -testload part above, which a join cannot reach between these two builds.
#
# Exit status: 0 if everything passed, 1 if not, 2 on bad set-up.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native="$root/build/native/bin/doomlegacy"
oldrev="14152ce"
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

work="$(mktemp -d "${TMPDIR:-/tmp}/savegame-f3.XXXXXX")"
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

echo "== the build of $oldrev"
git -C "$root" worktree add --detach -q "$work/old" "$oldrev" || { echo "cannot make the worktree" >&2; exit 2; }
if ( cd "$work/old" && scripts/build-native.sh --build "$work/old-build" > "$work/old-build.log" 2>&1 ); then
    old="$work/old-build/bin/doomlegacy"
    ok "built $oldrev: $(git -C "$root" log -1 --format=%s "$oldrev" | cut -c1-70)"
else
    tail -20 "$work/old-build.log"; echo "the old build failed" >&2; exit 2
fi
[ -x "$old" ] || { echo "no old binary" >&2; exit 2; }

demo=d1demo3; iwad="$root/testdata/doom1.wad"; tic=1200
export SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy
run() {   # run BIN DIR -- args: a fresh home in DIR, the demo copied in, a status in DIR/exit
    local bin="$1" dir="$2"; shift 3
    mkdir -p "$dir"; rm -rf "$dir/.doomlegacy"; cp "$root/testdata/demos/$demo.lmp" "$dir/"
    ( cd "$dir" && timeout 300 "$bin" -home "$dir" -iwad "$iwad" -nosound -nomusic -noendtext "$@" > out.txt 2>&1; echo $? > exit )
}

echo "== both builds save at tic $tic of $demo"
run "$old" "$work/o-save" -- -timedemo "$demo.lmp" -nodraw -testdump o.bin -testsave "$tic" net.sav \
    -testsave "$tic" file.sav game -testquit "$tic" &
pids+=($!)
run "$native" "$work/n-save" -- -timedemo "$demo.lmp" -nodraw -testdump o.bin -testsave "$tic" net.sav -testquit "$tic" &
pids+=($!)
wait
for d in o-save n-save; do
    [ "$(cat "$work/$d/exit")" = 0 ] && [ -s "$work/$d/net.sav" ] || { echo "the saving run in $d failed:"; tail -5 "$work/$d/out.txt"; exit 2; }
done
ver() { python3 -I -c 'import sys,struct; d=open(sys.argv[1],"rb").read(); i=d.index(b"\0"); print(struct.unpack_from("<H", d, i+1)[0])' "$1"; }
vo="$(ver "$work/o-save/net.sav")"; vn="$(ver "$work/n-save/net.sav")"
[ "$vo" = 10149 ] && ok "the old build's savegame has version $vo" || bad "the old build's savegame has version $vo, not 10149"
[ "$vn" = 10150 ] && ok "this build's savegame has version $vn" || bad "this build's savegame has version $vn, not 10150"

echo "== this build loads the old build's savegame file"
run "$native" "$work/n-old" -- -timedemo "$demo.lmp" -nodraw -testload "$work/o-save/file.sav" -testdump L.bin -testquit 1100
e="$(cat "$work/n-old/exit")"
n="$(python3 -I "$root/tests/tools/testdump-diff.py" --info "$work/n-old/L.bin" 2>/dev/null | sed 's/ records.*//')"
if [ "$e" = 0 ] && [ "${n:-0}" -ge 1050 ]; then
    ok "loaded a version 10149 savegame file and played on: exit $e, $n records ($(grep -o 'TEST: loaded .*' "$work/n-old/out.txt" | head -1 | cut -c1-90))"
else
    bad "did not load the version 10149 savegame file and play on (exit $e, ${n:-0} records): $(tail -3 "$work/n-old/out.txt" | tr '\n' '|')"
fi

echo "== a join's savegame of 10149 is refused by this build, and 10150 by the old one"
run "$native" "$work/n-refuse" -- -timedemo "$demo.lmp" -nodraw -testload "$work/o-save/net.sav" -testquit 4
if [ "$(cat "$work/n-refuse/exit")" != 0 ] && grep -q 'wrong version' "$work/n-refuse/out.txt"; then
    ok "this build refuses a server's 10149 savegame: $(grep -o 'Invalid savegame[^\\]*' "$work/n-refuse/out.txt" | head -1)"
else
    bad "this build did not refuse a server's 10149 savegame: $(tail -2 "$work/n-refuse/out.txt" | tr '\n' '|')"
fi
run "$old" "$work/o-refuse" -- -timedemo "$demo.lmp" -nodraw -testload "$work/n-save/net.sav" -testquit 4
if [ "$(cat "$work/o-refuse/exit")" != 0 ] && grep -q 'wrong version' "$work/o-refuse/out.txt"; then
    ok "the old build refuses this build's 10150 savegame: $(grep -o 'Invalid savegame[^\\]*' "$work/o-refuse/out.txt" | head -1)"
else
    bad "the old build did not refuse this build's savegame: $(tail -2 "$work/o-refuse/out.txt" | tr '\n' '|')"
fi

echo "== this build's savegame keeps the bob (a game without bots)"
run "$native" "$work/n-load" -- -timedemo "$demo.lmp" -nodraw -testload "$work/n-save/net.sav" -testdump L.bin -teststate 1 -testquit 4
python3 -I "$root/tests/tools/state-diff.py" "$work/n-save/o.bin.state" "$work/n-load/L.bin.state" > /dev/null 2>&1
if info="$(python3 -I "$root/tests/tools/dump-at.py" "$work/n-save/o.bin" "$tic" "$work/n-load/L.bin" first)"; then
    ok "the state as loaded equals the state when saved, players included: $info"
else
    bad "the state as loaded differs from the state when saved: $info"
fi
run "$native" "$work/n-bob" -- -timedemo "$demo.lmp" -nodraw -testdump o.bin -teststate "$tic" -testquit "$tic"
run "$native" "$work/n-bob2" -- -timedemo "$demo.lmp" -nodraw -testload "$work/n-save/net.sav" -testdump L.bin -teststate 1 -testquit 4
nbob="$(grep -E '^player [0-9]+ ' "$work/n-bob/o.bin.state" | grep -oE 'bobx=-?[0-9]+ boby=-?[0-9]+' | grep -vc 'bobx=0 boby=0')"
lbob="$(grep -E '^player [0-9]+ ' "$work/n-bob2/L.bin.state" | grep -oE 'bobx=-?[0-9]+ boby=-?[0-9]+' | grep -vc 'bobx=0 boby=0')"
if [ "${nbob:-0}" -ge 1 ] && [ "$nbob" = "$lbob" ]; then
    ok "the player was walking at tic $tic (bob not 0) and the loaded game has the same bob"
else
    bad "the bob: $nbob players with a bob when saved, $lbob when loaded (the demo player must be walking at tic $tic)"
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
    echo "== a join between the old build and this build, over UDP on loopback"
    joinpair old-server "$old" "$native"
    if grep -q 'Invalid savegame: wrong version\|Incompatible client' "$work/old-server/c/out.txt" "$work/old-server/s/out.txt"; then
        ok "new client, old server: $(grep -h 'Invalid savegame\|Incompatible client' "$work/old-server/c/out.txt" "$work/old-server/s/out.txt" | head -1)"
    else
        bad "new client, old server: no 'wrong version' message: $(tail -3 "$work/old-server/c/out.txt" "$work/old-server/s/out.txt" | tr '\n' '|')"
    fi
    joinpair new-server "$native" "$old"
    if grep -q 'Invalid savegame: wrong version\|Incompatible client' "$work/new-server/c/out.txt" "$work/new-server/s/out.txt"; then
        ok "old client, new server: $(grep -h 'Invalid savegame\|Incompatible client' "$work/new-server/c/out.txt" "$work/new-server/s/out.txt" | head -1)"
    else
        bad "old client, new server: no 'wrong version' message: $(tail -3 "$work/new-server/c/out.txt" "$work/new-server/s/out.txt" | tr '\n' '|')"
    fi
fi

echo
echo "savegame-f3: $pass passed, $fail failed, $(( $(date +%s) - start )) s"
[ "$fail" = 0 ]
