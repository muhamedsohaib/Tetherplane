$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$packageScript = Join-Path $repo "scripts\package-windows.ps1"
$installScript = Join-Path $repo "scripts\install-windows.ps1"
$uninstallScript = Join-Path $repo "scripts\uninstall-windows.ps1"

foreach ($required in @($packageScript, $installScript, $uninstallScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "required release script is missing: $required"
    }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("tetherplane-release-smoke-" + [guid]::NewGuid().ToString("N"))
$stage = Join-Path $root "package"
$install = Join-Path $root "install"
$state = Join-Path $root "state"
$allow = Join-Path $root "allowed"

try {
    New-Item -ItemType Directory -Force -Path $root,$allow | Out-Null

    & $packageScript -OutputPath $stage -SkipBuild
    if ($LASTEXITCODE -ne 0) {
        throw "package script failed with exit code $LASTEXITCODE"
    }

    foreach ($relative in @(
        "bin\tetherd.exe",
        "adapters\compact-mcp\dist\stdio-server.js",
        "adapters\compact-mcp\node_modules",
        "adapters\compact-mcp\smoke-six-tools.mjs",
        "protocol\schemas\result.schema.json",
        "launch\tetherplane-mcp.ps1",
        "install-windows.ps1",
        "uninstall-windows.ps1",
        "manifest.json"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage $relative))) {
            throw "release package is missing $relative"
        }
    }

    & $installScript -PackagePath $stage -InstallPrefix $install -StateDir $state
    if ($LASTEXITCODE -ne 0) {
        throw "install script failed with exit code $LASTEXITCODE"
    }

    $installedTetherd = Join-Path $install "bin\tetherd.exe"
    $installedSmoke = Join-Path $install "adapters\compact-mcp\smoke-six-tools.mjs"
    if (-not (Test-Path -LiteralPath $installedTetherd)) {
        throw "installed tetherd is missing"
    }

    & node $installedSmoke --tetherd $installedTetherd --allow $allow --state-dir $state
    if ($LASTEXITCODE -ne 0) {
        throw "installed six-tool smoke failed with exit code $LASTEXITCODE"
    }

    $sentinel = Join-Path $state "preserve-me.txt"
    Set-Content -LiteralPath $sentinel -Value "preserve" -NoNewline

    & $uninstallScript -InstallPrefix $install
    if ($LASTEXITCODE -ne 0) {
        throw "uninstall script failed with exit code $LASTEXITCODE"
    }
    if (Test-Path -LiteralPath $install) {
        throw "uninstall left installed binaries behind"
    }
    if (-not (Test-Path -LiteralPath $sentinel)) {
        throw "ordinary uninstall deleted preserved state"
    }

    Write-Output "WINDOWS_PACKAGE_SMOKE_OK"
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
