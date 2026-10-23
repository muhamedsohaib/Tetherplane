# Builds the agent-only Tetherplane device kit for a NEW controlled Windows PC.
#
# The kit needs no Rust, pnpm or Node on the target computer: it ships the
# prebuilt tetherd agent, the PowerShell background supervisor, the setup /
# pair / doctor scripts and the non-secret connection profile, plus a SHA-256
# manifest covering every file. No credential is generated or embedded.
param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [string]$TetherdPath = "",
    [switch]$SkipBuild,
    [switch]$Zip,
    [string]$Version = "0.1.0",
    [switch]$RequireTrustedSignature,
    [string]$ExpectedPublisherSubject = "",
    [string]$ExpectedSignerThumbprint = "",
    [string]$ExpectedSourceCommit = "",
    [string]$SignedPayloadPath = "",
    [string]$SigningRequestPath = "",
    [string]$ExpectedSigningRequestSha256 = "",
    [string]$UnsignedPayloadPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$output = [IO.Path]::GetFullPath($OutputPath)
$finalOutput = $output
# Dot-sourcing loads only the reviewed checkout helper. Preserve caller policy
# separately: the setup script has its own parameter defaults in this scope.
$packagingPolicy = @{
    RequireTrustedSignature = [bool]$RequireTrustedSignature
    ExpectedPublisherSubject = $ExpectedPublisherSubject
    ExpectedSignerThumbprint = $ExpectedSignerThumbprint
    ExpectedSourceCommit = $ExpectedSourceCommit
}
. (Join-Path $repo "scripts/setup-windows-device.ps1")
if ($packagingPolicy.RequireTrustedSignature) { . (Join-Path $repo "scripts/new-windows-signing-request.ps1") }
Assert-DevicePathNotRedirected -LiteralPath $output
if (-not $packagingPolicy.RequireTrustedSignature -and ($SignedPayloadPath -or
    $SigningRequestPath -or $ExpectedSigningRequestSha256 -or $UnsignedPayloadPath -or
    $packagingPolicy.ExpectedPublisherSubject -or $packagingPolicy.ExpectedSignerThumbprint -or
    $packagingPolicy.ExpectedSourceCommit)) {
    throw "signing inputs require -RequireTrustedSignature; select unsigned development packaging explicitly"
}
if ($packagingPolicy.RequireTrustedSignature) {
    if ([string]::IsNullOrWhiteSpace($packagingPolicy.ExpectedPublisherSubject)) {
        throw "signed distribution requires an independently approved publisher subject"
    }
    if ($packagingPolicy.ExpectedSignerThumbprint -notmatch "^[a-fA-F0-9]{40}$") {
        throw "signed distribution requires an independently approved signer thumbprint"
    }
    if ($packagingPolicy.ExpectedSourceCommit -notmatch "^[a-fA-F0-9]{40}$") {
        throw "signed distribution requires an independently selected source revision"
    }
    if (-not $SignedPayloadPath) { throw "signed distribution requires -SignedPayloadPath containing all five signed code files" }
    if (-not $SigningRequestPath -or $ExpectedSigningRequestSha256 -notmatch "^[a-fA-F0-9]{64}$" -or -not $UnsignedPayloadPath) {
        throw "signed distribution requires the independently hashed signing request and its original unsigned payload"
    }
    if (-not $SkipBuild) { throw "signed packaging requires -SkipBuild; build and sign before packaging final bytes" }
    if (Test-Path -LiteralPath $output) { throw "signed output already exists; choose a new immutable artifact path" }
}
$existingRoot = Get-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
if ($existingRoot -and (($existingRoot.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "kit output directory is a redirected path; refusing to replace it: $output"
}

# ZIP and checksum may be unrelated human files. Fail before touching the
# previous kit directory, even for an otherwise authorized kit rebuild.
if ($Zip) {
    foreach ($artifact in @($output + ".zip", $output + ".zip.sha256")) {
        if ((Get-Item -LiteralPath $artifact -Force -ErrorAction SilentlyContinue) -or
            (Test-Path -LiteralPath $artifact)) {
            throw "archive destination already exists; choose a new OutputPath rather than overwriting it: $artifact"
        }
    }
}
if (-not $TetherdPath) { $TetherdPath = Join-Path $repo "target\release\tetherd.exe" }

if (-not $SkipBuild) {
    Push-Location $repo
    try {
        cargo build --release -p tetherd
        if ($LASTEXITCODE -ne 0) { throw "cargo release build failed" }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path -LiteralPath $TetherdPath -PathType Leaf)) {
    throw "agent binary is missing: $TetherdPath (build it with: cargo build --release -p tetherd)"
}

$sourceCommit = ""
$sourceDirty = $true
$sourceCommit = ((& git -C $repo rev-parse HEAD) | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "could not read source revision from Git" }
$sourceDirty = [bool](((& git -C $repo status --porcelain --untracked-files=normal) | Out-String).Trim())
if ($LASTEXITCODE -ne 0) { throw "could not inspect source checkout status" }
if ($sourceCommit -notmatch "^[0-9a-f]{40}$") {
    throw "could not determine the source commit; build the kit from a Git checkout"
}

function Assert-SignedPackagingSource {
    $currentCommit = ((& git -C $repo rev-parse HEAD) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $currentCommit -ine $packagingPolicy.ExpectedSourceCommit) {
        throw "checkout source revision differs from the independently selected source revision"
    }
    $status = ((& git -C $repo status --porcelain --untracked-files=normal) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $status) { throw "signed packaging requires a clean source checkout" }
}

if ($packagingPolicy.RequireTrustedSignature) {
    Assert-SignedPackagingSource
    $signingProvenance = @{
        RequestPath = $SigningRequestPath
        ExpectedRequestSha256 = $ExpectedSigningRequestSha256
        ExpectedSourceCommit = $packagingPolicy.ExpectedSourceCommit
        UnsignedPayloadPath = $UnsignedPayloadPath
    }
    Confirm-WindowsSignedPayload @signingProvenance -SignedPayloadPath $SignedPayloadPath | Out-Null
    $signedPayload = [IO.Path]::GetFullPath($SignedPayloadPath)
    Assert-DevicePathNotRedirected -LiteralPath $signedPayload
    if (-not (Test-Path -LiteralPath $signedPayload -PathType Container)) { throw "SignedPayloadPath is missing" }
    if ([IO.Path]::GetFullPath($TetherdPath) -ine [IO.Path]::GetFullPath((Join-Path $signedPayload "bin/tetherd.exe"))) {
        throw "TetherdPath differs from the isolated signed payload binary"
    }
    foreach ($entry in @(Get-ChildItem -LiteralPath $signedPayload -Recurse -Force)) {
        Assert-DevicePathNotRedirected -LiteralPath $entry.FullName
        $relative = $entry.FullName.Substring($signedPayload.TrimEnd([IO.Path]::DirectorySeparatorChar).Length + 1).Replace("\", "/")
        if (($entry.PSIsContainer -and @("bin", "launch") -cnotcontains $relative) -or
            (-not $entry.PSIsContainer -and $SignedDeviceCodeFiles -cnotcontains $relative)) {
            throw "unexpected signing payload entry: $relative"
        }
    }
    foreach ($relative in $SignedDeviceCodeFiles) {
        Assert-TrustedDeviceSignature -Path (Join-Path $signedPayload $relative) -ExpectedPublisherSubject $packagingPolicy.ExpectedPublisherSubject -ExpectedSignerThumbprint $packagingPolicy.ExpectedSignerThumbprint | Out-Null
    }
}

function Assert-PriorDeviceKitIntegrity {
    param([Parameter(Mandatory = $true)][string]$Directory)

    # Only delete a previous kit when every existing entry is one we shipped
    # and all its file hashes still match the prior build's manifest.
    $rootNames = @(
        "bin", "launch", "manifest.json", "manifest.sha256", "setup.cmd",
        "README.txt", "setup-windows-device.ps1", "pair-windows-device.ps1",
        "doctor-tetherplane.ps1", "connection-profile.json"
    )
    $hashPaths = @(
        "bin/tetherd.exe", "launch/tetherplane-agent.ps1", "manifest.json",
        "setup.cmd", "README.txt", "setup-windows-device.ps1",
        "pair-windows-device.ps1", "doctor-tetherplane.ps1", "connection-profile.json"
    )
    foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Force)) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "previous kit contains a reparse point; refusing to delete it: $($entry.FullName)"
        }
        if ($rootNames -notcontains $entry.Name) {
            throw "previous kit contains an unknown file or directory; refusing to delete it: $($entry.FullName)"
        }
        if ($entry.PSIsContainer -ne (@("bin", "launch") -contains $entry.Name)) {
            throw "previous kit entry has an unexpected type: $($entry.FullName)"
        }
    }
    foreach ($directoryName in @("bin", "launch")) {
        $folder = Join-Path $Directory $directoryName
        if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
            throw "previous kit is missing a managed directory: $folder"
        }
        $expectedLeaf = if ($directoryName -eq "bin") { "tetherd.exe" } else { "tetherplane-agent.ps1" }
        foreach ($child in @(Get-ChildItem -LiteralPath $folder -Force)) {
            if ($child.PSIsContainer -or
                ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                $child.Name -ne $expectedLeaf) {
                throw "previous kit contains an unknown or redirected child; refusing deletion: $($child.FullName)"
            }
        }
    }

    $checksumFile = Join-Path $Directory "manifest.sha256"
    if (-not (Test-Path -LiteralPath $checksumFile -PathType Leaf)) {
        throw "previous kit has no hash manifest; refusing to delete it"
    }
    $hashes = @{}
    foreach ($line in @(Get-Content -LiteralPath $checksumFile)) {
        if (-not $line.Trim()) { continue }
        $parts = $line.Trim() -split "\s+", 2
        if ($parts.Count -ne 2 -or $parts[0] -notmatch "^[a-fA-F0-9]{64}$" -or
            $hashPaths -notcontains $parts[1] -or $hashes.ContainsKey($parts[1])) {
            throw "previous kit hash manifest is malformed; refusing to delete it"
        }
        $hashes[$parts[1]] = $parts[0].ToLowerInvariant()
    }
    foreach ($relative in $hashPaths) {
        if (-not $hashes.ContainsKey($relative)) {
            throw "previous kit hash manifest is incomplete; refusing to delete it"
        }
        $target = Join-Path $Directory ($relative.Replace("/", "\"))
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "previous kit is missing a managed file: $target"
        }
        $item = Get-Item -LiteralPath $target -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "previous kit has a redirected managed file: $target"
        }
        $actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hashes[$relative] -ne $actualHash) {
            throw "previous kit contains locally modified files; refusing to delete it: $target"
        }
    }
}

