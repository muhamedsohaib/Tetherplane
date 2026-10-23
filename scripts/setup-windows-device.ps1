# Tetherplane device setup entrypoint (Windows, per-user, managed install)
#
# End-to-end flow on a NEW controlled computer:
#   verify package -> managed install -> local identity -> pair (explicit) ->
#   owner approval via the connected ChatGPT plugin -> finalize agent task.
#
# New installs receive an explicit least-privilege launch-bound principal
# (device.status acceptance only). Existing principals are never rewritten.
# resolved by the caller.
param(
    [switch]$Run,
    [string]$PackagePath = "",
    [string]$DeviceId = "",
    [string]$InstallPrefix = "",
    [string]$StateDir = "",
    [string]$RelayUrl = "wss://vaulter.tailf65eba.ts.net:10000/device",
    [string]$PairingOrigin = "https://vaulter.tailf65eba.ts.net",
    [string]$ExpectedPublisherSubject = "",
    [string]$ExpectedSignerThumbprint = "",
    [string]$ExpectedSourceCommit = "",
    [switch]$RequireTrustedSignature,
    [switch]$Pair,
    [switch]$Finalize
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 can inherit a PowerShell 7 PSModulePath (for example
# when launched from a pwsh terminal) and then autoload incompatible core
# modules. Repin to Windows PowerShell's own module directories for this
# process only when a foreign-version core module would be resolved.
if ($PSVersionTable.PSEdition -eq "Desktop") {
    $coreModuleNames = @("Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Management", "Microsoft.PowerShell.Security")
    $foreignCore = @(Get-Module -ListAvailable -Name $coreModuleNames | Where-Object { $_.Version.Major -ne 3 })
    if ($foreignCore.Count -gt 0) {
        $env:PSModulePath = "$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\system32\WindowsPowerShell\v1.0\Modules"
        foreach ($coreName in $coreModuleNames) {
            $loaded = Get-Module -Name $coreName
            if ($loaded -and $loaded.Version.Major -ne 3) { Remove-Module -Name $coreName -Force -ErrorAction SilentlyContinue }
        }
        foreach ($coreName in $coreModuleNames) { Import-Module -Name $coreName -ErrorAction Stop }
    }
}

$ManagedFiles = @(
    "bin\tetherd.exe",
    "launch\tetherplane-agent.ps1",
    "manifest.json",
    "setup-windows-device.ps1",
    "pair-windows-device.ps1",
    "doctor-tetherplane.ps1",
    "connection-profile.json"
)

# Every file that the device kit executes must carry the approved signature.
# Signed kits do not ship an unsigned setup.cmd bootstrap.
$SignedDeviceCodeFiles = @(
    "bin/tetherd.exe", "launch/tetherplane-agent.ps1",
    "setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1"
)

function Write-Utf8NoBomJson {
    param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$LiteralPath)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText(
        $LiteralPath,
        (($Value | ConvertTo-Json -Depth 6) + "`n"),
        $utf8NoBom
    )
}


function Assert-DevicePathNotRedirected {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $current = [IO.Path]::GetFullPath($LiteralPath)
    $root = [IO.Path]::GetPathRoot($current)
    while ($current) {
        $item = $null
        try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch [System.Management.Automation.ItemNotFoundException] { }
        if ($item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "refusing redirected device path (reparse point): $current"
        }
        if ($current -eq $root) { break }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-ManagedDeviceDestinations {
    param([Parameter(Mandatory = $true)][string]$InstallPrefix)
    Assert-DevicePathNotRedirected -LiteralPath $InstallPrefix
    Assert-DevicePathNotRedirected -LiteralPath (Join-Path $InstallPrefix "config\install.json")
    Assert-DevicePathNotRedirected -LiteralPath (Join-Path $InstallPrefix "config\agent-args.json")
    foreach ($file in $ManagedFiles) {
        Assert-DevicePathNotRedirected -LiteralPath (Join-Path $InstallPrefix $file)
    }
}

function Confirm-ManagedDeviceReceipt {
    param([Parameter(Mandatory = $true)][string]$InstallPrefix)
    $install = Get-ManagedDeviceInstallPath -InstallPrefix $InstallPrefix
    $receiptPath = Join-Path $install "config\install.json"
    Assert-DevicePathNotRedirected -LiteralPath $receiptPath
    try {
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        if ([string]$receipt.managed_by -cne "setup-windows-device.ps1") { throw "foreign receipt" }
        $recorded = [IO.Path]::GetFullPath([string]$receipt.install_prefix).TrimEnd([IO.Path]::DirectorySeparatorChar)
        if ($recorded -ine $install.TrimEnd([IO.Path]::DirectorySeparatorChar)) { throw "receipt prefix mismatch" }
    } catch { throw "install receipt does not prove ownership of this prefix; refusing repair: $install" }
    if ($null -eq $receipt.PSObject.Properties["receipt_version"] -or $receipt.receipt_version -ne 2 -or
        $null -eq $receipt.PSObject.Properties["managed_files"] -or $null -eq $receipt.PSObject.Properties["signature_policy"]) {
        throw "legacy install receipt lacks complete file ownership evidence; preserve a backup and use the reviewed legacy migration procedure before repair: $install"
    }
    $hashes = $receipt.managed_files
    if ($null -eq $hashes -or @($hashes.PSObject.Properties).Count -ne $ManagedFiles.Count) { throw "install receipt has incomplete managed-file ownership evidence: $install" }
    foreach ($relative in $ManagedFiles) {
        $key = $relative.Replace("\", "/")
        $entry = $hashes.PSObject.Properties[$key]
        if ($null -eq $entry -or [string]$entry.Value -cnotmatch "^[a-f0-9]{64}$") { throw "install receipt has invalid managed-file ownership evidence: $key" }
        $currentHash = Get-ManagedDeviceFileHash -LiteralPath (Join-Path $install $relative)
        if ($currentHash -and $currentHash -cne [string]$entry.Value) { throw "managed file was locally modified; preserve it and review the backup before repair: $relative" }
    }
    $policy = $receipt.signature_policy
    if ($null -eq $policy -or $null -eq $policy.PSObject.Properties["require_trusted_signature"] -or
        $policy.require_trusted_signature -isnot [bool] -or $null -eq $policy.PSObject.Properties["expected_publisher_subject"] -or
        $null -eq $policy.PSObject.Properties["expected_signer_thumbprint"]) { throw "install receipt has an invalid signing policy" }
    if ($policy.require_trusted_signature) {
        if ([string]::IsNullOrWhiteSpace([string]$policy.expected_publisher_subject) -or [string]$policy.expected_signer_thumbprint -cnotmatch "^[A-F0-9]{40}$") { throw "signed install receipt lacks its independently approved signing identity" }
    } elseif ($policy.expected_publisher_subject -or $policy.expected_signer_thumbprint) { throw "install receipt has inconsistent signing requirements" }
    return $receipt
}

function Get-CurrentUserSid {
    return ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
}

function Assert-TrustedDeviceSignature {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedPublisherSubject,
        [string]$ExpectedSignerThumbprint = "",
        [string]$SignToolPath = ""
    )
    if ([string]::IsNullOrWhiteSpace($ExpectedPublisherSubject)) {
        throw "trusted signing requires an independently approved publisher subject"
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "signed agent binary is missing: $Path"
    }
    $file = Get-Item -LiteralPath $Path -Force
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "refusing redirected signed agent binary: $Path"
    }
    Assert-DevicePathNotRedirected -LiteralPath $file.FullName
    if ($SignToolPath) {
        if (-not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) {
            throw "SignTool verification failed: the approved Windows SDK verifier is missing"
        }
        # /tw alone warns about a missing timestamp. Accept only exit zero,
        # including when Windows metadata would otherwise report Valid.
        try {
            & $SignToolPath verify /pa /all /tw $file.FullName *> $null
            if ($LASTEXITCODE -ne 0) { throw "nonzero verification result" }
        } catch {
            throw "SignTool verification failed; release signatures and timestamps must pass without warnings"
        }
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ([string]$signature.Status -cne "Valid") {
        throw "agent Authenticode signature is not trusted: $($signature.Status)"
    }
    if ([string]$signature.SignatureType -cne "Authenticode") {
        throw "agent requires an embedded Authenticode signature, not a catalog signature"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "trusted signing has no publisher certificate"
    }
    $subject = [string]$signature.SignerCertificate.Subject
    if ($subject -cne $ExpectedPublisherSubject) {
        throw "agent publisher does not match the independently approved signer identity"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "trusted agent signature is missing a verified timestamp certificate"
    }
    $thumbprint = ([string]$signature.SignerCertificate.Thumbprint).ToUpperInvariant()
    if ($thumbprint -notmatch "^[A-F0-9]{40}$") {
        throw "trusted agent signature has an invalid signer thumbprint"
    }
    if ($ExpectedSignerThumbprint -and $thumbprint -cne $ExpectedSignerThumbprint.ToUpperInvariant()) {
        throw "trusted agent signature does not match the expected signer thumbprint"
    }
    $hasSigningUsage = $false
    if ($signature.SignerCertificate.PSObject.Properties["Extensions"]) {
        foreach ($extension in @($signature.SignerCertificate.Extensions)) {
            if ($extension.Oid.Value -eq "2.5.29.37") {
                foreach ($usage in @($extension.EnhancedKeyUsages)) {
                    if ($usage.Value -eq "1.3.6.1.5.5.7.3.3") { $hasSigningUsage = $true }
                }
            }
        }
    }
    if (-not $hasSigningUsage) {
        throw "trusted publisher certificate is missing explicit code-signing usage"
    }
    # Windows makes the timestamp-aware trust decision. Do not reject a valid
    # timestamped file merely because its signing certificate has expired now.
    return [pscustomobject]@{
        signer_subject = $subject
        signer_thumbprint = $thumbprint
        timestamp_subject = [string]$signature.TimeStamperCertificate.Subject
    }
}

function Confirm-DevicePackage {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [string]$ExpectedPublisherSubject = "",
        [string]$ExpectedSignerThumbprint = "",
        [switch]$RequireTrustedSignature,
        [string]$ExpectedSourceCommit = "",
        [string]$SignToolPath = ""
    )
    $package = [IO.Path]::GetFullPath($PackagePath)
    Assert-DevicePathNotRedirected -LiteralPath $package
    $manifestPath = Join-Path $package "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "package manifest is missing: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($field in @("name", "version", "platform", "architecture", "default_mcp_tools")) {
        if (-not $manifest.$field) { throw "package manifest is missing required field: $field" }
    }
    if (-not [string]$manifest.source_commit) {
        throw "package manifest is missing source commit evidence"
    }
    if ($ExpectedSourceCommit -and ($ExpectedSourceCommit -notmatch "^[a-fA-F0-9]{40}$" -or
        [string]$manifest.source_commit -ine $ExpectedSourceCommit)) {
        throw "package source revision differs from the independently selected source revision"
    }
    if ([string]$manifest.platform -ne "windows") {
        throw "package platform is $($manifest.platform); this setup supports windows packages only"
    }
    if ([string]$manifest.architecture -ne "x64") {
        throw "package architecture is $($manifest.architecture); this computer requires an x64 package"
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw "this computer is not running a 64-bit OS; refusing an x64 package"
    }
    $expectedTools = @("batch", "browser", "desktop", "device", "files", "process")
    $actualTools = @($manifest.default_mcp_tools | Sort-Object)
    $toolDiff = @(Compare-Object $actualTools $expectedTools)
    if ($toolDiff.Count -ne 0) {
        throw "package default tool surface differs from the canonical six tools"
    }
    $hashPath = Join-Path $package "manifest.sha256"
    if (-not (Test-Path -LiteralPath $hashPath -PathType Leaf)) {
        throw "package hash manifest is missing: manifest.sha256 is required"
    }
    $covered = @{}
    foreach ($line in (Get-Content -LiteralPath $hashPath)) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        $parts = $trimmed -split "\s+", 2
        if ($parts.Count -ne 2 -or $parts[0] -notmatch "^[a-fA-F0-9]{64}$") { throw "package hash manifest is malformed" }
        $rel = $parts[1] -replace "/", "\"
        if ([IO.Path]::IsPathRooted($rel) -or $rel.StartsWith("\") -or $rel -match "(^|\\)\.\.(\\|$)" -or $rel.Contains(":")) {
            throw "package hash manifest rejects unsafe entry: $($parts[1])"
        }
        if ($covered.ContainsKey($rel)) { throw "package hash manifest has a duplicate entry" }
        $target = Join-Path $package $rel
        Assert-DevicePathNotRedirected -LiteralPath $target
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "package hash manifest lists a missing file: $($parts[1])"
        }
        $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $parts[0].ToLowerInvariant()) {
            throw "package integrity failure: $($parts[1]) does not match its recorded SHA-256"
        }
        $covered[$rel] = $true
    }
    foreach ($required in $ManagedFiles) {
        if (-not $covered[$required]) {
            throw "package hash manifest does not cover required kit file: $required"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $package $required))) {
            throw "package is missing required artifact: $required"
        }
    }
    $trustedSignatureVerified = $false
    $signatureField = $manifest.PSObject.Properties["signature"]
    $mustBeSigned = $RequireTrustedSignature -or -not [string]::IsNullOrEmpty($ExpectedPublisherSubject) -or -not [string]::IsNullOrEmpty($ExpectedSignerThumbprint)
    if ($mustBeSigned -and $null -eq $signatureField) {
        throw "required signing metadata is missing; refusing an unsigned development kit"
    }
    if ($null -ne $signatureField) {
        if ([string]::IsNullOrWhiteSpace($ExpectedPublisherSubject)) { throw "signed device kits require an independently confirmed -ExpectedPublisherSubject" }
        if ($ExpectedSignerThumbprint -notmatch "^[a-fA-F0-9]{40}$") { throw "signed device kits require an independently approved signer thumbprint" }
        $claimed = $signatureField.Value
        if ($null -eq $claimed -or [string]$claimed.scheme -cne "authenticode-public-trust-v2") {
            throw "device-kit signing scheme is not recognized"
        }
        if ([string]::IsNullOrWhiteSpace([string]$claimed.publisher_subject) -or
            [string]$claimed.signer_thumbprint -notmatch "^[a-fA-F0-9]{40}$") {
            throw "device-kit signed publisher or thumbprint metadata is incomplete"
        }
        if ([string]$claimed.publisher_subject -cne $ExpectedPublisherSubject) { throw "signed kit publisher differs from the independently confirmed expected publisher" }
        if ([string]$claimed.signer_thumbprint -ine $ExpectedSignerThumbprint) { throw "signed kit certificate differs from the independently approved signer thumbprint" }
        if ([string]$manifest.source_commit -notmatch "^[a-fA-F0-9]{40}$" -or
            -not $manifest.PSObject.Properties["source_tree_dirty"] -or
            $manifest.source_tree_dirty -isnot [bool] -or $manifest.source_tree_dirty) {
            throw "signed candidates require an identified clean source checkout"
        }
        if (-not $claimed.PSObject.Properties["signed_files"] -or
            @($claimed.signed_files).Count -ne $SignedDeviceCodeFiles.Count -or
            @(Compare-Object -CaseSensitive @($claimed.signed_files | Sort-Object) @($SignedDeviceCodeFiles | Sort-Object)).Count -ne 0) {
            throw "signed-file declaration must cover every executable and PowerShell script"
        }
        $allowedSignedFiles = @($ManagedFiles | ForEach-Object { $_.Replace("\", "/") }) + @("manifest.sha256", "README.txt")
        foreach ($entry in @(Get-ChildItem -LiteralPath $package -Recurse -Force)) {
            Assert-DevicePathNotRedirected -LiteralPath $entry.FullName
            if (-not $entry.PSIsContainer) {
                $relative = $entry.FullName.Substring($package.TrimEnd("\", "/").Length + 1).Replace("\", "/")
                if ($allowedSignedFiles -cnotcontains $relative) { throw "signed kit contains an unexpected file: $relative" }
            }
        }
        foreach ($relative in $SignedDeviceCodeFiles) {
            $checked = Assert-TrustedDeviceSignature -Path (Join-Path $package $relative) -ExpectedPublisherSubject $ExpectedPublisherSubject -ExpectedSignerThumbprint $ExpectedSignerThumbprint -SignToolPath $SignToolPath
        }
        $trustedSignatureVerified = $true
    }
    return [ordered]@{
        ok = $true
        name = [string]$manifest.name
        version = [string]$manifest.version
        source_commit = [string]$manifest.source_commit
        trusted_signature_verified = $trustedSignatureVerified
    }
}

function Get-ManagedDeviceInstallPath {
    param([Parameter(Mandatory = $true)][string]$InstallPrefix)
    $full = [IO.Path]::GetFullPath($InstallPrefix)
    if ($full -eq [IO.Path]::GetPathRoot($full)) { throw "install prefix must be a dedicated directory rather than a filesystem root" }
    return $full.TrimEnd([char[]]"\/")
}

function Get-ManagedDeviceFileHash {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    Assert-DevicePathNotRedirected -LiteralPath $LiteralPath
    $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return "" }
    if ($item.PSIsContainer) { throw "managed file path is occupied by a directory: $LiteralPath" }
    return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ManagedDeviceSnapshot {
    param([Parameter(Mandatory = $true)][string]$InstallPrefix)
    $snapshot = [ordered]@{}
    foreach ($relative in @($ManagedFiles) + @("config\install.json")) {
        $key = $relative.Replace("\", "/")
        $snapshot[$key] = Get-ManagedDeviceFileHash -LiteralPath (Join-Path $InstallPrefix $relative)
    }
    return $snapshot
}

function Assert-ManagedDeviceSnapshot {
    param([Parameter(Mandatory = $true)][string]$InstallPrefix, [Parameter(Mandatory = $true)]$Snapshot)
    foreach ($key in $Snapshot.Keys) {
        $path = Join-Path $InstallPrefix $key
        if ((Get-ManagedDeviceFileHash -LiteralPath $path) -cne [string]$Snapshot[$key]) {
            throw "resource_conflict: managed file was modified during the update: $path"
        }
    }
}

function Assert-ManagedUpgradeRecovery {
    param([Parameter(Mandatory = $true)][string]$InstallPrefix)
    $recovery = $InstallPrefix + ".tetherplane-upgrades"
    Assert-DevicePathNotRedirected -LiteralPath $recovery
    if (-not (Test-Path -LiteralPath $recovery)) { return }
    if (-not (Test-Path -LiteralPath $recovery -PathType Container)) {
        throw "unrecognized recovery path; preserve it and choose another installation prefix: $recovery"
    }
    try {
        $ownerPath = Join-Path $recovery "owner.json"
        Assert-DevicePathNotRedirected -LiteralPath $ownerPath
        $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
        if ([string]$owner.managed_by -cne "setup-windows-device.ps1" -or [string]$owner.install_prefix -cne $InstallPrefix) { throw "foreign recovery directory" }
    } catch { throw "recovery directory ownership cannot be established; preserve it for manual inspection: $recovery" }
    foreach ($entry in @(Get-ChildItem -LiteralPath $recovery -Force)) {
        if ($entry.Name -ceq "owner.json") { continue }
        if (-not $entry.PSIsContainer -or $entry.Name -cnotmatch "^upgrade-[a-f0-9]{32}$") {
            throw "unrecognized recovery entry; preserve it for manual inspection: $($entry.FullName)"
        }
        Assert-DevicePathNotRedirected -LiteralPath $entry.FullName
        try {
            $journalPath = Join-Path $entry.FullName "journal.json"
            Assert-DevicePathNotRedirected -LiteralPath $journalPath
            $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
            if ([string]$journal.managed_by -cne "setup-windows-device.ps1" -or [string]$journal.install_prefix -cne $InstallPrefix -or
                @("committed", "rolled_back") -cnotcontains [string]$journal.status) { throw "unfinished update" }
            # A process can stop after an atomic replacement but before its
            # displaced bytes have been checked or the journal corrected.
            # The expected digest in each retained filename survives that gap.
            $displaced = Join-Path $entry.FullName "displaced"
            Assert-DevicePathNotRedirected -LiteralPath $displaced
            if (Test-Path -LiteralPath $displaced) {
                if (-not (Test-Path -LiteralPath $displaced -PathType Container)) { throw "invalid displacement evidence" }
                foreach ($retained in @(Get-ChildItem -LiteralPath $displaced -Force)) {
                    if ($retained.PSIsContainer -or $retained.Name -cnotmatch '^([a-f0-9]{64})-[a-f0-9]{32}\.bak$') { throw "unrecognized displacement evidence" }
                    $expectedDisplacedHash = $Matches[1]
                    if ((Get-ManagedDeviceFileHash -LiteralPath $retained.FullName) -cne $expectedDisplacedHash) { throw "unexpected displaced write" }
                }
            }
        } catch { throw "an interrupted or conflicted update requires recovery before another repair; inspect the retained journal and backup: $($entry.FullName)" }
    }
}

function New-ManagedUpgradeRetainedPath {
    param([Parameter(Mandatory = $true)][string]$RecoveryDirectory, [Parameter(Mandatory = $true)][string]$ExpectedHash)
    if ($ExpectedHash -cnotmatch '^[a-f0-9]{64}$') { throw "retained files require a verified expected digest" }
    $directory = Join-Path $RecoveryDirectory "displaced"
    Assert-DevicePathNotRedirected -LiteralPath $directory
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null }
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "recovery displacement path is not a directory: $directory" }
    return Join-Path $directory ($ExpectedHash + "-" + [Guid]::NewGuid().ToString("N") + ".bak")
}

function Assert-ManagedUpgradeRetainedFile {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$ExpectedHash,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string]$ReplacementHash = ""
    )
    $actualHash = ""
    try { $actualHash = Get-ManagedDeviceFileHash -LiteralPath $LiteralPath } catch { }
    if ($actualHash -cne $ExpectedHash) {
        $failure = New-Object System.InvalidOperationException("resource_conflict: unexpected displaced bytes were preserved at: $LiteralPath")
        $failure.Data["TetherplaneRetainedPath"] = $LiteralPath
        $failure.Data["TetherplaneDestination"] = $Destination
        $failure.Data["TetherplaneReplacementHash"] = $ReplacementHash
        throw $failure
    }
}

function Get-ManagedUpgradeRecoveryConflict {
    param([Parameter(Mandatory = $true)][System.Exception]$Exception)
    for ($cause = $Exception; $null -ne $cause; $cause = $cause.InnerException) {
        if ($cause.Data.Contains("TetherplaneRetainedPath")) {
            return [ordered]@{
                retained_path = [string]$cause.Data["TetherplaneRetainedPath"]
                destination = [string]$cause.Data["TetherplaneDestination"]
                replacement_hash = [string]$cause.Data["TetherplaneReplacementHash"]
            }
        }
    }
    return $null
}

function Write-ManagedUpgradeJournal {
    param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$LiteralPath, [string]$ExpectedHash = "")
    if ((Get-ManagedDeviceFileHash -LiteralPath $LiteralPath) -cne $ExpectedHash) {
        throw "resource_conflict: recovery journal changed during the update: $LiteralPath"
    }
    $temporary = $LiteralPath + "." + [Guid]::NewGuid().ToString("N") + ".tmp"
    Write-Utf8NoBomJson -Value $Value -LiteralPath $temporary
    $writtenHash = Get-ManagedDeviceFileHash -LiteralPath $temporary
    if ((Get-ManagedDeviceFileHash -LiteralPath $LiteralPath) -cne $ExpectedHash) {
        throw "resource_conflict: recovery journal changed during the update: $LiteralPath"
    }
    if ($ExpectedHash) {
        $retained = New-ManagedUpgradeRetainedPath -RecoveryDirectory (Split-Path -Parent $LiteralPath) -ExpectedHash $ExpectedHash
        [IO.File]::Replace($temporary, $LiteralPath, $retained)
        Assert-ManagedUpgradeRetainedFile -LiteralPath $retained -ExpectedHash $ExpectedHash -Destination $LiteralPath -ReplacementHash $writtenHash
    } else { [IO.File]::Move($temporary, $LiteralPath) }
    # Return the bytes we wrote, never silently adopt a later human edit.
    return $writtenHash
}

