#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# What happens when something goes wrong with a vnet relay game (brief 01, AC5).
#
#   tests/net/test-relay-errors.sh                  # every case
#   tests/net/test-relay-errors.sh --only REGEX     # the cases whose name matches
#   tests/net/test-relay-errors.sh --list           # the case names
#   tests/net/test-relay-errors.sh --bin FILE       # another game binary (e.g. the one from before the brief)
#   tests/net/test-relay-errors.sh --keep           # keep the logs
#
# Every case has a time limit and checks the message on stdout and what the game does
# next. How a failure ends (the same for every relay failure, and what a failed
# "-connect NAME" over UDP does when NAME does not resolve: "Network address error" and back to the
# title screen): the game prints "vnet: ..." with the reason (vnet_strerror), ends the network
# game as the "exitgame" command does (the driver closes: "vnet: closed (...)") and the
# process stays at the title screen; a dedicated server exits with status 255 instead
# (I_Error). Bad arguments print the message and exit with status 255.
# Over UDP a server that never answers is waited for until the player presses Q; over the
# relay the same wait ends after 20 s ("the host did not answer").
#
# Cases (each with its own relay on a port the relay picks, started and stopped by the test):
#   args-*            bad arguments: message and exit status 255 within 15 s
#   relay-unreachable a relay address nobody listens on: a server, a joiner and a -dedicated server
#   no-such-room      a joiner with a well-formed code that is not a room
#   room-full         the relay's member limit (-max-members 2): a third member is refused
#   game-full         the game's own limit (sv_maxplayers 1): the joiner is refused by the server
#   relay-dies        the relay is killed during a game: both players leave it
#   relay-dies-dedicated  the same with a -dedicated server (it exits, status 255)
#   relay-drops       the relay drops a silent member (-session-timeout) and says so
#   host-lost         the host is killed during a game: the client's node times out ("Server Timeout"),
#                     the game goes to the title screen and the driver closes, as over UDP
#   host-silent       the room exists but its host never answers
# Exit status: 0 pass, 1 fail, 2 bad set-up.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

game_bin="$root/build/native/bin/doomlegacy"
iwad="$root/testdata/freedoom1.wad"
only=""
list=0
while [ $# -gt 0 ]; do
    case "$1" in
        --only) only="${2:?}"; shift 2 ;;
        --list) list=1; shift ;;
        --bin) game_bin="${2:?}"; shift 2 ;;
        --keep) T_KEEP=1; shift ;;
        -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done
if [ "$list" = 0 ]; then
    [ -x "$game_bin" ] || { echo "no game binary at $game_bin (scripts/build-native.sh)" >&2; exit 2; }
    [ -f "$iwad" ] || { echo "no $iwad (scripts/fetch-test-data.sh)" >&2; exit 2; }
    game_bin="$(cd "$(dirname "$game_bin")" && pwd)/$(basename "$game_bin")"
fi

want() { [ -z "$only" ] || [[ "$1" =~ $only ]]; }
has() { grep -qE -- "$2" "$1/out.txt" 2>/dev/null; }   # has DIR REGEX
alive() { kill -0 "$1" 2>/dev/null; }
# title_screen FILE PID: the game is running its main loop again after leaving the network game:
# its -testdump file grows over 2 s (a game stuck in the connect screen writes nothing)
title_screen() {
    local a b
    a="$(t_tics "$1")"; sleep 2; b="$(t_tics "$1")"
    kill -0 "$2" 2>/dev/null && [ "$b" -gt "$a" ]
}

# wait_for DIR REGEX SECONDS: the message appears in the game's output within the time
wait_msg() { t_wait_for "$1/out.txt" "$2" "$3"; }

# started_room NAME RELAY [game args]: start a server, wait for its room code (sets code, srv_pid, srv_dir)
started_room() {
    local name="$1" relay="$2"; shift 2
    t_game "$name" -relay "$relay" "$@"
    srv_pid=$game_pid; srv_dir="$game_dir"
    if ! wait_msg "$srv_dir" 'vnet: room code [A-Z0-9]{6} ' 30; then
        t_bad "$name: the server printed a room code within 30 s"; tail -3 "$srv_dir/out.txt"; code=""; return 1
    fi
    code="$(sed -n 's/.*vnet: room code \([A-Z0-9]\{6\}\) .*/\1/p' "$srv_dir/out.txt" | head -1)"
}

