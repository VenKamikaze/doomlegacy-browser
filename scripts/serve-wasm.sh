#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Serve the browser build and the test data on http://127.0.0.1:PORT/ (default 8000), for playing.
#
#   scripts/serve-wasm.sh [PORT]
#
# Needs scripts/build-wasm.sh and scripts/fetch-test-data.sh first (Node.js only for this server).
# The page loads testdata/freedoom1.wad; ?iwad=URL picks another IWAD.
set -euo pipefail
case "${1:-}" in -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;; esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$root/tests/tools/serve.js" --port "${1:-8000}"
