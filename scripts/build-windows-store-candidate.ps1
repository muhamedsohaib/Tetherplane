# Produce an immutable, source-bound UNSIGNED MSIX Store-development candidate.
# No signing, Store submission, device installation, credential, relay, or policy mutation.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TetherdPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$SourceCommit
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-OrdinaryStorePath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $path = [IO.Path]::GetFullPath($LiteralPath)
    $root = [IO.Path]::GetPathRoot($path)
    while ($path) {
        if (Test-Path -LiteralPath $path) {
            $entry = Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "refusing redirected MSIX input or output path"
            }
        }
        if ($path -eq $root) { break }
        $parent = [IO.Path]::GetDirectoryName($path)
        if (-not $parent -or $parent -eq $path) { break }
        $path = $parent
    }
}

if ($env:OS -ne "Windows_NT") { throw "Windows MSIX candidate must be built on Windows" }
if ($SourceCommit -cnotmatch '^[a-f0-9]{40}$') { throw "expected exact lowercase 40-character source SHA" }
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$actualSource = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualSource -cne $SourceCommit) {
    throw "source commit differs from checked-out source; refusing to label an unrelated build"
}
$dirty = @(& git -C $repo status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0 -or @($dirty | Where-Object { $_ }).Count -gt 0) {
    throw "tracked source tree is not clean"
}
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) {
    throw "output directory must be absolute"
}
$target = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) {
    throw "candidate output already exists; refusing overwrite or adoption"
}
$parent = [IO.Path]::GetDirectoryName($target)
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "candidate output parent must already exist"
}
Assert-OrdinaryStorePath -LiteralPath $target
$binary = (Resolve-Path -LiteralPath $TetherdPath -ErrorAction Stop).Path
Assert-OrdinaryStorePath -LiteralPath $binary
if ([IO.Path]::GetExtension($binary) -ine ".exe") { throw "agent input must be a Windows EXE" }
$binaryHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()

$stage = Join-Path $parent ("tetherplane-unsigned-stage-" + [guid]::NewGuid().ToString("N"))
$stageCreated = $false
try {
    if (Test-Path -LiteralPath $stage) { throw "candidate stage already exists" }
    New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
    $stageCreated = $true
    $shortSource = $SourceCommit.Substring(0,12)
    $baseName = "tetherplane-UNSIGNED-store-proof-" + $shortSource
    $package = Join-Path $stage ($baseName + ".msix")
    $packager = Join-Path $repo "scripts\package-windows-store-msix.ps1"
    & $packager -TetherdPath $binary -OutputPath $package
    if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { throw "packager failed to write the candidate" }

    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    $archive = [IO.Compression.ZipFile]::OpenRead($package)
    try {
        if ($archive.GetEntry("AppxSignature.p7x")) {
            throw "unexpected signed package metadata in an unsigned proof"
        }
        $agent = $archive.GetEntry("bin/tetherd.exe")
        $manifestEntry = $archive.GetEntry("AppxManifest.xml")
        if (-not $agent -or -not $manifestEntry) {
            throw "candidate lacks native agent or package manifest"
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        $agentStream = $agent.Open()
        try {
            $insideHash = ([BitConverter]::ToString($sha.ComputeHash($agentStream))).Replace("-", "").ToLowerInvariant()
        } finally { $agentStream.Dispose(); $sha.Dispose() }
        if ($insideHash -cne $binaryHash) {
            throw "package agent bytes do not match built native input"
        }
        $xmlStream = $manifestEntry.Open()
        $reader = New-Object IO.StreamReader($xmlStream)
        try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose(); $xmlStream.Dispose() }
        $identity = $manifest.SelectSingleNode("//*[local-name()='Identity']")
        $app = $manifest.SelectSingleNode("//*[local-name()='Application']")
        $start = $manifest.SelectSingleNode("//*[local-name()='Extension' and @Category='windows.startupTask']")
        $fullTrust = $manifest.SelectSingleNode("//*[local-name()='Capability' and @Name='runFullTrust']")
        if (-not $identity -or [string]$identity.Name -cne "Tetherplane.OpenSource.Proof" -or
            -not $app -or [string]$app.Executable -cne "bin\tetherd.exe" -or
            -not $start -or -not $fullTrust) {
            throw "unrecognized Store-proof manifest: identity, agent entry or capabilities changed"
        }
        if ($manifest.SelectSingleNode("//*[local-name()='StartupTask' and @Enabled='true']")) {
            throw "proof cannot enable automatic startup"
        }
    } finally { $archive.Dispose() }

    $packageHash = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText(($package + ".sha256"), ($packageHash + "  " + [IO.Path]::GetFileName($package) + [Environment]::NewLine), $utf8)
    $provenance = [ordered]@{
        schema_version = 1
        source_commit = $SourceCommit
        native_agent_sha256 = $binaryHash
        msix_sha256 = $packageHash
        manifest_identity = "Tetherplane.OpenSource.Proof"
        signing_status = "unsigned"
        distribution_status = "store_development_candidate"
        store_certified = $false
        device_runtime_verified = $false
        created_utc = [DateTime]::UtcNow.ToString("o")
    }
    [IO.File]::WriteAllText(
        (Join-Path $stage ($baseName + ".provenance.json")),
        (($provenance | ConvertTo-Json -Depth 4) + [Environment]::NewLine), $utf8
    )
    [IO.File]::WriteAllText(
        (Join-Path $stage "UNSIGNED-DO-NOT-INSTALL.txt"),
        ("NOT SIGNED - DO NOT INSTALL ON PERSONAL DEVICES." + [Environment]::NewLine +
         "This is an unsigned Microsoft Store MSIX development proof only." + [Environment]::NewLine +
         "It is not certified, not trusted by Windows Smart App Control, and not an operational device installer." + [Environment]::NewLine +
         "A checksum supplied alongside the package does not create publisher trust." + [Environment]::NewLine), $utf8
    )
    if (Test-Path -LiteralPath $target) {
        throw "candidate output destination appeared while building; refusing overwrite"
    }
    Move-Item -LiteralPath $stage -Destination $target -ErrorAction Stop
    $stageCreated = $false
    Write-Output ("MSIX_CANDIDATE_CREATED: source=" + $SourceCommit +
        " msix_sha256=" + $packageHash + " unsigned, uninstalled, not Store-certified")
} finally {
    if ($stageCreated -and (Test-Path -LiteralPath $stage -PathType Container)) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