function Copy-ManagedDeviceFileAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$SourceHash,
        [Parameter(Mandatory = $true)][string]$RecoveryDirectory,
        [string]$ExpectedHash = ""
    )
    if ((Get-ManagedDeviceFileHash -LiteralPath $Source) -cne $SourceHash) { throw "staged or backup file was modified: $Source" }
    if ((Get-ManagedDeviceFileHash -LiteralPath $Destination) -cne $ExpectedHash) { throw "resource_conflict: destination was modified: $Destination" }
    $temporary = $Destination + ".tp-" + [Guid]::NewGuid().ToString("N") + ".tmp"
    try {
        Copy-Item -LiteralPath $Source -Destination $temporary -ErrorAction Stop
        if ((Get-ManagedDeviceFileHash -LiteralPath $temporary) -cne $SourceHash) { throw "candidate copy integrity failure: $Destination" }
        if ((Get-ManagedDeviceFileHash -LiteralPath $Destination) -cne $ExpectedHash) { throw "resource_conflict: destination was modified before replacement: $Destination" }
        if ($ExpectedHash) {
            $retained = New-ManagedUpgradeRetainedPath -RecoveryDirectory $RecoveryDirectory -ExpectedHash $ExpectedHash
            [IO.File]::Replace($temporary, $Destination, $retained)
            Assert-ManagedUpgradeRetainedFile -LiteralPath $retained -ExpectedHash $ExpectedHash -Destination $Destination -ReplacementHash $SourceHash
        } else { [IO.File]::Move($temporary, $Destination) }
    } finally {
        # Retain an unconsumed temporary file atomically as well: checking its
        # hash and then deleting it has the same late-write race as replacement.
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Assert-DevicePathNotRedirected -LiteralPath $temporary
            $retained = New-ManagedUpgradeRetainedPath -RecoveryDirectory $RecoveryDirectory -ExpectedHash $SourceHash
            [IO.File]::Move($temporary, $retained)
            Assert-ManagedUpgradeRetainedFile -LiteralPath $retained -ExpectedHash $SourceHash -Destination $temporary
        }
    }
}

