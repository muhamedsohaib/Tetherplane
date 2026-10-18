# Build an UNSIGNED and never-installed MSIX packaging prototype for the native Windows agent.
# The Microsoft Store, not this script, would authenticate and sign a certified release.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TetherdPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-WindowsMakeAppx {
    $onPath = Get-Command -Name "makeappx.exe" -ErrorAction SilentlyContinue
    if ($onPath) { return [string]$onPath.Source }
    $kits = Join-Path ([Environment]::GetFolderPath("ProgramFilesX86")) "Windows Kits\10\bin"
    if (-not (Test-Path -LiteralPath $kits -PathType Container)) {
        throw "Windows SDK MakeAppx is required on an isolated Windows build runner"
    }
    $versions = @(Get-ChildItem -LiteralPath $kits -Directory -ErrorAction Stop |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object -Property Name -Descending)
    foreach ($v in $versions) {
        $candidate = Join-Path $v.FullName "x64\makeappx.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw "Windows SDK MakeAppx x64 executable not found"
}

if ($env:OS -ne "Windows_NT") { throw "MSIX packaging prototype requires Windows" }
if ([IO.Path]::GetExtension($TetherdPath) -ine ".exe") { throw "expected a native Windows .exe" }
if ([IO.Path]::GetExtension($OutputPath) -ine ".msix") { throw "output must use the .msix extension" }
$binary = (Resolve-Path -LiteralPath $TetherdPath -ErrorAction Stop).Path
$file = Get-Item -LiteralPath $binary -ErrorAction Stop
if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "refusing a redirected native-agent binary"
}
$stream = [IO.File]::OpenRead($binary)
try {
    if ($stream.ReadByte() -ne 0x4D -or $stream.ReadByte() -ne 0x5A) {
        throw "input binary is not a Windows PE executable"
    }
} finally { $stream.Dispose() }
$target = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $target) { throw "output exists; refusing to overwrite a candidate package" }
$parent = Split-Path -Parent $target
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "output parent must be an existing isolated build directory"
}
$makeappx = Get-WindowsMakeAppx
$stage = Join-Path $env:TEMP ("tetherplane-msix-stage-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path (Join-Path $stage "bin") -Force -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "Assets") -Force -ErrorAction Stop | Out-Null
try {
    Copy-Item -LiteralPath $binary -Destination (Join-Path $stage "bin\tetherd.exe") -ErrorAction Stop
    $manifest = @'
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap5="http://schemas.microsoft.com/appx/manifest/uap/windows10/5"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap5 rescap">
  <Identity Name="Tetherplane.OpenSource.Proof" Publisher="CN=Tetherplane Prototype"
    Version="0.1.0.0" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Tetherplane MSIX feasibility prototype</DisplayName>
    <PublisherDisplayName>Tetherplane prototype (not trusted)</PublisherDisplayName>
    <Logo>Assets\Logo50.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Applications>
    <Application Id="TetherplaneAgent" Executable="bin\tetherd.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Tetherplane (prototype)"
        Description="Tetherplane device agent MSIX packaging experiment"
        BackgroundColor="transparent" Square150x150Logo="Assets\Logo150.png"
        Square44x44Logo="Assets\Logo44.png" />
      <Extensions>
        <uap5:Extension Category="windows.startupTask" Executable="bin\tetherd.exe" EntryPoint="Windows.FullTrustApplication">
          <uap5:StartupTask TaskId="TetherplaneAgentAtLogon" Enabled="false" DisplayName="Tetherplane background agent" />
        </uap5:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
'@
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $stage "AppxManifest.xml"), $manifest, $utf8)
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    foreach ($entry in @(@("Logo50.png",50),@("Logo44.png",44),@("Logo150.png",150))) {
        $size = [int]$entry[1]
        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        try {
            $g = [Drawing.Graphics]::FromImage($bmp)
            try { $g.Clear([Drawing.Color]::FromArgb(38, 43, 54)) } finally { $g.Dispose() }
            $bmp.Save((Join-Path (Join-Path $stage "Assets") ([string]$entry[0])), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $bmp.Dispose() }
    }
    & $makeappx pack /d $stage /p $target
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
        throw "Windows SDK MakeAppx rejected the unsigned Store candidate"
    }
    Write-Output ("MSIX_PROTOTYPE_BUILT (unsigned, uninstalled): " + $target)
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