if (Test-Path -LiteralPath $output) {
    $existing = @(Get-ChildItem -LiteralPath $output -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        $previousManifest = Join-Path $output "manifest.json"
        $isPriorKit = $false
        if (Test-Path -LiteralPath $previousManifest -PathType Leaf) {
            try { $isPriorKit = ((Get-Content -LiteralPath $previousManifest -Raw | ConvertFrom-Json).kit -eq "device-agent") } catch { $isPriorKit = $false }
        }
        if (-not $isPriorKit) {
            throw "output path exists and is not a previous Tetherplane device kit; refusing to delete it: $output"
        }
        Assert-PriorDeviceKitIntegrity -Directory $output
        Remove-Item -LiteralPath $output -Recurse -Force
    }
}

if ($packagingPolicy.RequireTrustedSignature) { $output = $finalOutput + ".staging-" + [Guid]::NewGuid().ToString("N") }
try {
New-Item -ItemType Directory -Force -Path (Join-Path $output "bin"),(Join-Path $output "launch") | Out-Null
if ($packagingPolicy.RequireTrustedSignature) {
    foreach ($relative in $SignedDeviceCodeFiles) {
        Copy-Item -LiteralPath (Join-Path $signedPayload $relative) -Destination (Join-Path $output $relative)
    }
    # Bind staged code to the independently hashed build request before adding
    # package metadata. Retain byte hashes to prove it stays identical through
    # final manifests and publication, when this folder also contains metadata.
    Confirm-WindowsSignedPayload @signingProvenance -SignedPayloadPath $output | Out-Null
    $stagedSignedHashes = @{}
    foreach ($relative in $SignedDeviceCodeFiles) {
        $stagedSignedHashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $output $relative) -Algorithm SHA256).Hash
    }
} else {
    Copy-Item -LiteralPath $TetherdPath -Destination (Join-Path $output "bin\tetherd.exe")
    Copy-Item -LiteralPath (Join-Path $repo "packaging\windows\tetherplane-agent.ps1") -Destination (Join-Path $output "launch\tetherplane-agent.ps1")
    foreach ($script in @("setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1")) {
        Copy-Item -LiteralPath (Join-Path $repo "scripts\$script") -Destination (Join-Path $output $script)
    }
}
Copy-Item -LiteralPath (Join-Path $repo "docs\remote\connection-profile.json") -Destination (Join-Path $output "connection-profile.json")
if ($packagingPolicy.RequireTrustedSignature) {
    foreach ($relative in $SignedDeviceCodeFiles) {
        Assert-TrustedDeviceSignature -Path (Join-Path $output $relative) -ExpectedPublisherSubject $packagingPolicy.ExpectedPublisherSubject -ExpectedSignerThumbprint $packagingPolicy.ExpectedSignerThumbprint | Out-Null
    }
    Assert-SignedPackagingSource
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
if (-not $packagingPolicy.RequireTrustedSignature) {
    [IO.File]::WriteAllText((Join-Path $output "setup.cmd"), "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0setup-windows-device.ps1`" %*`r`n", $utf8NoBom)
}

$readme = @"
Tetherplane device kit (Windows x64, per-user, no build tools needed)

Prerequisite
  This computer must be joined to the same Tailscale tailnet as the Tetherplane
  relay. The agent connects outbound only; no inbound port is opened.

Add this computer
  1. Unzip this kit anywhere and open PowerShell in the folder.
  2. .\setup.cmd -DeviceId <NAME> -Pair
       Installs the agent, creates this computer's credential, and prints a
       device-generated, expiring pairing code.
  3. On VAULTER itself, open the existing authenticated Tetherplane Control
       Center at http://127.0.0.1:8791 (VAULTER loopback, NOT this computer).
       Sign in with the already approved account, open Pairing, enter the code,
       and confirm that you initiated pairing for <NAME>.
       Confirm the relay response names exactly <NAME>; refresh the account
       directory. If approval is unavailable or uncertain, stop and verify.
       Do not use an MCP device tool to approve pairing or export credentials.
  4. .\setup.cmd -DeviceId <NAME> -Finalize
       Only after pairing is verified; starts the per-user background agent.
  5. .\doctor-tetherplane.ps1
       Reports install, relay reachability, pairing, agent and policy status.

Re-running setup is safe: it repairs managed files, keeps your credential and
identity, and never replaces a task or folder it did not create.

This private development kit may contain unsigned code. Do not bypass Smart App
Control to install it. Publicly trusted signed releases require Authenticode,
a verified publisher, and a timestamp before packaging or installation.

New installs start with the least-privilege profile (device.status only, no
allowed folders). Widening access is a deliberate local decision, never done by
setup.
"@
if ($packagingPolicy.RequireTrustedSignature) {
    $readme = @"
Tetherplane signed Windows candidate (x64, per-user)

Source revision: $sourceCommit
All five shipped code files passed the independently approved publisher and
certificate checks before this package's final checksums were produced.

Before running any packaged code, obtain the publisher subject, certificate
thumbprint, source revision, and ZIP SHA-256 from the independently approved
workflow run. Use scripts/verify-windows-device-kit.ps1 from a trusted checkout
with -VerifyOnly -RequireTrustedSignature and those independent values.

Run setup-windows-device.ps1 with -Run, -RequireTrustedSignature,
-ExpectedPublisherSubject, -ExpectedSignerThumbprint and -ExpectedSourceCommit.
Use -Pair for the intended new device. On VAULTER itself, open the approved
local Control Center at http://127.0.0.1:8791; sign in, open Pairing, submit
the generated code with owner confirmation, and verify that the approved device
matches the expected ID in the account directory. The loopback address is local
to VAULTER and is not a portal on this new computer. If approval is uncertain,
stop and inspect before retrying. Only then use -Finalize.
Existing device upgrades preserve local identity and require complete ownership
evidence. No additional OAuth client, token export or MCP approval operation.

The target must already be on the relay's Tailscale tailnet. New devices keep
the device.status-only profile and background_only operation. No credential
is included. Do not disable Smart App Control. Valid Authenticode checks do
not establish Smart App Control acceptance; record live target evidence.
"@
}
[IO.File]::WriteAllText((Join-Path $output "README.txt"), ($readme -replace "`r?`n", "`r`n"), $utf8NoBom)

$manifest = [ordered]@{
    name = "Tetherplane"
    kit = "device-agent"
    version = $Version
    source_commit = $sourceCommit
    source_tree_dirty = $sourceDirty
    platform = "windows"
    architecture = "x64"
    node_runtime_required = $false
    default_mcp_tools = @("device", "files", "process", "browser", "desktop", "batch")
}
if ($packagingPolicy.RequireTrustedSignature) {
    $manifest["signature"] = [ordered]@{
        scheme = "authenticode-public-trust-v2"
        publisher_subject = $packagingPolicy.ExpectedPublisherSubject
        signer_thumbprint = $packagingPolicy.ExpectedSignerThumbprint.ToUpperInvariant()
        signed_files = $SignedDeviceCodeFiles
        signing_request_sha256 = $ExpectedSigningRequestSha256.ToLowerInvariant()
    }
}
[IO.File]::WriteAllText((Join-Path $output "manifest.json"), (($manifest | ConvertTo-Json -Depth 4) + "`n"), $utf8NoBom)

$hashLines = @()
$files = @(Get-ChildItem -LiteralPath $output -Recurse -File | Where-Object { $_.Name -ne "manifest.sha256" } | Sort-Object FullName)
foreach ($file in $files) {
    $relative = $file.FullName.Substring($output.Length + 1).Replace("\", "/")
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashLines += "$hash  $relative"
}
[IO.File]::WriteAllText((Join-Path $output "manifest.sha256"), (($hashLines -join "`n") + "`n"), $utf8NoBom)

if ($packagingPolicy.RequireTrustedSignature) {
    Confirm-DevicePackage -PackagePath $output -RequireTrustedSignature -ExpectedPublisherSubject $packagingPolicy.ExpectedPublisherSubject -ExpectedSignerThumbprint $packagingPolicy.ExpectedSignerThumbprint -ExpectedSourceCommit $packagingPolicy.ExpectedSourceCommit | Out-Null
    foreach ($relative in $SignedDeviceCodeFiles) {
        if ((Get-FileHash -LiteralPath (Join-Path $output $relative) -Algorithm SHA256).Hash -cne $stagedSignedHashes[$relative]) {
            throw "staged code changed after its signing request was verified"
        }
    }
    Assert-SignedPackagingSource
    [IO.Directory]::Move($output, $finalOutput)
    $output = $finalOutput
}

if ($Zip) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipPath = $output + ".zip"

    $zipStream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite)
    $archive = New-Object IO.Compression.ZipArchive($zipStream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath $output -Recurse -File | Sort-Object FullName)) {
            $entryName = $file.FullName.Substring($output.Length + 1).Replace("\", "/")
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally {
        $archive.Dispose()
        $zipStream.Dispose()
    }
    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $shaLine = "$zipHash  " + (Split-Path -Leaf $zipPath) + "`n"
    $shaBytes = $utf8NoBom.GetBytes($shaLine)
    $shaStream = [IO.File]::Open(($zipPath + ".sha256"), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $shaStream.Write($shaBytes, 0, $shaBytes.Length)
    } finally {
        $shaStream.Dispose()
    }
    Write-Output "TETHERPLANE_DEVICE_KIT_ZIP $zipPath"
}
Write-Output "TETHERPLANE_DEVICE_KIT_OK $output"
} finally {
    if ($packagingPolicy.RequireTrustedSignature -and $output -ne $finalOutput -and (Test-Path -LiteralPath $output)) {
        Remove-Item -LiteralPath $output -Recurse -Force
    }
}
