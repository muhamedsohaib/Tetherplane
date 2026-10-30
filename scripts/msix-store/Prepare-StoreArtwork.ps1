# Creates only UNAPPROVED mechanical exports from an exact, owner-supplied PNG.
# No Store/MSIX submission, owner approval, identity changes, or device changes.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceEmblem,
    [Parameter(Mandatory = $true)][string]$ExpectedSourceSha256,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'STORE_ARTWORK_WINDOWS_ONLY'
}
if ($ExpectedSourceSha256 -cnotmatch '^[0-9a-fA-F]{64}$') {
    throw 'STORE_ARTWORK_EXPECTED_SOURCE_HASH_REQUIRED'
}
$source = (Resolve-Path -LiteralPath $SourceEmblem -ErrorAction Stop).Path
if (-not $source.EndsWith('.png', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'STORE_ARTWORK_PNG_SOURCE_REQUIRED'
}
if ((Get-Item -LiteralPath $source -ErrorAction Stop).Length -gt 20MB) {
    throw 'STORE_ARTWORK_SOURCE_TOO_LARGE'
}
$actualSourceSha = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSourceSha -cne $ExpectedSourceSha256.ToLowerInvariant()) {
    throw 'STORE_ARTWORK_SOURCE_HASH_MISMATCH'
}

$dest = [IO.Path]::GetFullPath($OutputDirectory)
$parent = [IO.Path]::GetDirectoryName($dest)
if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw 'STORE_ARTWORK_OUTPUT_PARENT_REQUIRED'
}
if (Test-Path -LiteralPath $dest) {
    throw 'STORE_ARTWORK_REFUSES_EXISTING_OUTPUT'
}
if ($dest.TrimEnd([IO.Path]::DirectorySeparatorChar) -ceq $parent.TrimEnd([IO.Path]::DirectorySeparatorChar)) {
    throw 'STORE_ARTWORK_INVALID_OUTPUT'
}
# Scratch is a newly created sibling directory. Do not touch any existing path.
$scratch = Join-Path $parent ('.tetherplane-artwork-stage-' + [guid]::NewGuid().ToString('N'))
$ownedScratch = $false
Add-Type -AssemblyName System.Drawing
try {
    $input = [Drawing.Bitmap]::FromFile($source)
    try {
        if ($input.Width -ne $input.Height -or $input.Width -lt 512 -or $input.Width -gt 8192) {
            throw 'STORE_ARTWORK_SQUARE_HIGH_RES_SOURCE_REQUIRED'
        }
        if (-not [Drawing.Image]::IsAlphaPixelFormat($input.PixelFormat)) {
            throw 'STORE_ARTWORK_TRANSPARENT_PNG_REQUIRED'
        }
        $corners = @(
            $input.GetPixel(0, 0).A,
            $input.GetPixel($input.Width - 1, 0).A,
            $input.GetPixel(0, $input.Height - 1).A,
            $input.GetPixel($input.Width - 1, $input.Height - 1).A
        )
        if (@($corners | Where-Object { $_ -gt 15 }).Count -ne 0) {
            throw 'STORE_ARTWORK_CLEAR_CORNER_PADDING_REQUIRED'
        }
        [void][IO.Directory]::CreateDirectory($scratch)
        $ownedScratch = $true
        $assets = [ordered]@{
            'Logo44.png' = 44
            'Logo50.png' = 50
            'Logo150.png' = 150
            'Logo300.png' = 300
        }
        $hashes = [ordered]@{}
        foreach ($name in $assets.Keys) {
            $size = [int]$assets[$name]
            $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([Drawing.Color]::Transparent)
                $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
                $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
                $graphics.DrawImage($input, [Drawing.Rectangle]::new(0, 0, $size, $size))
                $file = Join-Path $scratch $name
                $bitmap.Save($file, [Drawing.Imaging.ImageFormat]::Png)
            } finally {
                $graphics.Dispose()
                $bitmap.Dispose()
            }
            $verify = [Drawing.Image]::FromFile((Join-Path $scratch $name))
            try {
                if ($verify.Width -ne $size -or $verify.Height -ne $size) {
                    throw 'STORE_ARTWORK_OUTPUT_DIMENSIONS_MISMATCH'
                }
            } finally { $verify.Dispose() }
            $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $scratch $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $evidence = [ordered]@{
            schema = 'tetherplane.store-artwork-preflight.v1'
            package_identity = 'ARCUSLabs.Tetherplane'
            disposition = 'UNAPPROVED_SOURCE_TRANSFORM'
            source_sha256 = $actualSourceSha
            source_square_pixels = $input.Width
            files = $hashes
            screenshot = 'NOT_CAPTURED'
            owner_approval_reference = $null
        }
        [IO.File]::WriteAllText((Join-Path $scratch 'asset-evidence.UNAPPROVED.json'),
            ($evidence | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $scratch 'NOT_APPROVED_FOR_STORE.txt'),
            "Mechanical output only. No owner approval, genuine app screenshot, Store certification or publisher eligibility is implied.`n", [Text.UTF8Encoding]::new($false))
    } finally { $input.Dispose() }
    # Publish only after all four artifacts and their hashes have been verified.
    if (Test-Path -LiteralPath $dest) { throw 'STORE_ARTWORK_REFUSES_EXISTING_OUTPUT' }
    [IO.Directory]::Move($scratch, $dest)
    $ownedScratch = $false
    Write-Output 'STORE_ARTWORK_MECHANICAL_EXPORT_PASS_NOT_APPROVED'
} finally {
    if ($ownedScratch -and (Test-Path -LiteralPath $scratch -PathType Container)) {
        Remove-Item -LiteralPath $scratch -Recurse -Force
    }
}
