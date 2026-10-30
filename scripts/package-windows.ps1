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
        & (Join-Path $repo "scripts\build-windows-agent-binaries.ps1")
        if ($LASTEXITCODE -ne 0) { throw "Windows native agent build failed" }
        pnpm.cmd --filter @tetherplane/compact-mcp build
        if ($LASTEXITCODE -ne 0) { throw "Compact MCP build failed" }
        pnpm.cmd --filter @tetherplane/model-client build
        if ($LASTEXITCODE -ne 0) { throw "model client build failed" }
        pnpm.cmd --filter @tetherplane/relay build
        if ($LASTEXITCODE -ne 0) { throw "relay build failed" }
        pnpm.cmd --filter @tetherplane/browser-extension build
        if ($LASTEXITCODE -ne 0) { throw "browser extension build failed" }
    }
    finally {
        Pop-Location
    }
}

$tetherd = Join-Path $repo "target\release\tetherd.exe"
$tetherdWindowless = Join-Path $repo "target\release\tetherd-agentw.exe"
$browserWindowless = Join-Path $repo "target\release\tetherplane-browserw.exe"
$modelWindowless = Join-Path $repo "target\release\tetherplane-modelw.exe"
$compactDist = Join-Path $repo "adapters\compact-mcp\dist\stdio-server.js"
$modelWorkerDist = Join-Path $repo "adapters\model-client\dist\worker-main.js"
$relayDist = Join-Path $repo "relay\dist\cli.js"
$browserBridgeDist = Join-Path $repo "browser\bridge\dist\index.js"
$browserExtensionDist = Join-Path $repo "extension\browser\dist\background.js"
$browserPairDist = Join-Path $repo "extension\browser\dist\pair.js"
$browserHostSource = Join-Path $repo "scripts\browser-extension-host.ts"
foreach ($required in @($tetherd, $tetherdWindowless, $browserWindowless, $modelWindowless, $compactDist, $modelWorkerDist, $relayDist, $browserBridgeDist, $browserExtensionDist, $browserPairDist, $browserHostSource)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "release artifact is missing: $required"
    }
}

Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $output | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $output "bin"),(Join-Path $output "launch"),(Join-Path $output "adapters"),(Join-Path $output "protocol\schemas") | Out-Null

Copy-Item -LiteralPath $tetherd -Destination (Join-Path $output "bin\tetherd.exe")
Copy-Item -LiteralPath $tetherdWindowless -Destination (Join-Path $output "bin\tetherd-agentw.exe")
Copy-Item -LiteralPath $browserWindowless -Destination (Join-Path $output "bin\tetherplane-browserw.exe")
Copy-Item -LiteralPath $modelWindowless -Destination (Join-Path $output "bin\tetherplane-modelw.exe")

$deployStage = Join-Path $repo "target\windows-package-deploy"
$compactDeploy = Join-Path $deployStage "compact-mcp"
$modelClientDeploy = Join-Path $deployStage "model-client"
$relayDeploy = Join-Path $deployStage "relay"
$browserDeploy = Join-Path $deployStage "browser-bridge"
Remove-Item -LiteralPath $deployStage -Recurse -Force -ErrorAction SilentlyContinue

Push-Location $repo
try {
    pnpm.cmd --config.node-linker=hoisted --filter @tetherplane/compact-mcp deploy --legacy --prod "target\windows-package-deploy\compact-mcp"
    if ($LASTEXITCODE -ne 0) { throw "Compact MCP production deploy failed" }
    pnpm.cmd --config.node-linker=hoisted --filter @tetherplane/model-client deploy --legacy --prod "target\windows-package-deploy\model-client"
    if ($LASTEXITCODE -ne 0) { throw "model client production deploy failed" }
    pnpm.cmd --config.node-linker=hoisted --filter @tetherplane/relay deploy --legacy --prod "target\windows-package-deploy\relay"
    if ($LASTEXITCODE -ne 0) { throw "relay production deploy failed" }
    pnpm.cmd --config.node-linker=hoisted --filter @tetherplane/browser-bridge deploy --legacy --prod "target\windows-package-deploy\browser-bridge"
    if ($LASTEXITCODE -ne 0) { throw "browser bridge production deploy failed" }
}
finally {
    Pop-Location
}

Copy-Item -LiteralPath $compactDeploy -Destination (Join-Path $output "adapters") -Recurse -Force
Copy-Item -LiteralPath $modelClientDeploy -Destination (Join-Path $output "adapters") -Recurse -Force
Copy-Item -LiteralPath $relayDeploy -Destination $output -Recurse -Force
$browserRoot = Join-Path $output "browser"
Copy-Item -LiteralPath $browserDeploy -Destination $browserRoot -Recurse -Force
$extensionRoot = Join-Path $browserRoot "extension"
New-Item -ItemType Directory -Force -Path $extensionRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $repo "extension\browser\manifest.json") -Destination (Join-Path $extensionRoot "manifest.json")
Copy-Item -LiteralPath (Join-Path $repo "extension\browser\pair.html") -Destination (Join-Path $extensionRoot "pair.html")
Copy-Item -LiteralPath (Join-Path $repo "extension\browser\dist") -Destination $extensionRoot -Recurse -Force

# Bundle only the reviewed existing authenticated browser host. Bare runtime
# dependencies are resolved against the deployed browser/bridge node_modules
# in the same browser directory; no pnpm or source checkout is needed at runtime.
Push-Location $repo
try {
    $hostOut = Join-Path $browserRoot "host.mjs"
    pnpm.cmd --filter @tetherplane/browser-extension exec esbuild $browserHostSource --bundle --platform=node --format=esm --target=node22 --packages=external ("--outfile=" + $hostOut)
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $hostOut -PathType Leaf)) {
        throw "browser host bundle failed"
    }
}
finally {
    Pop-Location
}
Remove-Item -LiteralPath $deployStage -Recurse -Force -ErrorAction SilentlyContinue

Copy-Item -LiteralPath (Join-Path $repo "scripts\release-smoke.mjs") -Destination (Join-Path $output "adapters\compact-mcp\smoke-six-tools.mjs")
Copy-Item -Path (Join-Path $repo "protocol\schemas\*.json") -Destination (Join-Path $output "protocol\schemas") -Force
Copy-Item -LiteralPath (Join-Path $repo "packaging\windows\tetherplane-mcp.ps1") -Destination (Join-Path $output "launch\tetherplane-mcp.ps1")
Copy-Item -LiteralPath (Join-Path $repo "packaging\windows\tetherplane-agent.ps1") -Destination (Join-Path $output "launch\tetherplane-agent.ps1")
Copy-Item -LiteralPath (Join-Path $repo "packaging\windows\tetherplane-browser.ps1") -Destination (Join-Path $output "launch\tetherplane-browser.ps1")
Copy-Item -LiteralPath (Join-Path $repo "packaging\windows\tetherplane-browser-setup.ps1") -Destination (Join-Path $output "launch\tetherplane-browser-setup.ps1")
Copy-Item -LiteralPath (Join-Path $repo "scripts\install-windows.ps1") -Destination (Join-Path $output "install-windows.ps1")
Copy-Item -LiteralPath (Join-Path $repo "scripts\install-model-worker-windows.ps1") -Destination (Join-Path $output "install-model-worker-windows.ps1")
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
    browser_payload_included = $true
    browser_activation = "manual_local_pairing"
    default_mcp_tools = @("device","files","process","browser","desktop","batch")
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $output "manifest.json"), $manifestJson, $utf8NoBom)

Write-Output "TETHERPLANE_WINDOWS_PACKAGE_OK $output"