# ---------------------------------------------------------------------------
# bad arguments

arg_cases() {
    local names=() pids=() dirs=() starts=() res i
    local relay="127.0.0.1:9"
    arg_case() {   # arg_case NAME REGEX args...
        local name="$1" re="$2"; shift 2
        want "args-$name" || return
        t_game "args-$name" "$@"
        names+=("$name:$re"); pids+=("$game_pid"); dirs+=("$game_dir"); starts+=("$SECONDS")
    }
    arg_case relay-no-value      '-relay needs HOST:PORT'                   -relay -server 1
    arg_case relay-no-port       'expected HOST:PORT'                       -relay localhost -server 1
    arg_case relay-url           'URL is for the browser build'             -relay ws://127.0.0.1:1/vnet -server 1
    arg_case relay-unresolvable  'cannot resolve relay host'                -relay no.such.host.invalid:7777 -server 1
    arg_case connect-no-code     '-connect needs a room code'               -relay "$relay" -connect
    arg_case connect-bad-code    "'ABC23I' is not a room code"              -relay "$relay" -connect ABC23I
    arg_case connect-lan-address "'127.0.0.1' is not a room code"           -relay "$relay" -connect 127.0.0.1
    arg_case udpport-no-value    'syntax : -udpport'                        -relay "$relay" -server 1 -udpport
    for i in "${!pids[@]}"; do
        local name="${names[$i]%%:*}" re="${names[$i]#*:}"
        t_wait_pid "${pids[$i]}" 20
        local st=$t_status took=$((SECONDS - starts[i]))
        t_check "args-$name: exits with status 255 (got $st) and says '$re' on stdout" \
            bash -c '[ "$1" = 255 ] && grep -qE -- "$2" "$3/out.txt"' _ "$st" "vnet: .*$re" "${dirs[$i]}"
        t_check "args-$name: within 15 s ($took s)" test "$took" -le 15
    done
}

# ---------------------------------------------------------------------------

unreachable_case() {
    t_note "relay-unreachable: a relay address with nothing behind it"
    t_start_relay; local dead="127.0.0.1:$relay_port"
    t_stop_pid "$relay_pid"
    local t0=$SECONDS
    t_game ru-server -relay "$dead" -server 1 -warp 1 1 -testdump "$t_tmp/ru-server/s.bin"; local sp=$game_pid sd="$game_dir"
    t_game ru-client -relay "$dead" -connect ABC234 -testdump "$t_tmp/ru-client/c.bin"; local cp=$game_pid cd="$game_dir"
    t_game ru-dedicated -relay "$dead" -dedicated;                  local dp=$game_pid dd="$game_dir"
    wait_msg "$sd" 'vnet: closed' 25;  local ts=$((SECONDS - t0))
    wait_msg "$cd" 'vnet: closed' 25;  local tc=$((SECONDS - t0))
    t_wait_pid "$dp" 30;               local dst=$t_status td=$((SECONDS - t0))
    t_check "server: says the relay did not answer ($ts s)" has "$sd" 'vnet: cannot create a room on relay .*did not answer'
    t_check "server: ended the network game, still running at the title screen, within 20 s" \
        bash -c 'grep -q "vnet: ending the network game" "$1/out.txt" && grep -q "vnet: closed" "$1/out.txt" && kill -0 "$2" && [ "$3" -le 20 ]' _ "$sd" "$sp" "$ts"
    t_check "joiner: says the relay did not answer ($tc s)" has "$cd" 'vnet: cannot join room ABC234 on relay .*did not answer'
    t_check "joiner: ended the network game, still running at the title screen, within 20 s" \
        bash -c 'grep -q "vnet: ending the network game" "$1/out.txt" && grep -q "vnet: closed" "$1/out.txt" && kill -0 "$2" && [ "$3" -le 20 ]' _ "$cd" "$cp" "$tc"
    t_check "server: back at the title screen (its tics go on)" title_screen "$sd/s.bin" "$sp"
    t_check "joiner: back at the title screen (its tics go on)" title_screen "$cd/c.bin" "$cp"
    t_check "dedicated: exits with status 255 (got $dst) after saying so, within 25 s ($td s)" \
        bash -c '[ "$1" = 255 ] && grep -q "a dedicated server cannot run without its room" "$2/out.txt" && [ "$3" -le 25 ]' _ "$dst" "$dd" "$td"
}

