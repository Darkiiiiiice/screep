#!/usr/bin/env bash
# Run the local integration test under the engine's runtime.
#
# The engine needs Node 24 and GCC 15 (see scripts/engine-setup.sh); the project
# itself runs on Node 26. Rather than move the whole project, this wrapper picks
# the right interpreter for this one job.
set -euo pipefail

NODE_BIN="$HOME/.cache/screeps-node24/node-v24.21.0-linux-x64/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "[sim] Node 24 not found at $NODE_BIN" >&2
  echo "[sim] Run: bash scripts/engine-setup.sh" >&2
  exit 1
fi

exec "$NODE_BIN" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-sim.mjs" "$@"
