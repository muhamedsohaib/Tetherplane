# Convert the committed owner-supplied originals, without redrawing or cropping.
# Uses inbox Windows System.Drawing; no network, toolchain or policy changes.
[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\assets\windows'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$sizes = @(16,20,24,32,40,48,64,128,256)
$images = @()
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
foreach ($variant in @('black-on-white','white-on-black')) {
    $sourceRelative = 'assets/windows/source/' + $variant + '.jpg'
    $source = Join-Path $repository $sourceRelative
    $bitmap = [Drawing.Image]::FromFile($source)
    $frames = @()
    try {
        foreach ($size in $sizes) {
            $canvas = [Drawing.Bitmap]::new($size,$size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $graphics = [Drawing.Graphics]::FromImage($canvas)
            $stream = [IO.MemoryStream]::new()
            try {
                $background = if ($variant -eq 'black-on-white') { [Drawing.Color]::White } else { [Drawing.Color]::Black }
                $graphics.Clear($background)
                $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $scale = [Math]::Min($size / [double]$bitmap.Width,$size / [double]$bitmap.Height)
                $width = [single]($bitmap.Width * $scale)
                $height = [single]($bitmap.Height * $scale)
                $rectangle = [Drawing.RectangleF]::new([single](($size-$width)/2),[single](($size-$height)/2),$width,$height)
                $graphics.DrawImage($bitmap,$rectangle)
                $canvas.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
                $frames += ,$stream.ToArray()
            } finally {
                $stream.Dispose()
                $graphics.Dispose()
                $canvas.Dispose()
            }
        }
        $icon = Join-Path $OutputDirectory ('tetherplane-' + $variant + '.ico')
        $file = [IO.File]::Create($icon)
        $writer = [IO.BinaryWriter]::new($file)
        try {
            $writer.Write([uint16]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]$sizes.Count)
            $offset = 6 + 16 * $sizes.Count
            for ($i=0; $i -lt $sizes.Count; $i++) {
                $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
                $writer.Write([byte]$dimension)
                $writer.Write([byte]$dimension)
                $writer.Write([byte]0)
                $writer.Write([byte]0)
                $writer.Write([uint16]1)
                $writer.Write([uint16]32)
                $writer.Write([uint32]$frames[$i].Length)
                $writer.Write([uint32]$offset)
                $offset += $frames[$i].Length
            }
            foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
        } finally { $writer.Dispose() }
        $images += [ordered]@{
            variant=$variant
            source=$sourceRelative
            sourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
            width=$bitmap.Width
            height=$bitmap.Height
            icon=('assets/windows/tetherplane-' + $variant + '.ico')
            iconSha256=(Get-FileHash -LiteralPath $icon -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    } finally { $bitmap.Dispose() }
}
$manifest = [ordered]@{
    schemaVersion=1
    conversion='Full original image; proportional resize; centered opaque background padding; no crop, recolor, redraw or generated art.'
    sizes=$sizes
    images=$images
}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'icon-provenance.json'),($manifest | ConvertTo-Json -Depth 5) + "`n",[Text.UTF8Encoding]::new($false))
Write-Output 'BETA_ICONS_BUILT_FROM_EXACT_ORIGINALS'
