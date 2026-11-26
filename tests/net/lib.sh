#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Shared helpers for the vnet relay tests (source this file).
#
#   * the relay is built by scripts/build-relay.sh (once) and started on a
#     port the relay chooses itself (-udp 127.0.0.1:0, read from its LISTEN
#     line), so no fixed port is ever used and tests can run side by side;
#   * every process a test starts is recorded and stopped on exit, however the
#     test ends; t_result fails the test if any had to be killed, or if
#     anything is still running in the test's directory.
#
# A test sets nothing before sourcing; it uses $root, $t_tmp and the t_*
# functions, and ends with t_result.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
t_pids=()
t_tmp="$(mktemp -d "${TMPDIR:-/tmp}/doom-relay-test.XXXXXX")" || exit 2
t_fail=0
t_stopped=""
t_orphans=0
relay_bin="${RELAY_BIN:-$root/build/relay/vnet-relay}"

t_descendants() {   # PID: PID and everything below it
    local c
    echo "$1"
    for c in $(pgrep -P "$1" 2>/dev/null); do t_descendants "$c"; done
}

# Stop everything this test started: TERM to the recorded processes (the game
# leaves its room on TERM), wait up to 8 s, then KILL what is still alive and
# count it in t_orphans (t_result fails the test for it).
t_stop_all() {
    [ -n "$t_stopped" ] && return
    t_stopped=1
    local p i alive all=() d
    for p in "${t_pids[@]:-}"; do
        [ -n "$p" ] && all+=($(t_descendants "$p"))
    done
    for p in "${t_pids[@]:-}"; do
        [ -n "$p" ] && kill -CONT "$p" 2>/dev/null
        [ -n "$p" ] && kill -TERM "$p" 2>/dev/null
    done
    for i in $(seq 1 80); do
        alive=0
        for p in "${all[@]:-}"; do
            [ -n "$p" ] && kill -0 "$p" 2>/dev/null && alive=1
        done
        [ "$alive" = 0 ] && break
        sleep 0.1
    done
    for p in "${all[@]:-}"; do
        if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
            echo "orphan: process $p ($(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-80)) outlived its test" >&2
            t_orphans=$((t_orphans + 1))
            kill -KILL "$p" 2>/dev/null
        fi
    done
    # anything running in one of our work directories that we never saw
    for d in /proc/[0-9]*; do
        p="${d#/proc/}"
        case "$(readlink "$d/cwd" 2>/dev/null)" in
            "$t_tmp"/*|"$t_tmp")
                echo "orphan: process $p ($(tr '\0' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-80)) runs in the test directory" >&2
                t_orphans=$((t_orphans + 1)); kill -KILL "$p" 2>/dev/null ;;
        esac
    done
}

t_cleanup() {
    t_stop_all
    if [ -z "${T_KEEP:-}" ]; then rm -rf "${t_tmp:?}"; else echo "kept: $t_tmp" >&2; fi
}
trap t_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

t_note() { echo "== $*"; }
t_ok()   { echo "  ok   $*"; }
t_bad()  { echo "  FAIL $*"; t_fail=$((t_fail + 1)); }

# t_check DESCRIPTION COMMAND...: ok if the command succeeds
t_check() {
    local what="$1"; shift
    if "$@"; then t_ok "$what"; else t_bad "$what"; fi
}

# t_start_relay [relay flags...]: sets relay_pid and relay_port; its log is
# $t_tmp/relay-PORT.log.
t_start_relay() {
    if [ ! -x "$relay_bin" ]; then
        [ "$relay_bin" = "$root/build/relay/vnet-relay" ] && "$root/scripts/build-relay.sh" >&2
    fi
    [ -x "$relay_bin" ] || { echo "no relay at $relay_bin (scripts/build-relay.sh)" >&2; exit 2; }
    local log="$t_tmp/relay-$$-$RANDOM.log" i
    "$relay_bin" -udp 127.0.0.1:0 -http "" -v "$@" > "$log" 2>&1 &
    relay_pid=$!
    t_pids+=("$relay_pid")
    relay_log="$log"
    for i in $(seq 1 50); do
        if grep -q '^LISTEN' "$log" 2>/dev/null; then
            relay_port="$(sed -n 's/^LISTEN udp=[^ ]*:\([0-9][0-9]*\) .*/\1/p' "$log" | head -1)"
            [ -n "$relay_port" ] && return 0
        fi
        kill -0 "$relay_pid" 2>/dev/null || break
        sleep 0.1
    done
    echo "the relay did not start:" >&2; cat "$log" >&2
    exit 2
}

# t_stop_pid PID: stop one recorded process now (TERM, then KILL after 5 s)
t_stop_pid() {
    local pid="$1" i
    kill -CONT "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null
    for i in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null
        echo "orphan: process $pid had to be killed" >&2
        t_orphans=$((t_orphans + 1))
    fi
    wait "$pid" 2>/dev/null
}

# t_wait_for FILE REGEX SECONDS: 0 when REGEX appears in FILE
t_wait_for() {
    local f="$1" re="$2" secs="$3" i
    for i in $(seq 1 $((secs * 10))); do
        grep -Eq -- "$re" "$f" 2>/dev/null && return 0
        sleep 0.1
    done
    return 1
}

# t_wait_pid PID SECONDS: wait for a child of this shell to end. Sets t_status
# to its exit status, or 999 if it did not end in time (it is then killed).
t_wait_pid() {
    local pid="$1" secs="$2" i
    for i in $(seq 1 $((secs * 10))); do
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" 2>/dev/null; t_status=$?
            return 0
        fi
        sleep 0.1
    done
    kill -TERM "$pid" 2>/dev/null; sleep 0.5; kill -KILL "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    t_status=999
    return 1
}

# t_game NAME GAMEARGS...: start a headless game in $t_tmp/NAME (its working
# directory and -home), output in $t_tmp/NAME/out.txt, with $T_ENV (a
# string of VAR=value words) in its environment. Sets game_pid and game_dir.
t_game() {
    local name="$1"; shift
    game_dir="$t_tmp/$name"
    mkdir -p "$game_dir"
    # a game that floods its output (a run against a build that does not know -relay did)
    # must not fill the disk: files are limited to 256 MB
    ( ulimit -f 262144; cd "$game_dir" && exec env SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
        ASAN_OPTIONS="${ASAN_OPTIONS:-halt_on_error=0:detect_leaks=0}" ${T_ENV:-} \
        "$game_bin" -home "$game_dir" -iwad "$iwad" -nosound -nomusic -noendtext -skill 3 "$@" \
        > "$game_dir/out.txt" 2>&1 ) &
    game_pid=$!
    t_pids+=("$game_pid")
}

# t_tics FILE: number of records in a -testdump file
t_tics() {
    [ -f "$1" ] && echo $(( $(stat -c %s "$1") / 28 )) || echo 0
}

t_result() {
    t_stop_all
    t_check "no process this test started had to be killed or is left running" test "$t_orphans" -eq 0
    if [ "$t_fail" -eq 0 ]; then echo "PASS"; exit 0; fi
    echo "FAILED: $t_fail check(s)"; exit 1
}
