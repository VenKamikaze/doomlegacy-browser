#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Three native players through a local vnet relay (brief 01, AC3 and AC4).
#
#   tests/net/test-relay.sh                 # AC3 (clean), then AC4 (impaired), one run each
#   tests/net/test-relay.sh --clean-only    # AC3 only
#   tests/net/test-relay.sh --impair-only   # AC4 only
#   tests/net/test-relay.sh --runs N        # N runs of each case
#   tests/net/test-relay.sh --dedicated     # a -dedicated server and two players, clean
#   tests/net/test-relay.sh --impair SPEC   # the impairment (default below)
#   tests/net/test-relay.sh --bin FILE      # another game binary
#   tests/net/test-relay.sh --keep          # keep the logs and dumps (printed at the end)
#   tests/net/test-relay.sh --state FROM TO # also write the text state (-teststate FROM TO) on all three, to find a difference
#   tests/net/test-relay.sh --join-after N  # seconds of play before the third player joins (default 10)
#   tests/net/test-relay.sh --play N        # seconds of game time to compare after the join (default 30)
#
# Each case starts a relay of its own on a port the relay picks, then three game
# processes (headless, Freedoom 1 E1M1, real time, 35 tics a second):
#   server  -relay R -server 2        creates the room and prints its code
#   A       -relay R -connect CODE    joins at the start (the server waits for it)
#   B       -relay R -connect CODE    joins the game in progress, --join-after seconds later
# With --dedicated the server is "-dedicated -server 2" (no player) and A and B join at the
# start. No level is loaded: a dedicated server of this build crashes when it loads one,
# also over UDP and before this brief (bugs.md L33), so the three machines exchange the
# game's tics in the state before the first level; the files must still be identical and
# every packet of the room, the joins and the tic exchange crosses the relay. A dedicated
# server ignores SIGTERM (upstream), so the test stops it with SIGKILL.
# Every process writes a -testdump file. The impaired case sets VNET_IMPAIR on every
# process (lat=30 by default; see the default below), each with a seed of its own
# (the run number and the player), so latency, jitter, loss, duplication and reordering
# hit every datagram any process sends; the game's own acks and resends must cope.
#
# A case passes when:
#   - the server, A and B all ran until the script stopped them, and all three logged
#     the same room code;
#   - B joined in progress (its first record is well after the start) and has at least
#     --play seconds of tics after the join;
#   - every tic that both files have is identical, server against A and server against B
#     (tests/tools/testdump-diff.py --common); the game was not idle;
#   - no consistency fault, repair, kick, vnet failure or sanitizer report in any log;
#   - with impairment: the datagrams really were lost, duplicated and reordered (the
#     counters each process prints when it leaves the room).
# Exit status: 0 pass, 1 fail, 2 bad set-up.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

game_bin="$root/build/native/bin/doomlegacy"
iwad="$root/testdata/freedoom1.wad"
runs=1
do_clean=1
do_impair=1
dedicated=0
state_args=()
# Latency only: the user narrowed AC4 to this on 26 Nov 2026. With loss, duplication or
# reordering the join in progress diverges, over plain UDP too (bugs.md L31, L35); F4
# fixes that and puts the full spec back as the default:
#   --impair lat=30,jit=10,loss=3,dup=2,reorder=3
impair="lat=30"
join_after=10
play=30
while [ $# -gt 0 ]; do
    case "$1" in
        --clean-only) do_impair=0; shift ;;
        --impair-only) do_clean=0; shift ;;
        --runs) runs="${2:?}"; shift 2 ;;
        --dedicated) dedicated=1; do_impair=0; shift ;;
        --impair) impair="${2:?}"; shift 2 ;;
        --bin) game_bin="${2:?}"; shift 2 ;;
        --keep) T_KEEP=1; shift ;;
        --state) state_args=(-teststate "${2:?}" "${3:?}"); shift 3 ;;
        --join-after) join_after="${2:?}"; shift 2 ;;
        --play) play="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -x "$game_bin" ] || { echo "no game binary at $game_bin (scripts/build-native.sh)" >&2; exit 2; }
