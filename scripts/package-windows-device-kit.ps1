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
    [string]$Version = "0.1.0"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$output = [IO.Path]::GetFullPath($OutputPath)
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
Push-Location $repo
try {
    $sourceCommit = ((git rev-parse HEAD) | Out-String).Trim()
    $sourceDirty = [bool]((git status --porcelain) | Out-String).Trim()
} finally {
    Pop-Location
}
if ($sourceCommit -notmatch "^[0-9a-f]{40}$") {
    throw "could not determine the source commit; build the kit from a Git checkout"
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

New-Item -ItemType Directory -Force -Path (Join-Path $output "bin"),(Join-Path $output "launch") | Out-Null
Copy-Item -LiteralPath $TetherdPath -Destination (Join-Path $output "bin\tetherd.exe")
Copy-Item -LiteralPath (Join-Path $repo "packaging\windows\tetherplane-agent.ps1") -Destination (Join-Path $output "launch\tetherplane-agent.ps1")
foreach ($script in @("setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1")) {
    Copy-Item -LiteralPath (Join-Path $repo "scripts\$script") -Destination (Join-Path $output $script)
}
Copy-Item -LiteralPath (Join-Path $repo "docs\remote\connection-profile.json") -Destination (Join-Path $output "connection-profile.json")

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $output "setup.cmd"), "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0setup-windows-device.ps1`" %*`r`n", $utf8NoBom)

$readme = @"
Tetherplane device kit (Windows x64, per-user, no build tools needed)

Prerequisite
  This computer must be joined to the same Tailscale tailnet as the Tetherplane
  relay. The agent connects outbound only; no inbound port is opened.

Add this computer
  1. Unzip this kit anywhere and open PowerShell in the folder.
  2. .\setup.cmd -DeviceId <NAME> -Pair
       Installs the agent, creates this computer's own credential, and prints an
       expiring approval code plus the exact ChatGPT request to run.
  3. In ChatGPT, using your existing Tetherplane plugin, run the printed
       device(op="approve_pairing", args={userCode:"...", expectedDeviceId:"<NAME>"})
  4. .\setup.cmd -DeviceId <NAME> -Finalize
       Creates the per-user background task and starts it.
  5. .\doctor-tetherplane.ps1
       Reports install, relay reachability, pairing, agent and policy status.

Re-running setup is safe: it repairs managed files, keeps your credential and
identity, and never replaces a task or folder it did not create.

New installs start with the least-privilege profile (device.status only, no
allowed folders). Widening access is a deliberate local decision, never done by
setup.
"@
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
[IO.File]::WriteAllText((Join-Path $output "manifest.json"), (($manifest | ConvertTo-Json -Depth 4) + "`n"), $utf8NoBom)

$hashLines = @()
$files = @(Get-ChildItem -LiteralPath $output -Recurse -File | Where-Object { $_.Name -ne "manifest.sha256" } | Sort-Object FullName)
foreach ($file in $files) {
    $relative = $file.FullName.Substring($output.Length + 1).Replace("\", "/")
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashLines += "$hash  $relative"
}
[IO.File]::WriteAllText((Join-Path $output "manifest.sha256"), (($hashLines -join "`n") + "`n"), $utf8NoBom)

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
