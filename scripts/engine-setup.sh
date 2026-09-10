#!/usr/bin/env bash
# Install the local Screeps engine used by `npm run sim`.
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
NODE_DIR="$HOME/.cache/screeps-node24/node-$NODE_VERSION-linux-x64"
NODE_BIN="$NODE_DIR/bin/node"
GCC="${GCC_BIN:-g++-15}"

echo "[engine] project root: $ROOT"

# --- 1. Node 24 -----------------------------------------------------------
if [ ! -x "$NODE_BIN" ]; then
  echo "[engine] downloading Node $NODE_VERSION"
  mkdir -p "$(dirname "$NODE_DIR")"
  curl -sL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node24.tar.xz
  tar xf /tmp/node24.tar.xz -C "$(dirname "$NODE_DIR")"
fi
echo "[engine] node: $("$NODE_BIN" -v) (required: abi $( "$NODE_BIN" -p process.versions.modules ))"

# --- 2. Compiler ----------------------------------------------------------
if ! command -v "$GCC" >/dev/null 2>&1; then
  echo "[engine] ERROR: $GCC not found." >&2
  echo "[engine] GCC 16 fails to build isolated-vm; install gcc15 (e.g. Arch's gcc15, or use a container)." >&2
  exit 1
fi
echo "[engine] compiler: $($GCC --version | head -1)"

# --- 3. Engine dependencies ----------------------------------------------
mkdir -p "$ENGINE_DIR"
cd "$ENGINE_DIR"
[ -f package.json ] || cat > package.json <<'JSON'
{
  "name": "screep-engine",
  "private": true,
  "description": "Local Screeps engine for integration testing. Node 24 + GCC 15 only.",
  "dependencies": { "screeps-server-mockup": "^1.5.1" }
}
JSON

export PATH="$NODE_DIR/bin:$PATH"
export CC="${CC_BIN:-gcc-15}" CXX="$GCC"

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

echo "[engine] ready. Run: npm run sim"