no_such_room_case() {
    t_note "no-such-room: a well-formed code that is not a room"
    t_start_relay; local R="127.0.0.1:$relay_port" t0=$SECONDS
    t_game nsr -relay "$R" -connect ZZZZZZ -testdump "$t_tmp/nsr/c.bin"; local p=$game_pid d="$game_dir"
    wait_msg "$d" 'vnet: closed' 15; local took=$((SECONDS - t0))
    t_check "joiner: 'no such room' on stdout" has "$d" 'vnet: cannot join room ZZZZZZ on relay .*: no such room'
    t_check "joiner: ended the network game and is still running, within 10 s ($took s)" \
        bash -c 'grep -q "vnet: closed" "$1/out.txt" && kill -0 "$2" && [ "$3" -le 10 ]' _ "$d" "$p" "$took"
    t_check "joiner: back at the title screen (its tics go on)" title_screen "$d/c.bin" "$p"
}

room_full_case() {
    t_note "room-full: the relay's member limit (-max-members 2)"
    t_start_relay -max-members 2; local R="127.0.0.1:$relay_port"
    started_room rf-server "$R" -server 1 -warp 1 1 -testdump "$t_tmp/rf-server/s.bin" || return
    t_game rf-a -relay "$R" -connect "$code" -testdump "$t_tmp/rf-a/a.bin"; local ap=$game_pid ad="$game_dir"
    wait_msg "$ad" 'vnet: joined room' 15
    local t0=$SECONDS
    t_game rf-c -relay "$R" -connect "$code" -testdump "$t_tmp/rf-c/c.bin"; local cp=$game_pid cd="$game_dir"
    wait_msg "$cd" 'vnet: closed' 15; local took=$((SECONDS - t0))
    t_check "the second joiner is told the room is full" has "$cd" "vnet: cannot join room $code on relay .*: room is full"
    t_check "and leaves the network game at once and keeps running, within 10 s ($took s)" \
        bash -c 'grep -q "vnet: closed" "$1/out.txt" && kill -0 "$2" && [ "$3" -le 10 ]' _ "$cd" "$cp" "$took"
    t_check "the refused joiner is back at the title screen (its tics go on)" title_screen "$cd/c.bin" "$cp"
    local n=0 i
    for i in $(seq 1 100); do n="$(t_tics "$ad/a.bin")"; [ "$n" -gt 35 ] && break; sleep 0.1; done
    t_check "the first joiner is in the room (the room takes 2 players) and playing ($n tics)" \
        bash -c 'grep -q "the room takes 2 players" "$1/out.txt" && [ "$2" -gt 35 ]' _ "$ad" "$n"
}

game_full_case() {
    t_note "game-full: the game's own limit (sv_maxplayers 1)"
    t_start_relay; local R="127.0.0.1:$relay_port"
    started_room gf-server "$R" -server 1 -warp 1 1 +sv_maxplayers 1 -testdump "$t_tmp/gf-server/s.bin" || return
    local t0=$SECONDS
    t_game gf-a -relay "$R" -connect "$code" -testdump "$t_tmp/gf-a/a.bin"; local ap=$game_pid ad="$game_dir"
    wait_msg "$ad" 'vnet: closed' 25; local took=$((SECONDS - t0))
    t_check "the joiner entered the room, was refused by the server and left the network game, within 20 s ($took s)" \
        bash -c 'grep -q "vnet: joined room" "$1/out.txt" && grep -q "vnet: closed" "$1/out.txt" && kill -0 "$2" && [ "$3" -le 20 ]' _ "$ad" "$ap" "$took"
    t_check "the refused joiner is back at the title screen (its tics go on)" title_screen "$ad/a.bin" "$ap"
    local s1 s2; s1="$(t_tics "$srv_dir/s.bin")"; sleep 3; s2="$(t_tics "$srv_dir/s.bin")"
    t_check "the refused player never got into the game (no savegame, no state from the server)" \
        bash -c '! grep -q "PT_STATE: gametic" "$1/out.txt"' _ "$ad"
    t_check "and the server kept playing (tics $s1, 3 s later $s2)" \
        bash -c 'kill -0 "$1" && [ "$3" -ge $(( $2 + 70 )) ]' _ "$srv_pid" "$s1" "$s2"
}