function Write-InstallReceipt {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$InstallPrefix,
        [string]$ExpectedPublisherSubject = "",
        [string]$ExpectedSignerThumbprint = "",
        [switch]$RequireTrustedSignature,
        [string]$ExpectedSourceCommit = "",
        [string]$InstalledFileRoot = "",
        [string]$ReceiptPath = ""
    )
    $install = Get-ManagedDeviceInstallPath -InstallPrefix $InstallPrefix
    if (-not $InstalledFileRoot) { $InstalledFileRoot = $install }
    if (-not $ReceiptPath) { $ReceiptPath = Join-Path $install "config\install.json" }
    $proof = Confirm-DevicePackage -PackagePath $PackagePath -ExpectedPublisherSubject $ExpectedPublisherSubject -ExpectedSignerThumbprint $ExpectedSignerThumbprint -RequireTrustedSignature:$RequireTrustedSignature -ExpectedSourceCommit $ExpectedSourceCommit
    $hashes = [ordered]@{}
    foreach ($relative in $ManagedFiles) {
        $digest = Get-ManagedDeviceFileHash -LiteralPath (Join-Path $InstalledFileRoot $relative)
        if (-not $digest) { throw "managed install failed: a required file is missing after copy: $relative" }
        if ($digest -cne (Get-ManagedDeviceFileHash -LiteralPath (Join-Path $PackagePath $relative))) { throw "managed install integrity failure: $relative differs from the verified candidate" }
        $hashes[$relative.Replace("\", "/")] = $digest
    }
    $receipt = [ordered]@{
        receipt_version = 2
        install_prefix = $install
        managed_by = "setup-windows-device.ps1"
        source_commit = $proof.source_commit
        tetherd_sha256 = $hashes["bin/tetherd.exe"]
        managed_files = $hashes
        signature_policy = [ordered]@{
            require_trusted_signature = [bool]$proof.trusted_signature_verified
            expected_publisher_subject = if ($proof.trusted_signature_verified) { $ExpectedPublisherSubject } else { "" }
            expected_signer_thumbprint = if ($proof.trusted_signature_verified) { $ExpectedSignerThumbprint.ToUpperInvariant() } else { "" }
        }
    }
    Assert-DevicePathNotRedirected -LiteralPath $ReceiptPath
    Write-Utf8NoBomJson -Value $receipt -LiteralPath $ReceiptPath
}

function Invoke-ManagedDeviceUpdate {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$InstallPrefix,
        [string]$ExpectedPublisherSubject = "",
        [string]$ExpectedSignerThumbprint = "",
        [switch]$RequireTrustedSignature,
        [string]$ExpectedSourceCommit = "",
        [switch]$ExistingOnly
    )
    $package = [IO.Path]::GetFullPath($PackagePath)
    $install = Get-ManagedDeviceInstallPath -InstallPrefix $InstallPrefix
    Assert-ManagedDeviceDestinations -InstallPrefix $install
    Assert-ManagedUpgradeRecovery -InstallPrefix $install
    $receiptPath = Join-Path $install "config\install.json"
    $hasReceipt = Test-Path -LiteralPath $receiptPath -PathType Leaf
    # Capture the installed bytes before verifying a possibly slow candidate.
    # A later snapshot must not silently adopt a concurrent human change.
    $before = Get-ManagedDeviceSnapshot -InstallPrefix $install
    $existingReceipt = $null
    if ($hasReceipt) {
        $existingReceipt = Confirm-ManagedDeviceReceipt -InstallPrefix $install
        foreach ($relative in $ManagedFiles) {
            $key = $relative.Replace("\", "/")
            if ($before[$key] -and $before[$key] -cne [string]$existingReceipt.managed_files.$key) {
                throw "resource_conflict: managed file was modified while its receipt was being verified: $relative"
            }
        }
    }
    elseif ($ExistingOnly) { throw "repair requires a managed install receipt: $receiptPath" }
    elseif ((Test-Path -LiteralPath $install) -and @(Get-ChildItem -LiteralPath $install -Force).Count -gt 0) {
        throw "install prefix holds files this setup did not install; refusing to touch an unmanaged prefix: $install"
    }
    if ($existingReceipt -and $existingReceipt.signature_policy.require_trusted_signature) {
        $savedPolicy = $existingReceipt.signature_policy
        if (($ExpectedPublisherSubject -and $ExpectedPublisherSubject -cne [string]$savedPolicy.expected_publisher_subject) -or
            ($ExpectedSignerThumbprint -and $ExpectedSignerThumbprint.ToUpperInvariant() -cne [string]$savedPolicy.expected_signer_thumbprint)) {
            throw "signed install identity differs from the requested signing policy; preserve the backup and review an explicit signing-identity migration"
        }
        $RequireTrustedSignature = $true
        $ExpectedPublisherSubject = [string]$savedPolicy.expected_publisher_subject
        $ExpectedSignerThumbprint = [string]$savedPolicy.expected_signer_thumbprint
    }
    $policy = @{
        ExpectedPublisherSubject = $ExpectedPublisherSubject; ExpectedSignerThumbprint = $ExpectedSignerThumbprint
        RequireTrustedSignature = [bool]$RequireTrustedSignature; ExpectedSourceCommit = $ExpectedSourceCommit
    }
    $proof = Confirm-DevicePackage -PackagePath $package @policy
    Assert-ManagedDeviceSnapshot -InstallPrefix $install -Snapshot $before
    $expectedCurrent = [ordered]@{}
    foreach ($key in $before.Keys) { $expectedCurrent[$key] = $before[$key] }
    $candidateHashes = [ordered]@{}
    foreach ($relative in $ManagedFiles) { $candidateHashes[$relative.Replace("\", "/")] = Get-ManagedDeviceFileHash -LiteralPath (Join-Path $package $relative) }
    $recovery = $install + ".tetherplane-upgrades"
    if (-not (Test-Path -LiteralPath $recovery)) {
        New-Item -ItemType Directory -Path $recovery -ErrorAction Stop | Out-Null
        Write-Utf8NoBomJson -Value ([ordered]@{ managed_by = "setup-windows-device.ps1"; install_prefix = $install }) -LiteralPath (Join-Path $recovery "owner.json")
    }
    $transaction = Join-Path $recovery ("upgrade-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $transaction -ErrorAction Stop | Out-Null
    $candidate = Join-Path $transaction "candidate"
    $backup = Join-Path $transaction "backup"
    $candidateReceipt = Join-Path $transaction "candidate-install.json"
    $journalPath = Join-Path $transaction "journal.json"
    $journalHash = ""
    $attempted = New-Object System.Collections.Generic.List[string]
    $createdDirectories = New-Object System.Collections.Generic.List[string]
    $journal = [ordered]@{
        managed_by = "setup-windows-device.ps1"; install_prefix = $install
        status = "preparing"; source_commit = $proof.source_commit
        prior_files = $before; candidate_files = $candidateHashes
        backup_path = $backup; replaced_files = @(); created_directories = @()
    }
    try {
        $journalHash = Write-ManagedUpgradeJournal -Value $journal -LiteralPath $journalPath -ExpectedHash $journalHash
        New-Item -ItemType Directory -Path $candidate,$backup | Out-Null
        # Only known kit files are staged. The staged checksum manifest must
        # still verify, so an unexpected manifest entry cannot be ignored.
        foreach ($relative in @($ManagedFiles) + @("manifest.sha256", "README.txt", "setup.cmd")) {
            $source = Join-Path $package $relative
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
            Assert-DevicePathNotRedirected -LiteralPath $source
            $destination = Join-Path $candidate $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
        }
        Confirm-DevicePackage -PackagePath $candidate @policy | Out-Null
        foreach ($key in $candidateHashes.Keys) {
            if ((Get-ManagedDeviceFileHash -LiteralPath (Join-Path $candidate $key)) -cne [string]$candidateHashes[$key]) { throw "candidate was modified while staging: $key" }
        }
        Write-InstallReceipt -PackagePath $candidate -InstallPrefix $install -InstalledFileRoot $candidate -ReceiptPath $candidateReceipt @policy
        $candidateHashes["config/install.json"] = Get-ManagedDeviceFileHash -LiteralPath $candidateReceipt
        foreach ($key in $before.Keys) {
            if (-not $before[$key]) { continue }
            $destination = Join-Path $backup $key
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $install $key) -Destination $destination -ErrorAction Stop
            if ((Get-ManagedDeviceFileHash -LiteralPath $destination) -cne [string]$before[$key]) { throw "managed file was modified while preserving its backup: $key" }
        }
        Assert-ManagedDeviceSnapshot -InstallPrefix $install -Snapshot $before
        $journal.status = "applying"
        $journalHash = Write-ManagedUpgradeJournal -Value $journal -LiteralPath $journalPath -ExpectedHash $journalHash
        foreach ($folder in @($install, (Join-Path $install "bin"), (Join-Path $install "launch"), (Join-Path $install "config"))) {
            Assert-DevicePathNotRedirected -LiteralPath $folder
            if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
                New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
                $createdDirectories.Add($folder)
            }
        }
        $journal.created_directories = @($createdDirectories.ToArray())
        foreach ($key in $candidateHashes.Keys) {
            Assert-ManagedDeviceSnapshot -InstallPrefix $install -Snapshot $expectedCurrent
            if ($expectedCurrent[$key] -ceq $candidateHashes[$key]) { continue }
            $source = if ($key -ceq "config/install.json") { $candidateReceipt } else { Join-Path $candidate $key }
            $attempted.Add($key)
            Copy-ManagedDeviceFileAtomically -Source $source -Destination (Join-Path $install $key) -SourceHash $candidateHashes[$key] -ExpectedHash $expectedCurrent[$key] -RecoveryDirectory $transaction
            $expectedCurrent[$key] = $candidateHashes[$key]
            $journal.replaced_files = @($attempted.ToArray())
            $journalHash = Write-ManagedUpgradeJournal -Value $journal -LiteralPath $journalPath -ExpectedHash $journalHash
        }
        Assert-ManagedDeviceSnapshot -InstallPrefix $install -Snapshot $expectedCurrent
        $journal.status = "committed"
        $journalHash = Write-ManagedUpgradeJournal -Value $journal -LiteralPath $journalPath -ExpectedHash $journalHash
        return [ordered]@{ ok = $true; repaired = [bool]$hasReceipt; install_prefix = $install; backup_path = $backup }
    } catch {
        $failure = $_.Exception.Message
        $conflicts = New-Object System.Collections.Generic.List[string]
        $retainedConflicts = New-Object System.Collections.Generic.List[string]
        $displacedConflict = Get-ManagedUpgradeRecoveryConflict -Exception $_.Exception
        if ($displacedConflict) {
            $conflicts.Add("unexpected displaced write")
            $retainedConflicts.Add($displacedConflict.retained_path)
            if ($displacedConflict.destination -ceq $journalPath) {
                # Replacement succeeded before its displaced-file check failed.
                # Only the known bytes just written authorize a corrective write.
                $journalHash = $displacedConflict.replacement_hash
            }
        }
        for ($index = $attempted.Count - 1; $index -ge 0; $index--) {
            $key = $attempted[$index]
            $destination = Join-Path $install $key
            try {
                $currentHash = Get-ManagedDeviceFileHash -LiteralPath $destination
                if ($currentHash -ceq [string]$before[$key]) { continue }
                if ($currentHash -cne [string]$candidateHashes[$key]) { throw "unexpected concurrent write" }
                if ($before[$key]) {
                    Copy-ManagedDeviceFileAtomically -Source (Join-Path $backup $key) -Destination $destination -SourceHash $before[$key] -ExpectedHash $candidateHashes[$key] -RecoveryDirectory $transaction
                } else {
                    if ((Get-ManagedDeviceFileHash -LiteralPath $destination) -cne [string]$candidateHashes[$key]) { throw "unexpected concurrent write" }
                    $retained = New-ManagedUpgradeRetainedPath -RecoveryDirectory $transaction -ExpectedHash $candidateHashes[$key]
                    [IO.File]::Move($destination, $retained)
                    Assert-ManagedUpgradeRetainedFile -LiteralPath $retained -ExpectedHash $candidateHashes[$key] -Destination $destination
                }
            } catch {
                $conflicts.Add($key)
                $displacedConflict = Get-ManagedUpgradeRecoveryConflict -Exception $_.Exception
                if ($displacedConflict) { $retainedConflicts.Add($displacedConflict.retained_path) }
            }
        }
        try { Assert-ManagedDeviceSnapshot -InstallPrefix $install -Snapshot $before } catch { $conflicts.Add("installed files") }
        for ($index = $createdDirectories.Count - 1; $index -ge 0; $index--) {
            $folder = $createdDirectories[$index]
            try {
                Assert-DevicePathNotRedirected -LiteralPath $folder
                if ((Test-Path -LiteralPath $folder -PathType Container) -and @(Get-ChildItem -LiteralPath $folder -Force).Count -eq 0) {
                    [IO.Directory]::Delete($folder, $false)
                }
            } catch { $conflicts.Add("created directory") }
        }
        $journal.status = if ($conflicts.Count -eq 0) { "rolled_back" } else { "needs_recovery" }
        $journal["conflicts"] = @($conflicts.ToArray())
        $journal["retained_conflicts"] = @($retainedConflicts.ToArray())
        try { $journalHash = Write-ManagedUpgradeJournal -Value $journal -LiteralPath $journalPath -ExpectedHash $journalHash }
        catch {
            $conflicts.Add("recovery journal")
            $displacedConflict = Get-ManagedUpgradeRecoveryConflict -Exception $_.Exception
            if ($displacedConflict) {
                $retainedConflicts.Add($displacedConflict.retained_path)
                $journal.status = "needs_recovery"
                $journal.conflicts = @($conflicts.ToArray())
                $journal.retained_conflicts = @($retainedConflicts.ToArray())
                try { $journalHash = Write-ManagedUpgradeJournal -Value $journal -LiteralPath $journalPath -ExpectedHash $displacedConflict.replacement_hash }
                catch { $conflicts.Add("recovery journal could not be finalized") }
            }
        }
        if ($conflicts.Count -gt 0) {
            $retainedDetails = if ($retainedConflicts.Count -gt 0) { " Retained unexpected bytes: " + ($retainedConflicts.ToArray() -join "; ") + "." } else { "" }
            throw "managed update failed: $failure. Recovery is required; unexpected writes were preserved.$retainedDetails Inspect the retained backup and journal: $transaction"
        }
        throw "managed update failed: $failure. Prior managed files were restored; recovery backup and journal retained at: $transaction"
    }
}

function Install-ManagedDeviceFiles {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$InstallPrefix,
        [string]$ExpectedPublisherSubject = "",
        [string]$ExpectedSignerThumbprint = "",
        [switch]$RequireTrustedSignature,
        [string]$ExpectedSourceCommit = ""
    )
    return Invoke-ManagedDeviceUpdate @PSBoundParameters
}

function Repair-ManagedDeviceFiles {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$InstallPrefix,
        [string]$ExpectedPublisherSubject = "",
        [string]$ExpectedSignerThumbprint = "",
        [switch]$RequireTrustedSignature,
        [string]$ExpectedSourceCommit = ""
    )
    return Invoke-ManagedDeviceUpdate @PSBoundParameters -ExistingOnly
}

function Protect-DeviceDirectory {
    param([Parameter(Mandatory = $true)][string]$StateDir)
    $sid = Get-CurrentUserSid
    icacls $StateDir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F" /grant:r "*S-1-5-32-544:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "failed to restrict directory $StateDir" }
    # /inheritance:r removes inherited grants; /grant:r does not remove an
    # explicit grant to another principal. Verify the directory before a
    # credential is ever created, rather than protecting only the final file.
    if (-not (Test-RestrictedCredentialFile -CredentialPath $StateDir)) {
        throw "device state directory has unexpected explicit access rules; refusing credential creation"
    }
}

