#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install the native build dependencies of doomlegacy-browser.
#
#   scripts/setup.sh
#
# Supports apt (Debian, Ubuntu) and pacman (Arch). Non-interactive and idempotent:
# packages that are already installed are skipped. Uses sudo when not root.
# Installs: C compiler and make, pkg-config, git, curl, unzip, Python 3, SDL2,
# SDL2_mixer, zlib, libzip, and the OpenGL/GLU headers (the default native build
# includes the optional OpenGL renderer, HWRENDER).
# Arch ships SDL2 as sdl2-compat, which provides "sdl2"; if pacman objects, use
# sdl2-compat.
# Go is only checked: the vnet relay needs the version in ext/vnet/relay/go.mod.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for arg in "$@"; do
    case "$arg" in
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
    esac
done

SUDO=""
if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || { echo "not root and no sudo: run as root" >&2; exit 1; }
    SUDO="sudo"
fi

if command -v apt-get >/dev/null 2>&1; then
    pkgs="build-essential pkg-config git curl ca-certificates unzip python3 libsdl2-dev libsdl2-mixer-dev zlib1g-dev libzip-dev libgl1-mesa-dev libglu1-mesa-dev"
    export DEBIAN_FRONTEND=noninteractive
    $SUDO apt-get update -qq
    # shellcheck disable=SC2086
    $SUDO apt-get install -y -qq --no-install-recommends $pkgs
elif command -v pacman >/dev/null 2>&1; then
    pkgs="base-devel pkgconf git curl ca-certificates unzip python sdl2 sdl2_mixer zlib libzip mesa glu"
    # shellcheck disable=SC2086
    $SUDO pacman -S --needed --noconfirm $pkgs
else
    echo "neither apt-get nor pacman found: install a C compiler, make, pkg-config, SDL2, SDL2_mixer, zlib, libzip, OpenGL/GLU headers, curl, unzip and Python 3 by hand" >&2
    exit 1
fi

# Go is optional (only the vnet relay needs it).
need="$(sed -n 's/^go \([0-9.]*\).*/\1/p' "$root/ext/vnet/relay/go.mod" 2>/dev/null | head -1 || true)"
if command -v go >/dev/null 2>&1; then
    have="$(go env GOVERSION | sed 's/^go//')"
    echo "Go $have found (the vnet relay needs ${need:-unknown} or newer)"
    if [ -n "$need" ] && [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
        echo "warning: Go $have is older than the relay's $need" >&2
    fi
else
    echo "Go not installed (optional; the vnet relay needs ${need:-a recent} Go. Arch: pacman -S go)"
fi

echo "native build dependencies are installed"
