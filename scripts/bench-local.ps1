$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repo
try {
    cargo build -p tetherd --release
    pnpm.cmd --filter @tetherplane/compact-mcp build
    node scripts/bench-local.ts
} finally {
    Pop-Location
}
