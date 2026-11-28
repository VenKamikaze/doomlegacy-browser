#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Hot join over UDP on loopback: two native instances on one machine.
#
#   tests/net/test-hot-join.sh                 # server, then a client joins a running game
#   tests/net/test-hot-join.sh --together      # baseline: both start together (-server 2)
#   tests/net/test-hot-join.sh --bin FILE      # another game binary (e.g. the ASan build)
#   tests/net/test-hot-join.sh --keep DIR      # keep the logs and dumps in DIR
#   tests/net/test-hot-join.sh --no-force      # natural join timing: no -testunpausedelay, no applied-pause check (not in the default run; run it too)
#   tests/net/test-hot-join.sh --bots          # also add two bots with long names (bugs.md L23, L24): the join must carry them
#   tests/net/test-hot-join.sh --state N       # also write the text state (-teststate N) of tic N on both machines
#   tests/net/test-hot-join.sh --join-after N  # seconds of play before the client starts (default 10)
#   tests/net/test-hot-join.sh --play N        # seconds of game time to compare after the join (default 40)
#   tests/net/test-hot-join.sh --lossy SPEC    # make both machines' datagrams lossy (-testimpair SPEC, no root), e.g.
#                                              # loss=3,dup=2,reorder=3; the server's seed is --seed, the client's --seed + 1
#   tests/net/test-hot-join.sh --seed N        # the seed of the impairment (default 1); a failing run is replayed with its seed
#   tests/net/test-hot-join.sh --runs N        # N runs, seeds --seed .. --seed + N - 1; "k of N passed"; exit 1 unless all
#                                              # passed. With --keep DIR each run keeps its files in DIR/run-SEED
#
# The server runs Freedoom 1 E1M1 headless (dummy video, no sound) with the level's monsters
# (and two bots with --bots), and writes a -testdump file. After --join-after seconds
# a client starts with -connect 127.0.0.1, receives the savegame and plays on; it
# writes a -testdump file too. Real time, 35 tics a second, so a run takes about
# --join-after + --play + start-up seconds, then the script stops both instances.
#
# Pass when:
#   - both instances were still running when the script stopped them;
#   - the client's file starts at the join tic and holds at least --play seconds of tics;
#   - the join race is forced (the server keeps its pause 5 tics longer, -testunpausedelay 5, so the
#     unpause it announces names a later tic than the client has reached) and the client log shows the
#     pending pause applied at the server's tic ("TEST: pause N applied at gametic ...");
#   - every tic that both files have is identical (tests/tools/testdump-diff.py --common);
#   - the server kept running the whole time (its last tic is within 5 of the client's);
#   - the game was not idle: the client's files shows the P_Random index moving (monsters
#     rolling dice) and the world changing;
#   - neither log reports a consistency fault, a repair or a kick. (The client logs
#     "PT_STATE: ... update client P_random index 0 to server N" while it downloads,
#     before the savegame sets its index; that one is expected.)
# Exit status: 0 pass, 1 fail, 2 bad set-up.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin="$root/build/native/bin/doomlegacy"
iwad="$root/testdata/freedoom1.wad"
join_after=10
play=40
together=0
keep=""
bots=()
force=1
state=()
lossy=""
seed=1
runs=1
args=("$@")
while [ $# -gt 0 ]; do
    case "$1" in
        --bin) bin="${2:?}"; shift 2 ;;
        --together) together=1; shift ;;
        --keep) keep="${2:?}"; shift 2 ;;
        --bots) bots=(+botgen 1 +botrandseed 136 -testaddbots 10 2); shift ;;
        --no-force) force=0; shift ;;
        --state) state=(-teststate ${2:?}); shift 2 ;;  # "N" or "FROM TO"
        --join-after) join_after="${2:?}"; shift 2 ;;
        --play) play="${2:?}"; shift 2 ;;
        --lossy) lossy="${2:?}"; shift 2 ;;
        --seed) seed="${2:?}"; shift 2 ;;
        --runs) runs="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -x "$bin" ] || { echo "no game binary at $bin (scripts/build-native.sh)" >&2; exit 2; }
[ -f "$iwad" ] || { echo "no $iwad (scripts/fetch-test-data.sh)" >&2; exit 2; }
bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"

