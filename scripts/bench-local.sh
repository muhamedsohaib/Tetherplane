#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
cargo build -p tetherd --release
pnpm --filter @tetherplane/compact-mcp build
node scripts/bench-local.ts
