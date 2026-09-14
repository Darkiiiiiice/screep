#!/usr/bin/env bash
# Install the local Screeps engine for real-physics integration testing.
#
# This is TOOLING, kept deliberately through the 2026-09-11 wipe: the engine runs
# the actual game physics locally at ~238 ms/tick against ~4000 ms online (~17x),
# and v1's real bugs (pathing stalls, sites sealing the spawn, wrong move ratios)
# were invisible to every other verification layer. The v1 test harness that used
# it was removed with the implementation; whatever harness the redesign writes
# should read the bundle from dist/main.js and drive this engine.
#
# Why this exists, and why it is separate from the project's toolchain:
#
#   The engine's driver links `isolated-vm` and a Nan-based native addon. Neither
#   compiles against the toolchain this project otherwise uses:
#
#     Node 26 + GCC 16  -> isolated-vm fails; V8 13.6 changed
#                          `GetAlignedPointerFromInternalField`, and the pure
#                          Nan module cannot build at all.
#     Node 24 + GCC 16  -> isolated-vm fails on its own timer template.
#     Node 24 + GCC 15  -> WORKS. This is the combination.
#
#   So the engine lives under .engine/ with its own Node 24 and its own compiler,
#   while the project itself stays on Node 26. Two runtimes in one repo is the
#   price of being able to run game physics locally instead of discovering every
#   movement bug against the live server at 4 seconds per tick.
#
# Usage: bash scripts/engine-setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$ROOT/.engine"
NODE_VERSION="v24.21.0"
# The recorded reports were produced on linux-x64; darwin-arm64 is supported for
# local verification via the official Node dist + clang (isolated-vm ships
# prebuilds, only @screeps/driver's Nan addon needs node-gyp).
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64) NODE_DIST="linux-x64"; DEFAULT_CC="gcc-15"; DEFAULT_CXX="g++-15";;
  Darwin-arm64) NODE_DIST="darwin-arm64"; DEFAULT_CC="clang"; DEFAULT_CXX="clang++";;
  *) echo "[engine] ERROR: unsupported platform $OS-$ARCH" >&2; exit 1;;
esac
NODE_DIR="$HOME/.cache/screeps-node24/node-$NODE_VERSION-$NODE_DIST"
NODE_BIN="$NODE_DIR/bin/node"
GCC="${GCC_BIN:-$DEFAULT_CXX}"

echo "[engine] project root: $ROOT"

# --- 1. Node 24 -----------------------------------------------------------
if [ ! -x "$NODE_BIN" ]; then
  echo "[engine] downloading Node $NODE_VERSION ($NODE_DIST)"
  mkdir -p "$(dirname "$NODE_DIR")"
  curl -sL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$NODE_DIST.tar.xz" -o /tmp/node24.tar.xz
  tar xf /tmp/node24.tar.xz -C "$(dirname "$NODE_DIR")"
fi
echo "[engine] node: $("$NODE_BIN" -v) (required: abi $( "$NODE_BIN" -p process.versions.modules ))"

# --- 2. Compiler ----------------------------------------------------------
if ! command -v "$GCC" >/dev/null 2>&1; then
  echo "[engine] ERROR: $GCC not found." >&2
  echo "[engine] linux needs GCC 15 (GCC16 breaks isolated-vm); darwin uses clang." >&2
  exit 1
fi
echo "[engine] compiler: $($GCC --version | head -1)"

# --- 3. Engine dependencies ----------------------------------------------
mkdir -p "$ENGINE_DIR"
cd "$ENGINE_DIR"
# isolated-vm 6.2.0 ships prebuilt darwin-arm64/linux-x64/arm64 binaries (abi137
# covers Node 24), so only @screeps/driver's Nan addon compiles. npm overrides
# replace the driver's git pin; keep the pin repaired even if package.json exists.
[ -f package.json ] || cat > package.json <<'JSON'
{
  "name": "screep-engine",
  "private": true,
  "description": "Local Screeps engine for integration testing. Node 24 + platform compiler.",
  "dependencies": { "screeps-server-mockup": "^1.5.1" },
  "overrides": { "isolated-vm": "6.2.0" }
}
JSON
python3 - "$ENGINE_DIR/package.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
if data.get('overrides', {}).get('isolated-vm') != '6.2.0':
    data.setdefault('overrides', {})['isolated-vm'] = '6.2.0'
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    print('[engine] pinned isolated-vm to 6.2.0 (prebuilt binaries, no compile)')
PY

export PATH="$NODE_DIR/bin:$PATH"
export CC="${CC_BIN:-$DEFAULT_CC}" CXX="$GCC"
# isolated-vm's platform_delegate.h uses std::terminate without including
# <exception>; libstdc++ tolerates it, libc++ does not. Force-include the header
# in every translation unit: no source patch needed, harmless on Linux.
export CXXFLAGS="${CXXFLAGS:-} -include exception"

if [ ! -d node_modules ]; then
  echo "[engine] installing screeps-server-mockup (native build, several minutes)"
  # npm 12 blocks git dependencies by default; the driver pins isolated-vm to a
  # git commit. npm 12 also blocks install scripts, which is where the native
  # builds happen -- both allowances are required here.
  npm install --allow-git=all --no-audit --no-fund
fi

# Approve the blocked install scripts, in dependency order.
for pkg in isolated-vm @screeps/driver screeps; do
  npm install-scripts approve "$pkg" >/dev/null 2>&1 || true
done

# The driver's own Nan addon is not covered by its install script on this
# toolchain, so build it explicitly.
if [ ! -f node_modules/@screeps/driver/native/build/Release/native.node ]; then
  echo "[engine] building @screeps/driver native addon"
  (cd node_modules/@screeps/driver && node-gyp rebuild -C native --release)
fi

# --- 4. Verify ------------------------------------------------------------
echo "[engine] verifying"
"$NODE_BIN" -e "
const { ScreepsServer, TerrainMatrix } = require('screeps-server-mockup');
console.log('[engine] loaded: ScreepsServer, TerrainMatrix');
" 

echo "[engine] ready. The engine installs into .engine/ (independent Node 24 + $DEFAULT_CXX, $OS-$ARCH)."