function Test-RestrictedCredentialFile {
    param([Parameter(Mandatory = $true)][string]$CredentialPath)
    $acl = Get-Acl -LiteralPath $CredentialPath
    if (-not $acl.AreAccessRulesProtected) { return $false }
    $sids = @($acl.Access | ForEach-Object {
        try { ([Security.Principal.SecurityIdentifier]$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier])).Value } catch { "" }
    })
    $want = @((Get-CurrentUserSid); "S-1-5-18"; "S-1-5-32-544")
    if ($sids.Count -ne 3) { return $false }
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }
        $full = [Security.AccessControl.FileSystemRights]::FullControl
        if (($rule.FileSystemRights -band $full) -ne $full) { return $false }
    }
    foreach ($required in $want) {
        if ($sids -notcontains $required) { return $false }
    }
    return $true
}

function Install-DeviceIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$StateDir,
        [Parameter(Mandatory = $true)][string]$DeviceId
    )
    if ($DeviceId -notmatch "^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$") {
        throw "device ID must start alphanumeric and contain only letters, digits, dash or underscore (max 63 chars)"
    }
    $state = [IO.Path]::GetFullPath($StateDir)
    Assert-DevicePathNotRedirected -LiteralPath $state
    foreach ($leaf in @("device-id.txt", "device.credential", "principal.json", "agent")) {
        Assert-DevicePathNotRedirected -LiteralPath (Join-Path $state $leaf)
    }
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    try {
        Protect-DeviceDirectory -StateDir $state
    } catch {
        throw "failed to restrict the device state directory; refusing to write a credential into an unprotected directory"
    }
    $idPath = Join-Path $state "device-id.txt"
    $credentialPath = Join-Path $state "device.credential"
    if ((Test-Path -LiteralPath $idPath -PathType Leaf)) {
        $existing = (Get-Content -LiteralPath $idPath -Raw).Trim()
        if ($existing -cne $DeviceId) {
            throw "conflicting device identity: state already belongs to '$existing'. Re-run with the same device ID to repair, or revoke and re-pair explicitly; identity is never overwritten."
        }
        if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
            throw "device identity exists but its credential file is missing; restore device.credential from backup or revoke and re-pair explicitly."
        }
        $credential = (Get-Content -LiteralPath $credentialPath -Raw).Trim()
        if ($credential.Length -lt 16 -or $credential -match "[\r\n]") {
            throw "stored device credential is malformed; restore device.credential from backup or revoke and re-pair explicitly."
        }
        if (-not (Test-RestrictedCredentialFile -CredentialPath $credentialPath)) {
            throw "stored credential file ACL is not restricted to this user, SYSTEM and Administrators; repair permissions or restore from backup before continuing."
        }
        return [ordered]@{ ok = $true; reused = $true; device_id = $existing }
    }
    if ((Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
        throw "a device credential exists without a device identity; remove the orphaned device.credential or restore device-id.txt before continuing."
    }
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $credential = ([Convert]::ToBase64String($bytes)).Replace("+", "-").Replace("/", "_").TrimEnd("=")
    Set-Content -LiteralPath $credentialPath -Value $credential -Encoding Ascii -NoNewline
    $sid = Get-CurrentUserSid
    icacls $credentialPath /inheritance:r /grant:r "*${sid}:F" /grant:r "*S-1-5-18:F" /grant:r "*S-1-5-32-544:F" | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-RestrictedCredentialFile -CredentialPath $credentialPath)) {
        Remove-Item -LiteralPath $credentialPath -Force -ErrorAction SilentlyContinue
        throw "failed to restrict the credential file; the generated secret was discarded and nothing was kept"
    }
    Set-Content -LiteralPath $idPath -Value $DeviceId -Encoding Ascii -NoNewline
    return [ordered]@{ ok = $true; reused = $false; device_id = $DeviceId }
}

