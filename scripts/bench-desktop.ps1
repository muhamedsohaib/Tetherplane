$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repo
try {
    cargo build -p tetherd --release
    pnpm.cmd --filter @tetherplane/compact-mcp build
    node scripts/bench-desktop.ts
} finally {
    Pop-Location
}
