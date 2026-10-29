$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Fast, isolated fail-first regression. The package contains only placeholders,
# and the populated foreign directory is created solely under a unique temp root.
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$installer = Join-Path $repo "scripts\install-windows.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("tetherplane-force-owner-ci-" + [guid]::NewGuid().ToString("N"))
$package = Join-Path $root "synthetic-package"
$foreign = Join-Path $root "foreign-app-directory"
$state = Join-Path $root "state"
$marker = Join-Path $foreign "unrelated-owned-data.txt"
try {
    foreach ($relative in @(
        "bin\tetherd.exe",
        "bin\tetherd-agentw.exe",
        "adapters\compact-mcp\dist\stdio-server.js",
        "protocol\schemas\result.schema.json",
        "launch\tetherplane-mcp.ps1",
        "launch\tetherplane-browser.ps1",
        "launch\tetherplane-browser-setup.ps1",
        "browser\host.mjs",
        "browser\extension\manifest.json",
        "browser\extension\dist\background.js",
        "browser\extension\dist\pair.js",
        "manifest.json"
    )) {
        $path = Join-Path $package $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        [IO.File]::WriteAllText($path, "synthetic-ci-only")
    }
    New-Item -ItemType Directory -Force -Path $foreign | Out-Null
    [IO.File]::WriteAllText($marker, "must-preserve")

    $rejected = $false
    try {
        & $installer -PackagePath $package -InstallPrefix $foreign -StateDir $state -Force
    }
    catch {
        if ([string]$_.Exception.Message -match "verified Tetherplane install receipt") {
            $rejected = $true
        }
        else {
            throw
        }
    }
    if (-not $rejected) {
        throw "RELEASE_NO_GO: -Force accepted a populated foreign prefix without an owned Tetherplane receipt"
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw) -ne "must-preserve") {
        throw "RELEASE_NO_GO: -Force modified unrelated files despite rejecting the install"
    }
    if (Test-Path -LiteralPath $state) {
        throw "RELEASE_NO_GO: rejected -Force install still created a state directory"
    }
    Write-Output "WINDOWS_FOREIGN_PREFIX_FORCE_REJECTED_OK"
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

