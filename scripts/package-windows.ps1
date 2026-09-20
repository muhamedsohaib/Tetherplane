param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$output = [IO.Path]::GetFullPath($OutputPath)

if (-not $SkipBuild) {
    Push-Location $repo
    try {
        cargo build --release -p tetherd
        if ($LASTEXITCODE -ne 0) { throw "cargo release build failed" }
        pnpm.cmd --filter @tetherplane/compact-mcp build
        if ($LASTEXITCODE -ne 0) { throw "Compact MCP build failed" }
        pnpm.cmd --filter @tetherplane/relay build
        if ($LASTEXITCODE -ne 0) { throw "relay build failed" }
    }
    finally {
        Pop-Location
    }
}

$tetherd = Join-Path $repo "target\release\tetherd.exe"
$compactDist = Join-Path $repo "adapters\compact-mcp\dist\stdio-server.js"
$relayDist = Join-Path $repo "relay\dist\cli.js"
foreach ($required in @($tetherd, $compactDist, $relayDist)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "release artifact is missing: $required"
    }
}

Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $output | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $output "bin"),(Join-Path $output "launch"),(Join-Path $output "adapters"),(Join-Path $output "protocol\schemas") | Out-Null

Copy-Item -LiteralPath $tetherd -Destination (Join-Path $output "bin\tetherd.exe")

Push-Location $repo
try {
    pnpm.cmd --config.node-linker=hoisted --filter @tetherplane/compact-mcp deploy --legacy --prod (Join-Path $output "adapters\compact-mcp")
    if ($LASTEXITCODE -ne 0) { throw "Compact MCP production deploy failed" }
    pnpm.cmd --config.node-linker=hoisted --filter @tetherplane/relay deploy --legacy --prod (Join-Path $output "relay")
    if ($LASTEXITCODE -ne 0) { throw "relay production deploy failed" }
}
finally {
    Pop-Location
}

Copy-Item -LiteralPath (Join-Path $repo "scripts\release-smoke.mjs") -Destination (Join-Path $output "adapters\compact-mcp\smoke-six-tools.mjs")
Copy-Item -Path (Join-Path $repo "protocol\schemas\*.json") -Destination (Join-Path $output "protocol\schemas") -Force
Copy-Item -LiteralPath (Join-Path $repo "packaging\windows\tetherplane-mcp.ps1") -Destination (Join-Path $output "launch\tetherplane-mcp.ps1")
Copy-Item -LiteralPath (Join-Path $repo "packaging\windows\tetherplane-agent.ps1") -Destination (Join-Path $output "launch\tetherplane-agent.ps1")
Copy-Item -LiteralPath (Join-Path $repo "scripts\install-windows.ps1") -Destination (Join-Path $output "install-windows.ps1")
Copy-Item -LiteralPath (Join-Path $repo "scripts\uninstall-windows.ps1") -Destination (Join-Path $output "uninstall-windows.ps1")

foreach ($doc in @("README.md","SECURITY.md","CONTRIBUTING.md","LICENSE-MIT","LICENSE-APACHE")) {
    $source = Join-Path $repo $doc
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $output $doc)
    }
}

Push-Location $repo
try {
    $commit = (git rev-parse HEAD).Trim()
}
finally {
    Pop-Location
}

$manifest = [ordered]@{
    name = "Tetherplane"
    version = "0.1.0"
    source_commit = $commit
    platform = "windows"
    architecture = "x64"
    node_runtime_required = $true
    default_mcp_tools = @("device","files","process","browser","desktop","batch")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output "manifest.json") -Encoding UTF8

Write-Output "TETHERPLANE_WINDOWS_PACKAGE_OK $output"