function Get-ApprovalInstruction {
    param([Parameter(Mandatory = $true)][string]$DeviceId, [Parameter(Mandatory = $true)][string]$UserCode)
    return (@(
        "Ask the already connected ChatGPT plugin to approve this pairing:",
        "device(op=""approve_pairing"", args={userCode:""$UserCode"", expectedDeviceId:""$DeviceId""})",
        "No token export or extra client is needed; approval binds to the authenticated ChatGPT account."
    ) -join "`n")
}

function Install-DeviceAgentTask {
    param(
        [Parameter(Mandatory = $true)][string]$InstallPrefix,
        [Parameter(Mandatory = $true)][string]$StateDir,
        [Parameter(Mandatory = $true)][string]$DeviceId,
        [Parameter(Mandatory = $true)][string]$RelayUrl,
        [string]$TaskName = "Tetherplane Agent"
    )
    # The PR44 reliability contract requires the task to own tetherd directly.
    # The old PowerShell supervisor is not used for new native installations.
    $install = [IO.Path]::GetFullPath($InstallPrefix)
    $state = [IO.Path]::GetFullPath($StateDir)
    if ($TaskName -notmatch '^Tetherplane(?:[ -][A-Za-z0-9._-]+)*$') {
        throw "scheduled agent task name must be Tetherplane-owned"
    }
    Assert-ManagedDeviceDestinations -InstallPrefix $install
    Assert-DevicePathNotRedirected -LiteralPath $state
    foreach ($leaf in @("device.credential", "principal.json", "agent")) {
        Assert-DevicePathNotRedirected -LiteralPath (Join-Path $state $leaf)
    }
    $tetherd = Join-Path $install "bin\tetherd.exe"
    $credentialFile = Join-Path $state "device.credential"
    $argsPath = Join-Path $install "config\agent-args.json"
    foreach ($required in @($tetherd, $credentialFile)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "finalize requires an installed agent and authorized local identity; missing: $required"
        }
    }
    $expectedActionArguments = '--arguments-file "' + $argsPath + '"'
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $null -ne $_ })
    $agentTasks = @($tasks | Where-Object {
        $taskNameMatches = $_.TaskName -match '(?i)^Tetherplane(?:\s+\S+)*\s+Agent$'
        $nativeActionMatches = @($_.Actions | Where-Object {
            $execute = $_.PSObject.Properties['Execute']
            $null -ne $execute -and [string]$execute.Value -match '(?i)[\\/]tetherd\.exe$'
        }).Count -gt 0
        $taskNameMatches -or $nativeActionMatches
    })
    if (@($agentTasks | Where-Object { $_.TaskName -ne $TaskName }).Count -gt 0) {
        throw "a competing Tetherplane agent task exists; reconcile it without replacing a device identity"
    }
    $runningAgents = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe'" -ErrorAction Stop)
    if ($existingTask) {
        $owner = [string]$existingTask.Principal.UserId
        $owners = @((Get-CurrentUserSid), ([Security.Principal.WindowsIdentity]::GetCurrent()).Name)
        $actions = @($existingTask.Actions)
        if ($owners -notcontains $owner -or $actions.Count -ne 1 -or
            [string]$actions[0].Execute -ine $tetherd -or
            [string]$actions[0].Arguments -cne $expectedActionArguments) {
            throw "existing task is not the exact native Tetherplane agent owned by this identity"
        }
        if (-not (Test-Path -LiteralPath $argsPath -PathType Leaf)) {
            throw "existing native task is missing its arguments file; restore it from backup before repair"
        }
        if ($runningAgents.Count -gt 1 -or
            ($runningAgents.Count -eq 1 -and [string]$runningAgents[0].ExecutablePath -ine $tetherd)) {
            throw "an unknown tetherd process is already running; refusing duplicate registration"
        }
        $running = [string]$existingTask.State -eq "Running"
        return [ordered]@{ ok = $true; reused = $true; task = $TaskName; started = $running; start_pending = (-not $running); principal_kept = $true; native_task = $true }
    }
    if ($agentTasks.Count -ne 0 -or $runningAgents.Count -ne 0) {
        throw "an existing agent task or tetherd process is present; never register a competing device identity"
    }
    $principalPath = Join-Path $state "principal.json"
    $principalKept = Test-Path -LiteralPath $principalPath -PathType Leaf
    if (-not $principalKept) {
        [ordered]@{
            principal_id = "human:owner"
            authentication = "local_process_binding"
            allowed_devices = @($DeviceId)
            allowed_directories = @()
            allowed_capabilities = @("device.status")
        } | ConvertTo-Json -Depth 4 | ForEach-Object {
            [IO.File]::WriteAllText($principalPath, ($_ + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
        }
    }
    $agentArgs = @(
        "--relay-url", $RelayUrl,
        "--device-id", $DeviceId,
        "--device-credential-file", $credentialFile,
        "--allow", $state,
        "--principal-profile", $principalPath,
        "--state-dir", (Join-Path $state "agent")
    )
    [IO.File]::WriteAllText(
        $argsPath,
        (($agentArgs | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    try {
        $currentUser = ([Security.Principal.WindowsIdentity]::GetCurrent()).Name
        $action = New-ScheduledTaskAction -Execute $tetherd -Argument $expectedActionArguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
        $taskPrincipal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
        $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval ([TimeSpan]::FromMinutes(1))
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $taskSettings | Out-Null
    } catch {
        throw "native scheduled task registration failed or raced; inspect task ownership before retrying ($($_.Exception.Message))"
    }
    $started = $false
    $pending = ""
    try {
        Start-ScheduledTask -TaskName $TaskName | Out-Null
        $started = $true
    } catch {
        $pending = "native task registered but did not start; inspect it without creating a second task"
    }
    return [ordered]@{ ok = $true; reused = $false; task = $TaskName; started = $started; start_pending = $pending; principal_kept = $principalKept; agent_args = $agentArgs; native_task = $true }
}

if ($MyInvocation.InvocationName -ne ".") {
    if (-not $PackagePath) {
        if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) {
            $PackagePath = $PSScriptRoot
        } else {
            throw "-PackagePath is required when this script is not run from an unpacked device kit"
        }
    }
    if (-not $DeviceId) { $DeviceId = $env:COMPUTERNAME }
    if (-not $InstallPrefix) { $InstallPrefix = Join-Path $env:LOCALAPPDATA "Programs\Tetherplane" }
    if (-not $StateDir) { $StateDir = Join-Path $env:LOCALAPPDATA "Tetherplane\device-state" }
    $manifest = Confirm-DevicePackage -PackagePath $PackagePath -ExpectedPublisherSubject $ExpectedPublisherSubject -ExpectedSignerThumbprint $ExpectedSignerThumbprint -RequireTrustedSignature:$RequireTrustedSignature -ExpectedSourceCommit $ExpectedSourceCommit
    $install = Install-ManagedDeviceFiles -PackagePath $PackagePath -InstallPrefix $InstallPrefix -ExpectedPublisherSubject $ExpectedPublisherSubject -ExpectedSignerThumbprint $ExpectedSignerThumbprint -RequireTrustedSignature:$RequireTrustedSignature -ExpectedSourceCommit $ExpectedSourceCommit
    $identity = Install-DeviceIdentity -StateDir $StateDir -DeviceId $DeviceId
    $result = [ordered]@{ ok = $true; package = $manifest; install = $install; identity = $identity }
    if ($Pair) {
        $pairScript = Join-Path $PSScriptRoot "pair-windows-device.ps1"
        $pairing = & $pairScript -Run -RelayUrl $PairingOrigin -DeviceId $identity.device_id -StateDir ([IO.Path]::GetFullPath($StateDir))
        $result["pairing"] = $pairing
        $result["approval_instruction"] = Get-ApprovalInstruction -DeviceId $identity.device_id -UserCode $pairing.userCode
    }
    if ($Finalize) {
        $task = Install-DeviceAgentTask -InstallPrefix $install.install_prefix -StateDir ([IO.Path]::GetFullPath($StateDir)) -DeviceId $identity.device_id -RelayUrl $RelayUrl
        $result["agent_task"] = $task
    }
    $result | ConvertTo-Json -Depth 5 | Write-Output
}
