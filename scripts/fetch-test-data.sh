#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Download and verify the test IWADs: Freedoom 0.13.0 (BSD-3-Clause, freely
# redistributable), and extract their demo lumps for headless runs.
#
#   scripts/fetch-test-data.sh                       # into testdata/
#   scripts/fetch-test-data.sh --dest DIR
#   scripts/fetch-test-data.sh --from-zip FILE.zip   # use a local freedoom-0.13.0.zip
#
# Writes DEST/freedoom1.wad (Ultimate Doom replacement), DEST/freedoom2.wad
# (Doom II replacement) and DEST/demos/fd{1,2}demo{1..4}.lmp. Doom Legacy's
# -playdemo takes only external files, so the demo lumps are copied out. The names
# are short on purpose: the game first looks the name up as a lump (its first 8
# characters), so "freedoom1-demo1.lmp" would load the FREEDOOM lump instead, and
# it truncates demo names longer than 32 bytes.
# testdata/ is git-ignored. A second run with valid files present downloads
# nothing. Every file is checked against the SHA-256 below; on any mismatch the
# script exits non-zero and leaves no unverified file at the destination.
#
# The checksums were recorded from the GitHub release download on 2026-11-19
# (trust on first use; the release has no published checksum file).
#
# DOOM1.WAD (shareware 1.9) is not fetched: the id installer (doom19s.zip) is a
# PKLITE-packed self-extractor. Put your own copy in DEST if you want it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip"
ZIP_SHA256="3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59"
WADS="
freedoom1.wad|7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d
freedoom2.wad|a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b
"

dest="$root/testdata"
from_zip=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dest) dest="${2:?--dest needs a directory}"; shift 2 ;;
        --from-zip) from_zip="${2:?--from-zip needs a file}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

for tool in unzip python3 sha256sum mktemp; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 1; }
done
[ -n "$from_zip" ] || command -v curl >/dev/null 2>&1 || { echo "missing tool: curl" >&2; exit 1; }

sha_ok() { [ -f "$1" ] && [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ]; }

mkdir -p "$dest/demos"
rm -rf "$dest"/.fetch.*

# Demo lumps are derived from verified WADs, so a valid WAD with its demos is "done".
need=0
while IFS='|' read -r wad sum; do
    [ -n "$wad" ] || continue
    if ! sha_ok "$dest/$wad" "$sum"; then
        rm -f "$dest/$wad"
        need=1
    fi
done <<< "$WADS"

if [ "$need" = 1 ]; then
    tmp="$(mktemp -d "$dest/.fetch.XXXXXX")"
    trap 'rm -rf "$tmp"' EXIT
    if [ -n "$from_zip" ]; then
        cp "$from_zip" "$tmp/fd.zip"
    else
        echo "downloading $URL"
        curl -fsSL --retry 3 -o "$tmp/fd.zip" "$URL"
    fi
    if ! sha_ok "$tmp/fd.zip" "$ZIP_SHA256"; then
        echo "SHA-256 of the Freedoom zip does not match (corrupt or truncated download?)" >&2
        exit 1
    fi
    unzip -q -j "$tmp/fd.zip" 'freedoom-0.13.0/freedoom1.wad' 'freedoom-0.13.0/freedoom2.wad' 'freedoom-0.13.0/COPYING.txt' -d "$tmp/x"
    while IFS='|' read -r wad sum; do
        [ -n "$wad" ] || continue
        if ! sha_ok "$tmp/x/$wad" "$sum"; then
            echo "SHA-256 of $wad does not match" >&2
            exit 1
        fi
    done <<< "$WADS"
    while IFS='|' read -r wad sum; do
        [ -n "$wad" ] || continue
        mv "$tmp/x/$wad" "$dest/$wad"
        echo "verified $dest/$wad"
    done <<< "$WADS"
    mv "$tmp/x/COPYING.txt" "$dest/freedoom-COPYING.txt"
else
    echo "Freedoom WADs already present and verified in $dest"
fi

for n in 1 2; do
    for d in 1 2 3 4; do
        out="$dest/demos/fd${n}demo$d.lmp"
        [ -s "$out" ] && continue
        python3 -I "$root/scripts/wadlump.py" extract "$dest/freedoom$n.wad" "DEMO$d" "$out.tmp"
        mv "$out.tmp" "$out"
    done
done
echo "demo lumps in $dest/demos"