relay_dies_case() {
    t_note "relay-dies: the relay is killed during a game (-keepalive 1s: three intervals of silence)"
    t_start_relay -keepalive 1s; local R="127.0.0.1:$relay_port" rp=$relay_pid
    started_room rd-server "$R" -server 1 -warp 1 1 -testdump "$t_tmp/rd-server/s.bin" || return
    local sp=$srv_pid sd="$srv_dir"
    t_game rd-a -relay "$R" -connect "$code" -testdump "$t_tmp/rd-a/a.bin"; local ap=$game_pid ad="$game_dir"
    t_wait_for "$ad/out.txt" 'vnet: joined room' 15
    sleep 8
    local t0=$SECONDS
    kill -KILL "$rp"; wait "$rp" 2>/dev/null
    wait_msg "$sd" 'vnet: closed' 20; wait_msg "$ad" 'vnet: closed' 20; local took=$((SECONDS - t0))
    t_check "the host says the relay session ended and leaves the network game" \
        has "$sd" 'vnet: the relay session ended: .*relay went silent'
    t_check "the player says the same" has "$ad" 'vnet: the relay session ended: .*relay went silent'
    t_check "both keep running at the title screen, within 6 s of the relay's death ($took s)" \
        bash -c 'grep -q "vnet: ending the network game" "$1/out.txt" "$2/out.txt" && kill -0 "$3" && kill -0 "$4" && [ "$5" -le 6 ]' _ "$sd" "$ad" "$sp" "$ap" "$took"
    t_check "the host is back at the title screen (its tics go on)" title_screen "$sd/s.bin" "$sp"
    t_check "the player is back at the title screen (its tics go on)" title_screen "$ad/a.bin" "$ap"
}

relay_dies_dedicated_case() {
    t_note "relay-dies-dedicated: the relay is killed while a -dedicated server has a player"
    t_start_relay -keepalive 1s; local R="127.0.0.1:$relay_port" rp=$relay_pid
    started_room rdd-server "$R" -dedicated -server 2 || return
    local sp=$srv_pid sd="$srv_dir"
    t_game rdd-a -relay "$R" -connect "$code" -testdump "$t_tmp/rdd-a/a.bin"; local ap=$game_pid ad="$game_dir"
    t_wait_for "$ad/out.txt" 'vnet: joined room' 15
    sleep 8
    local t0=$SECONDS
    kill -KILL "$rp"; wait "$rp" 2>/dev/null
    wait_msg "$sd" 'vnet: closed' 20; local took=$((SECONDS - t0))
    t_wait_pid "$sp" 20; local st=$t_status
    # (I_Error itself sleeps 3 s before it exits, upstream: the bound is on the driver closing)
    t_check "the dedicated server says the relay session ended, closes the driver within 6 s of the relay's death ($took s) and exits with status 255 (got $st)" \
        bash -c '[ "$1" = 255 ] && grep -q "vnet: the relay session ended: .*relay went silent" "$2/out.txt" && grep -q "a dedicated server cannot run without its room" "$2/out.txt" && [ "$3" -le 6 ]' _ "$st" "$sd" "$took"
    wait_msg "$ad" 'vnet: closed' 10
    t_check "its player leaves the network game too and keeps running" \
        bash -c 'grep -q "vnet: closed" "$1/out.txt" && kill -0 "$2"' _ "$ad" "$ap"
    t_check "the player is back at the title screen (its tics go on)" title_screen "$ad/a.bin" "$ap"
}