if [ "$runs" -gt 1 ]; then
    # N runs of this script, one seed each; strip --runs, --seed and --keep from the arguments
    rest=(); i=0
    while [ $i -lt ${#args[@]} ]; do
        case "${args[$i]}" in
            --runs|--seed|--keep) i=$((i + 2)) ;;
            *) rest+=("${args[$i]}"); i=$((i + 1)) ;;
        esac
    done
    passed=0; failed_seeds=""; start=$SECONDS
    for n in $(seq 0 $((runs - 1))); do
        s=$((seed + n)); k=()
        [ -n "$keep" ] && k=(--keep "$keep/run-$s")
        echo "== run $((n + 1)) of $runs, seed $s"
        if "${BASH_SOURCE[0]}" "${rest[@]}" --seed "$s" "${k[@]}" > "${TMPDIR:-/tmp}/hot-join-run.$$.txt" 2>&1; then
            passed=$((passed + 1)); echo "  PASS"
        else
            failed_seeds="$failed_seeds $s"; echo "  FAIL"
            grep -E "FAIL|compare:|impair" "${TMPDIR:-/tmp}/hot-join-run.$$.txt" | head -8 | sed 's/^/    /'
        fi
    done
    rm -f "${TMPDIR:-/tmp}/hot-join-run.$$.txt"
    echo "hot-join: $passed of $runs passed ($((SECONDS - start)) s)${failed_seeds:+; failed seeds:$failed_seeds}"
    [ "$passed" = "$runs" ]; exit $?
fi

if [ -n "$keep" ]; then mkdir -p "$keep"; work="$(cd "$keep" && pwd)"; else
    work="$(mktemp -d "${TMPDIR:-/tmp}/hot-join.XXXXXX")"; fi
pids=()
cleanup() {
    for p in "${pids[@]}"; do kill -KILL "$p" 2>/dev/null; done
    [ -n "$keep" ] || rm -rf "$work"
}
trap cleanup EXIT

if [ "$force" = 1 ]; then unpause=(-testunpausedelay 5); else unpause=(); fi
port_s=$((20000 + RANDOM % 20000)); port_c=$((port_s + 1))
mkdir -p "$work/s" "$work/c"
export SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy
# With a sanitizer build (tests/asan-demos.sh builds one) reports must not stop the game.
export ASAN_OPTIONS="${ASAN_OPTIONS:-halt_on_error=0:detect_leaks=0}"
common=(-iwad "$iwad" -nosound -nomusic -noendtext -skill 3)
imp_s=(); imp_c=()
if [ -n "$lossy" ]; then imp_s=(-testimpair "$lossy,seed=$seed"); imp_c=(-testimpair "$lossy,seed=$((seed + 1))"); fi

tics() { # number of records in a dump
    [ -f "$1" ] && echo $(( $(stat -c %s "$1") / 28 )) || echo 0
}
fail=0
check() { # check "name" status
    if [ "$2" = 0 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi
}

# The server: -server 1 starts the game with the host alone and lets others join in
# game; -server 2 waits for a second player node. Bots give the game something to do.
if [ "$together" = 1 ]; then nodes=2; else nodes=1; fi
( cd "$work/s" && exec "$bin" -home "$work/s" "${common[@]}" -server "$nodes" -udpport "$port_s" \
    -warp 1 1 "${unpause[@]}" "${imp_s[@]}" -testdump s.bin "${state[@]}" "${bots[@]}" > out.txt 2>&1 ) &
spid=$!; pids+=("$spid")
echo "server: pid $spid, port $port_s"

if [ "$together" = 0 ]; then
    # wait for the game to be running, then let it play for a while
    for _ in $(seq 1 60); do
        [ "$(tics "$work/s/s.bin")" -gt $((join_after * 35)) ] && break
        kill -0 "$spid" 2>/dev/null || break
        sleep 1
    done
fi
if ! kill -0 "$spid" 2>/dev/null; then
    echo "the server exited early; its log ends:"; tail -5 "$work/s/out.txt"; exit 1
fi
join_server_tic="$(tics "$work/s/s.bin")"
echo "client joins at server tic about $join_server_tic"
( cd "$work/c" && exec "$bin" -home "$work/c" "${common[@]}" -connect 127.0.0.1 -udpport "$port_s" \
    -clientport "$port_c" "${imp_c[@]}" -testdump c.bin "${state[@]}" > out.txt 2>&1 ) &
cpid=$!; pids+=("$cpid")

# wait until the client has played $play seconds of tics, up to a limit
need=$((play * 35)); limit=$((play + 90))
for _ in $(seq 1 "$limit"); do
    [ "$(tics "$work/c/c.bin")" -ge "$need" ] && break
    kill -0 "$cpid" 2>/dev/null || break
    kill -0 "$spid" 2>/dev/null || break
    sleep 1
done
sleep 1
s_alive=1; c_alive=1
kill -0 "$spid" 2>/dev/null || s_alive=0
kill -0 "$cpid" 2>/dev/null || c_alive=0
for p in "$cpid" "$spid"; do kill -TERM "$p" 2>/dev/null; done
sleep 2
for p in "$cpid" "$spid"; do kill -KILL "$p" 2>/dev/null; done
wait 2>/dev/null

sn="$(tics "$work/s/s.bin")"; cn="$(tics "$work/c/c.bin")"
echo "server file: $sn records; client file: $cn records"
check "the server was still running at the end" $((1 - s_alive))
check "the client was still running at the end" $((1 - c_alive))
if [ "$together" = 0 ] && [ "$force" = 1 ]; then
    check "the client applied a pending pause change at the server's tic (the race of L21 was forced)" \
        $(grep -q "TEST: pause [0-9]* applied at gametic" "$work/c/out.txt" && echo 0 || echo 1)
fi
check "the client played at least $play s of tics ($cn >= $need)" $([ "$cn" -ge "$need" ] && echo 0 || echo 1)
if [ "$cn" -gt 0 ] && [ "$sn" -gt 0 ]; then
    first="$(python3 -I "$root/tests/tools/testdump-diff.py" --info "$work/c/c.bin")"
    echo "client: $first"
    slast="$(python3 -I "$root/tests/tools/testdump-diff.py" --info "$work/s/s.bin" | sed 's/.*\.\.//')"
    clast="$(printf '%s' "$first" | sed 's/.*\.\.//')"
    check "the server kept running: its last tic $slast >= the client's last tic $clast minus 5" \
        $([ "${slast:-0}" -ge $(( ${clast:-0} - 5 )) ] && echo 0 || echo 1)
    res="$(python3 -I "$root/tests/tools/testdump-diff.py" --common "$work/s/s.bin" "$work/c/c.bin")"; rc=$?
    echo "  compare: $res"
    check "every tic both files have is identical" $rc
    act="$(python3 -I - "$work/c/c.bin" <<'PY'
import struct, sys
d = open(sys.argv[1], 'rb').read()
r = [struct.unpack_from('<7I', d, i) for i in range(0, len(d), 28)]
print(len(set(x[2] for x in r)), len(set(x[5] for x in r)))
PY
)"
    set -- $act
    echo "  activity: $1 distinct P_Random states, $2 distinct world states in the client's file"
    check "the game was not idle (>= 20 random states, >= 3 world states)" $([ "${1:-0}" -ge 20 ] && [ "${2:-0}" -ge 3 ] && echo 0 || echo 1)
