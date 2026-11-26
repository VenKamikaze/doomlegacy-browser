#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Build the vnet relay (ext/vnet/relay, Go) for local tests.
#
#   scripts/build-relay.sh              # build/relay/vnet-relay
#   scripts/build-relay.sh --out FILE   # another output file
#
# Needs Go (1.24 or newer; ext/vnet/relay/go.mod says which). Its modules
# come from the default Go proxy on the first build. The binary is built
# outside the source tree, so ext/vnet stays clean, and is never committed
# (build/ is ignored). Prints the path of the binary on the last line.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/build/relay/vnet-relay"
while [ $# -gt 0 ]; do
    case "$1" in
        --out) out="${2:?--out needs a file}"; shift 2 ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

export PATH="$PATH:/usr/local/go/bin"
command -v go >/dev/null || { echo "go not found: install Go 1.24 or newer (see ext/vnet/relay/go.mod)" >&2; exit 2; }
[ -f "$root/ext/vnet/relay/go.mod" ] || { echo "ext/vnet is not checked out: git submodule update --init" >&2; exit 2; }
mkdir -p "$(dirname "$out")"
( cd "$root/ext/vnet/relay" && go build -o "$out" ./cmd/vnet-relay )
echo "$out"
