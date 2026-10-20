#!/usr/bin/env bash
# Create an unapproved Linux developer-preview candidate. This does not install, pair, or release.
set -euo pipefail
umask 077

usage() {
  echo 'Usage: bash scripts/package-linux.sh --output DIR [--skip-build]' >&2
  exit 2
}
output=''
skip_build=0
while (($#)); do
  case "$1" in
    --output) (($# >= 2)) || usage; output="$2"; shift 2 ;;
    --skip-build) skip_build=1; shift ;;
    *) usage ;;
  esac
done
[[ -n "$output" ]] || usage
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo 'Linux x86_64 required' >&2; exit 1;
}
for tool in node pnpm git sha256sum; do
  command -v "$tool" >/dev/null || { echo "Required tool missing: $tool" >&2; exit 1; }
done
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
out="$(realpath -m -- "$output")"
[[ "$out" != / && "$out" != "$repo" && "$out" != "$HOME" ]] || {
  echo 'Unsafe output location' >&2; exit 1;
}
[[ ! -e "$out" && ! -L "$out" ]] || {
  echo 'Output already exists; refusing to replace files' >&2; exit 1;
}
mkdir -p -- "$(dirname -- "$out")"
stage="$(mktemp -d -- "$(dirname -- "$out")/.tetherplane-linux-package.XXXXXXXX")"
cleanup() { [[ -z "${stage:-}" ]] || rm -rf -- "$stage"; }
trap cleanup EXIT

cd -- "$repo"
if (( !skip_build )); then
  command -v cargo >/dev/null || { echo 'Cargo required for a source build' >&2; exit 1; }
  cargo build --release -p tetherd
  pnpm --filter '@tetherplane/compact-mcp...' build
fi
test -x target/release/tetherd || { echo 'Linux agent binary missing' >&2; exit 1; }
test -f adapters/compact-mcp/dist/stdio-server.js || {
  echo 'Compact MCP build missing' >&2; exit 1;
}

mkdir -p -- "$stage/bin" "$stage/adapters"
cp -- target/release/tetherd "$stage/bin/tetherd"
chmod 0755 "$stage/bin/tetherd"
pnpm --config.node-linker=hoisted --filter @tetherplane/compact-mcp deploy --legacy --prod \
  "$stage/adapters/compact-mcp"
test -f "$stage/adapters/compact-mcp/dist/stdio-server.js" || {
  echo 'Deployed Compact MCP entrypoint missing' >&2; exit 1;
}
test -d "$stage/adapters/compact-mcp/node_modules" || {
  echo 'Deployed Compact MCP runtime dependencies missing' >&2; exit 1;
}
cp -- scripts/release-smoke.mjs "$stage/adapters/compact-mcp/smoke-six-tools.mjs"

commit="$(git rev-parse --verify HEAD)"
TETHERPLANE_PACKAGE_STAGE="$stage" TETHERPLANE_SOURCE_COMMIT="$commit" node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.TETHERPLANE_PACKAGE_STAGE;
const files = ['bin/tetherd', 'adapters/compact-mcp/dist/stdio-server.js',
  'adapters/compact-mcp/smoke-six-tools.mjs'];
const sha256 = Object.fromEntries(files.map(p => [
  p, createHash('sha256').update(readFileSync(join(root, p))).digest('hex'),
]));
const manifest = {
  name: 'Tetherplane',
  version: '0.1.0-dev',
  platform: 'linux',
  architecture: 'x64',
  source_commit: process.env.TETHERPLANE_SOURCE_COMMIT,
  node_runtime_required: true,
  default_mcp_tools: ['device','files','process','browser','desktop','batch'],
  sha256,
};
writeFileSync(join(root,'manifest.json'), JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
NODE
node scripts/verify-linux-package.mjs "$stage"
[[ ! -e "$out" && ! -L "$out" ]] || {
  echo 'Output appeared during packaging; refusing to replace files' >&2; exit 1;
}
mv -T -- "$stage" "$out"
stage=''
echo "LINUX_CANDIDATE_PACKAGE_OK $out"