[ -f "$iwad" ] || { echo "no $iwad (scripts/fetch-test-data.sh)" >&2; exit 2; }
game_bin="$(cd "$(dirname "$game_bin")" && pwd)/$(basename "$game_bin")"
diff_tool="$root/tests/tools/testdump-diff.py"

faults='consistency (fault|failure)|desync|out of sync|Client repair|Report: gametic|Kick (node|player)|savegame failed|Can.t load the level|vnet: (cannot|the relay session ended|ending)'

# run_case LABEL IMPAIR(0|1) RUN
run_case() {
    local label="$1" imp="$2" run="$3"
    local before_fail=$t_fail case_start=$SECONDS
    local relay_addr code i seed p who
    t_note "$label"
    t_start_relay
    relay_addr="127.0.0.1:$relay_port"
    seed=$((run * 10))

    local srv_args=(-relay "$relay_addr" -server 2 -warp 1 1)
    [ "$dedicated" = 1 ] && srv_args=(-relay "$relay_addr" -dedicated -server 2)

    T_ENV=""; [ "$imp" = 1 ] && T_ENV="VNET_IMPAIR=$impair,seed=$((seed + 1))"
    t_game "$label-s" "${srv_args[@]}" -testdump "$t_tmp/$label-s/s.bin" "${state_args[@]}"
    local spid=$game_pid sdir="$game_dir"
    if ! t_wait_for "$sdir/out.txt" 'vnet: room code [A-Z0-9]{6} ' 30; then
        t_bad "the server printed a room code within 30 s"; tail -5 "$sdir/out.txt"; return
    fi
    code="$(sed -n 's/.*vnet: room code \([A-Z0-9]\{6\}\) .*/\1/p' "$sdir/out.txt" | head -1)"
    echo "  room $code on relay $relay_addr"

    T_ENV=""; [ "$imp" = 1 ] && T_ENV="VNET_IMPAIR=$impair,seed=$((seed + 2))"
    t_game "$label-a" -relay "$relay_addr" -connect "$code" -testdump "$t_tmp/$label-a/a.bin" "${state_args[@]}"
    local apid=$game_pid adir="$game_dir"

    # the game starts when A has joined; let it play, then B joins in progress
    # (a dedicated server starts its tics when both have joined: B follows A at once)
    local need=$((join_after * 35)) join_tic=0
    if [ "$dedicated" = 1 ]; then
        sleep 2
    else
        for i in $(seq 1 90); do
            [ "$(t_tics "$sdir/s.bin")" -gt "$need" ] && [ "$(t_tics "$adir/a.bin")" -gt 35 ] && break
            kill -0 "$spid" 2>/dev/null && kill -0 "$apid" 2>/dev/null || break
            sleep 1
        done
        if ! kill -0 "$spid" 2>/dev/null || ! kill -0 "$apid" 2>/dev/null; then
            t_bad "the server and A were running when B was due"; tail -5 "$sdir/out.txt" "$adir/out.txt"; return
        fi
        join_tic="$(t_tics "$sdir/s.bin")"
        echo "  B joins at server tic about $join_tic"
    fi

    T_ENV=""; [ "$imp" = 1 ] && T_ENV="VNET_IMPAIR=$impair,seed=$((seed + 3))"
    t_game "$label-b" -relay "$relay_addr" -connect "$code" -testdump "$t_tmp/$label-b/b.bin" "${state_args[@]}"
    local bpid=$game_pid bdir="$game_dir"

    local bneed=$((play * 35)) limit=$((play + 90))
    for i in $(seq 1 "$limit"); do
        [ "$(t_tics "$bdir/b.bin")" -ge "$bneed" ] && break
        kill -0 "$bpid" 2>/dev/null && kill -0 "$spid" 2>/dev/null && kill -0 "$apid" 2>/dev/null || break
        sleep 1
    done
    sleep 1
    local salive=0 aalive=0 balive=0
    kill -0 "$spid" 2>/dev/null && salive=1
    kill -0 "$apid" 2>/dev/null && aalive=1
    kill -0 "$bpid" 2>/dev/null && balive=1
    # leave the room: TERM makes each game print its counters and leave
    for p in "$bpid" "$apid"; do kill -TERM "$p" 2>/dev/null; done
    [ "$dedicated" = 1 ] || kill -TERM "$spid" 2>/dev/null
    for i in $(seq 1 100); do
        kill -0 "$bpid" 2>/dev/null || kill -0 "$apid" 2>/dev/null || { [ "$dedicated" = 1 ] || kill -0 "$spid" 2>/dev/null; } || break
        sleep 0.1
    done
    t_stop_pid "$bpid"; t_stop_pid "$apid"
    if [ "$dedicated" = 1 ]; then kill -KILL "$spid" 2>/dev/null; wait "$spid" 2>/dev/null; else t_stop_pid "$spid"; fi
    t_stop_pid "$relay_pid"

    local sn an bn
    sn="$(t_tics "$sdir/s.bin")"; an="$(t_tics "$adir/a.bin")"; bn="$(t_tics "$bdir/b.bin")"
    echo "  records: server $sn, A $an, B $bn"
    t_check "the server, A and B were all still running at the end" test $((salive + aalive + balive)) -eq 3
    t_check "all three logged the same room code $code" \
        test "$(grep -l "vnet: \(room code\|joined room\) $code " "$sdir/out.txt" "$adir/out.txt" "$bdir/out.txt" | wc -l)" -eq 3
    if [ "$dedicated" = 0 ]; then
    local bfirst; bfirst="$(python3 -I "$diff_tool" --info "$bdir/b.bin" 2>/dev/null | sed -n 's/.*tics \([0-9][0-9]*\)\.\..*/\1/p' | head -1)"
    t_check "B joined in progress (its first record, tic ${bfirst:-none}, is after tic 100)" test "${bfirst:-0}" -gt 100
    fi
    t_check "B has at least $play s of game time after the join ($bn >= $bneed)" test "$bn" -ge "$bneed"
    local res rc
    for who in a b; do
        local wdir="$t_tmp/$label-$who"
        if [ "$dedicated" = 1 ]; then
            # a dedicated server is in another game state than the players, which the first
            # word ("total") includes: compare the random state, players, mobjs, world and specials
            res="$(python3 -I - "$sdir/s.bin" "$wdir/$who.bin" <<'PY'
import struct, sys
def recs(p):
    d = open(p, 'rb').read()
    return {x[0]: x for x in (struct.unpack_from('<7I', d, i) for i in range(0, len(d) - 27, 28))}
a, b = recs(sys.argv[1]), recs(sys.argv[2])
common = sorted(set(a) & set(b))
bad = [t for t in common if a[t][2:] != b[t][2:]]
if bad or not common:
    print("first difference at tic %s (of %d common)" % (bad[0] if bad else "-", len(common))); sys.exit(1)
print("identical (without the game state word): %d records, tics %d..%d" % (len(common), common[0], common[-1]))
PY
)"; rc=$?
        else
            res="$(python3 -I "$diff_tool" --common "$sdir/s.bin" "$wdir/$who.bin")"; rc=$?
        fi
        echo "  compare server and $who: $res"
        t_check "server and ${who^^}: every tic both files have is identical" test "$rc" -eq 0
    done
    if [ "$dedicated" = 1 ]; then
        res="$(python3 -I "$diff_tool" --common "$adir/a.bin" "$bdir/b.bin")"; rc=$?
        echo "  compare A and B: $res"
        t_check "A and B: every tic both files have is identical (whole record)" test "$rc" -eq 0
    fi
    # the game was not idle: P_Random moving, the world changing
    local act
    act="$(python3 -I - "$bdir/b.bin" <<'PY'
