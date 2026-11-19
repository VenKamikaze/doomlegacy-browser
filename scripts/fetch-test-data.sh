#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Download and verify the test IWADs, and extract their demo lumps for headless runs:
#   - Freedoom 0.13.0 (BSD-3-Clause): freedoom1.wad, freedoom2.wad
#   - Doom shareware 1.9 (id Software, free to distribute unmodified): doom1.wad
#
#   scripts/fetch-test-data.sh                          # both sets, into testdata/
#   scripts/fetch-test-data.sh --only doom1             # or --only freedoom
#   scripts/fetch-test-data.sh --dest DIR
#   scripts/fetch-test-data.sh --freedoom-zip FILE      # a local freedoom-0.13.0.zip
#   scripts/fetch-test-data.sh --doom1-zip FILE         # a local doom1.wad.zip
#
# Writes DEST/{freedoom1,freedoom2,doom1}.wad and DEST/demos/fd{1,2}demo{1..4}.lmp,
# DEST/demos/d1demo{1..3}.lmp. Doom Legacy's -playdemo takes only external files,
# so the demo lumps are copied out. The names are short on purpose: the game first
# looks the name up as a lump (its first 8 characters), so "freedoom1-demo1.lmp"
# would load the FREEDOOM lump instead, and it truncates demo names over 32 bytes.
#
# testdata/ is git-ignored. A second run with valid files present downloads
# nothing. Every file is checked; on any mismatch the script exits non-zero and
# leaves no unverified file at the destination.
#
# Checksums:
#   - doom1.wad: MD5 f0cefca49926d00903cf57551d901abe, SHA-1
#     5b2e249b9c5133ec987b3ea77596381dc0d6bc1d and 4,196,020 bytes are the published
#     values for shareware 1.9 (doomwiki.org, DOOM1.WAD); the SHA-256 was computed
#     from a file matching them.
#   - The zips' SHA-256 and the Freedoom WADs' SHA-256 were recorded from the
#     downloads on 2026-11-19 (trust on first use; neither source publishes one).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FD_URL="https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip"
FD_ZIP_SHA256="3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59"
# member in the zip | file name in DEST | SHA-256 | MD5 (or -) | SHA-1 (or -)
FD_WADS="
freedoom-0.13.0/freedoom1.wad|freedoom1.wad|7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d|-|-
freedoom-0.13.0/freedoom2.wad|freedoom2.wad|a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b|-|-
"
FD_DEMOS="freedoom1.wad|fd1|1 2 3 4
freedoom2.wad|fd2|1 2 3 4"

D1_URL="https://www.jbserver.com/downloads/games/doom/misc/shareware/doom1.wad.zip"
D1_ZIP_SHA256="c1d1f430e623b5b02693a2ab42988f951fb66ae3bd3add06e557bdf36af0e24f"
D1_WADS="
DOOM1.WAD|doom1.wad|1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771|f0cefca49926d00903cf57551d901abe|5b2e249b9c5133ec987b3ea77596381dc0d6bc1d
"
D1_DEMOS="doom1.wad|d1|1 2 3"

dest="$root/testdata"
fd_zip=""
d1_zip=""
only=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dest) dest="${2:?--dest needs a directory}"; shift 2 ;;
        --freedoom-zip) fd_zip="${2:?--freedoom-zip needs a file}"; shift 2 ;;
        --doom1-zip) d1_zip="${2:?--doom1-zip needs a file}"; shift 2 ;;
        --only)
            only="${2:?--only needs freedoom or doom1}"; shift 2
            case "$only" in freedoom|doom1) ;; *) echo "--only takes freedoom or doom1" >&2; exit 2 ;; esac ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

for tool in unzip python3 sha256sum sha1sum md5sum mktemp curl; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 1; }
done

hash_is() { [ "$($1 "$2" | cut -d' ' -f1)" = "$3" ]; }

# wad_ok FILE SHA256 MD5 SHA1: the file exists and matches every hash given (- skips one).
wad_ok() {
    [ -f "$1" ] || return 1
    hash_is sha256sum "$1" "$2" || return 1
    [ "$3" = - ] || hash_is md5sum "$1" "$3" || return 1
    [ "$4" = - ] || hash_is sha1sum "$1" "$4" || return 1
}

mkdir -p "$dest/demos"
rm -rf "$dest"/.fetch.*
tmps=()
trap 'rm -rf "${tmps[@]}"' EXIT

# fetch_set LABEL URL ZIP_SHA256 LOCAL_ZIP WADS DEMOS
fetch_set() {
    local label="$1" url="$2" zip_sum="$3" local_zip="$4" wads="$5" demos="$6"
    local need=0 member name sum md5 sha1 tmp
    while IFS='|' read -r member name sum md5 sha1; do
        [ -n "$member" ] || continue
        if ! wad_ok "$dest/$name" "$sum" "$md5" "$sha1"; then
            rm -f "$dest/$name"
            need=1
        fi
    done <<< "$wads"

    if [ "$need" = 1 ]; then
        tmp="$(mktemp -d "$dest/.fetch.XXXXXX")"
        tmps+=("$tmp")
        if [ -n "$local_zip" ]; then
            cp "$local_zip" "$tmp/set.zip"
        else
            echo "downloading $url"
            curl -fsSL --retry 3 -o "$tmp/set.zip" "$url"
        fi
        if ! hash_is sha256sum "$tmp/set.zip" "$zip_sum"; then
            echo "SHA-256 of the $label zip does not match (corrupt or truncated download?)" >&2
            exit 1
        fi
        mkdir "$tmp/x"
        while IFS='|' read -r member name sum md5 sha1; do
            [ -n "$member" ] || continue
            unzip -q -p "$tmp/set.zip" "$member" > "$tmp/x/$name"
            if ! wad_ok "$tmp/x/$name" "$sum" "$md5" "$sha1"; then
                echo "$name from the $label zip does not match its checksums" >&2
                exit 1
            fi
        done <<< "$wads"
        while IFS='|' read -r member name sum md5 sha1; do
            [ -n "$member" ] || continue
            mv "$tmp/x/$name" "$dest/$name"
            echo "verified $dest/$name"
        done <<< "$wads"
    else
        echo "$label WADs already present and verified in $dest"
    fi

    local wad prefix nums d out
    while IFS='|' read -r wad prefix nums; do
        for d in $nums; do
            out="$dest/demos/${prefix}demo$d.lmp"
            [ -s "$out" ] && continue
            python3 -I "$root/scripts/wadlump.py" extract "$dest/$wad" "DEMO$d" "$out.tmp"
            mv "$out.tmp" "$out"
        done
    done <<< "$demos"
}

if [ "$only" != doom1 ]; then
    fetch_set Freedoom "$FD_URL" "$FD_ZIP_SHA256" "$fd_zip" "$FD_WADS" "$FD_DEMOS"
fi
if [ "$only" != freedoom ]; then
    fetch_set "Doom shareware" "$D1_URL" "$D1_ZIP_SHA256" "$d1_zip" "$D1_WADS" "$D1_DEMOS"
fi
echo "demo lumps in $dest/demos"
