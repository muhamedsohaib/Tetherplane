# Creates a data-only signing request. It never signs or executes payload code.
param(
    [string]$PayloadPath = "",
    [string]$OutputPath = "",
    [string]$SourceCommit = "",
    [string]$RepositoryPath = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "windows-signing-content.ps1")

function Get-WindowsSigningPayloadPaths {
    return @("bin/tetherd.exe", "launch/tetherplane-agent.ps1", "setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1")
}

function Assert-SigningPathNotRedirected {
    param([Parameter(Mandatory = $true)][string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    $current = $full
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "signing path is redirected; refusing access"
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    return $full
}

function Test-SigningPathWithin {
    param([string]$Path, [string]$Root)
    $separator = [IO.Path]::DirectorySeparatorChar
    $prefix = $Root.TrimEnd([char[]]@('/', '\')) + $separator
    return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-WindowsSigningPayloadLayout {
    param([Parameter(Mandatory = $true)][string]$Path)
    $root = Assert-SigningPathNotRedirected -Path $Path
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "signing payload layout requires a directory" }
    $allowed = @(Get-WindowsSigningPayloadPaths)
    $seen = @{}
    # Inspect each directory before enumerating it. Never recursively follow a
    # junction/symlink supplied in a downloaded artifact.
    $pending = New-Object 'System.Collections.Generic.Queue[string]'
    $pending.Enqueue($root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "signing payload contains a redirected path" }
            $relative = $item.FullName.Substring($root.TrimEnd([char[]]@('/', '\')).Length + 1).Replace('\', '/')
            if ($item.PSIsContainer) {
                if (@("bin", "launch") -cnotcontains $relative) { throw "signing payload layout contains an unexpected directory" }
                $pending.Enqueue($item.FullName)
            } else {
                if ($allowed -cnotcontains $relative -or $seen.ContainsKey($relative)) { throw "signing payload layout contains an unexpected or duplicate file" }
                $seen[$relative] = $true
            }
        }
    }
    if ($seen.Count -ne $allowed.Count) { throw "signing payload layout is missing an expected file" }
    return $root
}

function Get-SigningFileHash {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-SigningObjectProperties {
    param($Object, [string[]]$Names, [string]$Message)
    if ($null -eq $Object -or $Object -isnot [pscustomobject]) { throw $Message }
    $actual = @($Object.PSObject.Properties.Name)
    if ($actual.Count -ne $Names.Count) { throw $Message }
    foreach ($name in $actual) { if ($Names -cnotcontains $name) { throw $Message } }
}

function Read-WindowsSigningRequest {
    param(
        [Parameter(Mandatory = $true)][string]$RequestPath,
        [Parameter(Mandatory = $true)][string]$ExpectedRequestSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedSourceCommit,
        [Parameter(Mandatory = $true)][string]$PayloadPath
    )
    if ($ExpectedRequestSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "signing request hash must be an independently supplied SHA-256" }
    if ($ExpectedSourceCommit -notmatch '^[a-fA-F0-9]{40}$') { throw "signing source revision must be a full commit SHA" }
    $path = Assert-SigningPathNotRedirected -Path $RequestPath
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or $item.Length -gt 65536) { throw "signing request schema is invalid or oversized" }
    # Parse the exact bytes that were hashed, not a second read of the request.
    $bytes = [IO.File]::ReadAllBytes($path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($hash -ne $ExpectedRequestSha256) { throw "signing request hash does not match independent build evidence" }
    try { $request = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } catch { throw "signing request schema is not valid JSON" }
    Assert-SigningObjectProperties $request @("schema", "source_commit", "files") "signing request schema contains missing or unexpected properties"
    if ($request.schema -cne "tetherplane-windows-signing-request-v2") { throw "signing request schema is unsupported" }
    if ($request.source_commit -isnot [string] -or $request.source_commit -notmatch '^[a-fA-F0-9]{40}$' -or $request.source_commit -ne $ExpectedSourceCommit) {
        throw "signing request source revision does not match independent build evidence"
    }
    $allowed = @(Get-WindowsSigningPayloadPaths)
    if ($request.files -isnot [array] -or $request.files.Count -ne $allowed.Count) { throw "signing request file list is incomplete" }
    $seen = @{}
    foreach ($file in $request.files) {
        Assert-SigningObjectProperties $file @("path", "sha256", "sip_sha256") "signing request file list contains malformed entries"
        if ($file.path -isnot [string] -or $allowed -cnotcontains $file.path -or $seen.ContainsKey($file.path)) { throw "signing request file list contains duplicate or unexpected paths" }
        if ($file.sha256 -isnot [string] -or $file.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "signing request file list contains an invalid hash" }
        if ($file.sip_sha256 -isnot [string] -or $file.sip_sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "signing request file list contains an invalid SIP content digest" }
        $seen[$file.path] = $true
    }
    $root = Assert-WindowsSigningPayloadLayout -Path $PayloadPath
    foreach ($file in $request.files) {
        if ((Get-SigningFileHash -Path (Join-Path $root $file.path)) -ne $file.sha256) { throw "signing payload hash differs from the approved request" }
        if ((Get-WindowsSigningContentDigest -Path (Join-Path $root $file.path)) -ne $file.sip_sha256) { throw "signing payload content digest differs from the approved request" }
    }
    return $request
}

function Confirm-WindowsSignedPayload {
    param(
        [Parameter(Mandatory = $true)][string]$RequestPath,
        [Parameter(Mandatory = $true)][string]$ExpectedRequestSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedSourceCommit,
        [Parameter(Mandatory = $true)][string]$UnsignedPayloadPath,
        [Parameter(Mandatory = $true)][string]$SignedPayloadPath
    )
    $request = Read-WindowsSigningRequest -RequestPath $RequestPath -ExpectedRequestSha256 $ExpectedRequestSha256 -ExpectedSourceCommit $ExpectedSourceCommit -PayloadPath $UnsignedPayloadPath
    $signed = Assert-WindowsSigningPayloadLayout -Path $SignedPayloadPath
    foreach ($file in $request.files) {
        if ((Get-WindowsSigningContentDigest -Path (Join-Path $signed $file.path)) -ne $file.sip_sha256) { throw "signed payload content digest differs from the approved source request" }
    }
    return [pscustomobject]@{ source_commit = $request.source_commit; file_count = $request.files.Count; content_verified = $true }
}

function New-WindowsSigningRequest {
    param(
        [Parameter(Mandatory = $true)][string]$PayloadPath,
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [Parameter(Mandatory = $true)][string]$SourceCommit,
        [Parameter(Mandatory = $true)][string]$RepositoryPath
    )
    if ($SourceCommit -notmatch '^[a-fA-F0-9]{40}$') { throw "signing source revision must be a full commit SHA" }
    $repository = Assert-SigningPathNotRedirected -Path $RepositoryPath
    $commit = ((& git -C $repository rev-parse --verify HEAD 2>$null) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -ne $SourceCommit) { throw "signing source revision does not match the checkout" }
    $dirty = ((& git -C $repository status --porcelain --untracked-files=all 2>$null) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw "signing requires a clean checkout, including untracked files" }
    $root = Assert-WindowsSigningPayloadLayout -Path $PayloadPath
    $output = Assert-SigningPathNotRedirected -Path $OutputPath
    if (Test-SigningPathWithin $output $root) { throw "signing request output must not overlap the payload" }
    if (Test-Path -LiteralPath $output) { throw "signing request output already exists" }
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $output) -PathType Container)) { throw "signing request output parent is missing" }
    $entries = @(foreach ($relative in @(Get-WindowsSigningPayloadPaths)) {
        $hash = Get-SigningFileHash -Path (Join-Path $root $relative)
        if ($relative -ne "bin/tetherd.exe") {
            $sourceRelative = if ($relative -eq "launch/tetherplane-agent.ps1") { "packaging/windows/tetherplane-agent.ps1" } else { "scripts/$relative" }
            $source = Assert-SigningPathNotRedirected -Path (Join-Path $repository $sourceRelative)
            if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or (Get-SigningFileHash -Path $source) -ne $hash) { throw "signing source script does not match the reviewed checkout" }
        }
        [ordered]@{ path = $relative; sha256 = $hash; sip_sha256 = (Get-WindowsSigningContentDigest -Path (Join-Path $root $relative)) }
    })
    $request = [ordered]@{ schema = "tetherplane-windows-signing-request-v2"; source_commit = $commit.ToLowerInvariant(); files = $entries }
    $utf8 = New-Object Text.UTF8Encoding($false)
    $bytes = $utf8.GetBytes(($request | ConvertTo-Json -Depth 5) + "`n")
    $stream = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    [pscustomobject]@{ request_path = $output; request_sha256 = (Get-SigningFileHash -Path $output); source_commit = $request.source_commit; file_count = $entries.Count }
}

if ($MyInvocation.InvocationName -ne '.') {
    New-WindowsSigningRequest -PayloadPath $PayloadPath -OutputPath $OutputPath -SourceCommit $SourceCommit -RepositoryPath $RepositoryPath
}