import struct, sys
d = open(sys.argv[1], 'rb').read()
r = [struct.unpack_from('<7I', d, i) for i in range(0, len(d), 28)]
print(len(set(x[2] for x in r)), len(set(x[5] for x in r)))
PY
)"
    set -- $act
    if [ "$dedicated" = 0 ]; then
    t_check "the game was not idle (B's file: $1 distinct P_Random states, $2 world states)" \
        test "${1:-0}" -ge 20 -a "${2:-0}" -ge 3
    else
    local recv
    for who in a b; do
        recv="$(sed -n 's/.*vnet: closed.*received \([0-9]*\);.*/\1/p' "$t_tmp/$label-$who/out.txt" | tail -1)"
        t_check "${who^^} exchanged tics with the dedicated server through the relay (${recv:-0} datagrams received)" test "${recv:-0}" -ge 500
    done
    fi
    if grep -qiE "$faults" "$sdir/out.txt" "$adir/out.txt" "$bdir/out.txt"; then
        t_bad "no consistency fault, repair, kick or vnet failure in any log"
        grep -iE "$faults" "$sdir/out.txt" "$adir/out.txt" "$bdir/out.txt" | head -5
    else
        t_ok "no consistency fault, repair, kick or vnet failure in any log"
    fi
    local newsites
    newsites="$(python3 -I "$root/tests/tools/sanitizer-sites.py" --unknown "$root/tests/asan-known.txt" \
        "$sdir/out.txt" "$adir/out.txt" "$bdir/out.txt")"
    [ -z "$newsites" ] || { t_bad "no sanitizer report from a site that is not in tests/asan-known.txt"; printf '%s\n' "$newsites" | head -5; }

    if [ "$imp" = 1 ]; then
        # the counters each process printed when it left: lost, duplicated, reordered
        local lost=0 dup=0 reo=0 line f
        for f in "$sdir/out.txt" "$adir/out.txt" "$bdir/out.txt"; do
            line="$(grep 'vnet: closed' "$f" | tail -1)"
            lost=$((lost + $(printf '%s' "$line" | sed -n 's/.*impairment lost \([0-9]*\).*/\1/p' | sed 's/^$/0/')))
            dup=$((dup + $(printf '%s' "$line" | sed -n 's/.*duplicated \([0-9]*\).*/\1/p' | sed 's/^$/0/')))
            reo=$((reo + $(printf '%s' "$line" | sed -n 's/.*reordered \([0-9]*\).*/\1/p' | sed 's/^$/0/')))
        done
        echo "  impairment applied ($impair): $lost lost, $dup duplicated, $reo reordered (all processes together)"
        # vnet itself must have taken the spec from VNET_IMPAIR on every process: it says so
        # in its own log line (i_vnet.c passes it on), the only sign a latency-only spec
        # leaves (the game's own echo of getenv would not show an ignored variable)
        local named=0
        for f in "$sdir/out.txt" "$adir/out.txt" "$bdir/out.txt"; do
            grep -qF "vnet: impairment from VNET_IMPAIR=\"$impair,seed=" "$f" && named=$((named + 1))
        done
        t_check "vnet took the impairment from VNET_IMPAIR on every process ($named of 3)" test "$named" -eq 3
        # every kind the spec names must show in the counters
        [[ "$impair" == *loss=* ]] && t_check "impairment was applied: datagrams were lost ($lost)" test "$lost" -gt 0
        [[ "$impair" == *dup=* ]] && t_check "impairment was applied: datagrams were duplicated ($dup)" test "$dup" -gt 0
        [[ "$impair" == *reorder=* ]] && t_check "impairment was applied: datagrams were reordered ($reo)" test "$reo" -gt 0
    fi
    if [ "$t_fail" -eq "$before_fail" ]; then echo "  case $label: PASS ($((SECONDS - case_start)) s)"; else echo "  case $label: FAIL"; fi
    if [ -z "${T_KEEP:-}" ]; then
        rm -rf "${t_tmp:?}/${label:?}-s" "${t_tmp:?}/${label:?}-a" "${t_tmp:?}/${label:?}-b"
    fi
}

for r in $(seq 1 "$runs"); do
    if [ "$dedicated" = 1 ]; then
        run_case "dedicated-$r" 0 "$r"
        continue
    fi
    [ "$do_clean" = 1 ] && run_case "clean-$r" 0 "$r"
    [ "$do_impair" = 1 ] && run_case "impaired-$r" 1 "$r"
done
t_result