fi
if [ "${#bots[@]}" -gt 0 ]; then
    # the game must really have had the bots (a test that lost them would pass as a game without)
    for who in s c; do
        check "$who: the log says there were 2 bots in the game" \
            $(grep -q "TEST: bots in game: 2 " "$work/$who/out.txt" && echo 0 || echo 1)
    done
fi
faults='consistency (fault|failure)|desync|out of sync|Client repair|Report: gametic|Kick (node|player)|savegame failed|Can.t load the level'
if grep -qiE "$faults" "$work/s/out.txt" "$work/c/out.txt" 2>/dev/null; then
    check "no consistency fault or repair in the logs" 1
    grep -iE "$faults" "$work/s/out.txt" "$work/c/out.txt" | head -5
else
    check "no consistency fault or repair in the logs" 0
fi
if [ -n "$lossy" ]; then
    # the datagrams really were lost, duplicated and reordered (the counts each game prints when it leaves)
    for who in s c; do
        line="$(grep 'TEST: impair: of' "$work/$who/out.txt" | tail -1)"
        echo "  $who: ${line:-no impairment report}"
        [[ "$lossy" == *loss=* ]] && check "$who: datagrams were lost" $(printf '%s' "$line" | grep -qE 'lost [1-9]' && echo 0 || echo 1)
        [[ "$lossy" == *dup=* ]] && check "$who: datagrams were duplicated" $(printf '%s' "$line" | grep -qE 'duplicated [1-9]' && echo 0 || echo 1)
        [[ "$lossy" == *reorder=* ]] && check "$who: datagrams were reordered" $(printf '%s' "$line" | grep -qE 'reordered [1-9]' && echo 0 || echo 1)
    done
fi
# Sanitizer reports (none in a normal build): a site not in tests/asan-known.txt fails.
newsites="$(python3 -I "$root/tests/tools/sanitizer-sites.py" --unknown "$root/tests/asan-known.txt" \
    "$work/s/out.txt" "$work/c/out.txt")"
if [ -n "$newsites" ]; then
    check "no sanitizer report from a site that is not in tests/asan-known.txt" 1
    printf '%s\n' "$newsites" | head -10 | sed 's/^/    /'
fi
if [ "$fail" = 0 ]; then echo "hot-join: PASS"; else echo "hot-join: FAIL"; [ -n "$keep" ] || echo "(use --keep DIR to keep the logs)"; fi
exit "$fail"