relay_drops_case() {
    t_note "relay-drops: the relay drops a member that went silent (-session-timeout 4s)"
    t_start_relay -keepalive 1s -session-timeout 4s; local R="127.0.0.1:$relay_port"
    started_room rx-server "$R" -server 1 -warp 1 1 || return
    t_game rx-a -relay "$R" -connect "$code" -testdump "$t_tmp/rx-a/a.bin"; local ap=$game_pid ad="$game_dir"
    t_wait_for "$ad/out.txt" 'vnet: joined room' 15
    sleep 6
    kill -STOP "$ap"; sleep 8
    local t0=$SECONDS
    kill -CONT "$ap"
    wait_msg "$ad" 'vnet: closed' 15; local took=$((SECONDS - t0))
    t_check "after it runs again the player is told the relay ended its session" \
        has "$ad" 'vnet: the relay session ended: session closed by the relay'
    t_check "and leaves the network game and keeps running, within 2 s ($took s)" \
        bash -c 'grep -q "vnet: closed" "$1/out.txt" && kill -0 "$2" && [ "$3" -le 2 ]' _ "$ad" "$ap" "$took"
    t_check "the player is back at the title screen (its tics go on)" title_screen "$ad/a.bin" "$ap"
}

host_lost_case() {
    t_note "host-lost: the host dies during a game (as over UDP: the node times out)"
    t_start_relay; local R="127.0.0.1:$relay_port"
    started_room hl-server "$R" -server 1 -warp 1 1 || return
    local sp=$srv_pid
    t_game hl-a -relay "$R" -connect "$code" -testdump "$t_tmp/hl-a/a.bin"; local ap=$game_pid ad="$game_dir"
    t_wait_for "$ad/out.txt" 'vnet: joined room' 15
    sleep 8
    kill -KILL "$sp"; wait "$sp" 2>/dev/null
    local t0=$SECONDS
    wait_msg "$ad" 'vnet: closed' 40; local took=$((SECONDS - t0))
    sleep 2
    t_check "the client's game times the server's node out (the game's own 'Server Timeout', then the title screen: it leaves the network game, $took s after the host died)" \
        bash -c 'grep -q "vnet: closed" "$1/out.txt" && [ "$2" -ge 8 ] && [ "$2" -le 30 ]' _ "$ad" "$took"
    t_check "the player is still running at the title screen (its tics go on)" \
        bash -c 'a="$(( $(stat -c %s "$2/a.bin") / 28 ))"; sleep 2; b="$(( $(stat -c %s "$2/a.bin") / 28 ))"; kill -0 "$1" && [ "$b" -gt "$a" ]' _ "$ap" "$ad"
    t_check "no vnet failure: the relay was fine and the player never saw it fail" \
        bash -c '! grep -q "vnet: the relay session ended\|vnet: cannot" "$1/out.txt"' _ "$ad"
}

host_silent_case() {
    t_note "host-silent: the room exists but the host never answers (the host is stopped)"
    t_start_relay; local R="127.0.0.1:$relay_port"
    started_room hs-server "$R" -server 1 -warp 1 1 || return
    kill -STOP "$srv_pid"
    local t0=$SECONDS
    t_game hs-a -relay "$R" -connect "$code" -testdump "$t_tmp/hs-a/a.bin"; local ap=$game_pid ad="$game_dir"
    wait_msg "$ad" 'vnet: closed' 40; local took=$((SECONDS - t0))
    t_check "the joiner says the host did not answer" has "$ad" 'vnet: cannot join room .*: the host did not answer within 20 s'
    t_check "and leaves the network game and keeps running, within 30 s ($took s)" \
        bash -c 'grep -q "vnet: closed" "$1/out.txt" && kill -0 "$2" && [ "$3" -le 30 ]' _ "$ad" "$ap" "$took"
    t_check "the joiner is back at the title screen (its tics go on)" title_screen "$ad/a.bin" "$ap"
}

# ---------------------------------------------------------------------------

cases="args relay-unreachable no-such-room room-full game-full relay-dies relay-dies-dedicated relay-drops host-lost host-silent"
if [ "$list" = 1 ]; then echo $cases | tr ' ' '\n'; exit 0; fi
want args && { t_note "bad arguments"; arg_cases; }
want relay-unreachable && unreachable_case
want no-such-room && no_such_room_case
want room-full && room_full_case
want game-full && game_full_case
want relay-dies && relay_dies_case
want relay-dies-dedicated && relay_dies_dedicated_case
want relay-drops && relay_drops_case
want host-lost && host_lost_case
want host-silent && host_silent_case
t_result
