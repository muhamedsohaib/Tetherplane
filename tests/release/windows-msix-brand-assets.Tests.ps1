# Verify that a user-provided, deterministic logo tile set survives MakeAppx unchanged.
# Test runs on an isolated Windows CI runner; never installs an unsigned package.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$TetherdPath)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$packager = Join-Path $repo "scripts\package-windows-store-msix.ps1"
$stage = Join-Path $env:TEMP ("tp-store-brand-gate-" + [guid]::NewGuid().ToString("N"))
$assets = Join-Path $stage "brand"
$unpacked = Join-Path $stage "unpacked"
$out = Join-Path $stage "branded-proof.msix"
New-Item -Path $assets -ItemType Directory -Force -ErrorAction Stop | Out-Null
try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $mapping = @(
        @{ Name = "tetherplane-44.png"; Size = 44 },
        @{ Name = "tetherplane-50.png"; Size = 50 },
        @{ Name = "tetherplane-150.png"; Size = 150 }
    )
    foreach ($item in $mapping) {
        $bitmap = New-Object Drawing.Bitmap([int]$item.Size, [int]$item.Size)
        try {
            $gfx = [Drawing.Graphics]::FromImage($bitmap)
            try { $gfx.Clear([Drawing.Color]::DarkSlateBlue) } finally { $gfx.Dispose() }
            $bitmap.Save((Join-Path $assets $item.Name), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $bitmap.Dispose() }
    }

    & $packager -TetherdPath $TetherdPath -OutputPath $out -BrandAssetsDirectory $assets
    if (-not (Test-Path -LiteralPath $out -PathType Leaf)) { throw "brand-aware MSIX was not created" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($out, $unpacked)
    foreach ($item in $mapping) {
        $original = Join-Path $assets $item.Name
        $packaged = Join-Path (Join-Path $unpacked "Assets") ("Logo" + $item.Size + ".png")
        if (-not (Test-Path -LiteralPath $packaged -PathType Leaf)) {
            throw "MSIX is missing expected custom logo $($item.Name)"
        }
        $a = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash
        $b = (Get-FileHash -LiteralPath $packaged -Algorithm SHA256).Hash
        if ($a -cne $b) { throw "MSIX logo bytes changed: $($item.Name)" }
    }

    $broken = Join-Path $stage "missing-icons"
    New-Item -Path $broken -ItemType Directory -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath (Join-Path $assets "tetherplane-44.png") -Destination $broken -ErrorAction Stop
    $invalidOutput = Join-Path $stage "incomplete-icons.msix"
    $rejected = $false
    try {
        & $packager -TetherdPath $TetherdPath -OutputPath $invalidOutput -BrandAssetsDirectory $broken
    } catch { $rejected = $true }
    if (-not $rejected -or (Test-Path -LiteralPath $invalidOutput)) {
        throw "missing required brand tiles must be rejected without writing an output"
    }
    Write-Output "STORE_CUSTOM_BRANDING_OK: exact brand PNG bytes preserved in unsigned MSIX"
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
