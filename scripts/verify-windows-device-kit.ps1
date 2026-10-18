# Verifies a built Tetherplane device kit ZIP the way a new computer would
# receive it: sidecar SHA-256, unpack, package integrity, a real install into a
# temporary prefix, and the shipped agent binary answering device.status.
# Nothing outside the temporary directory is modified.
param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [switch]$RequireTrustedSignature,
    [string]$ExpectedPublisherSubject = "",
    [string]$ExpectedSignerThumbprint = "",
    [string]$ExpectedSourceCommit = "",
    [string]$ExpectedZipSha256 = "",
    [string]$SignToolPath = "",
    [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Dot-sourced entrypoint parameters must never replace the caller's trust pins.
# The verifier itself comes from the trusted checkout, never from the archive.
$verificationPolicy = @{
    RequireTrustedSignature = [bool]$RequireTrustedSignature
    ExpectedPublisherSubject = $ExpectedPublisherSubject
    ExpectedSignerThumbprint = $ExpectedSignerThumbprint
    ExpectedSourceCommit = $ExpectedSourceCommit
    SignToolPath = $SignToolPath
}
$verificationOnly = [bool]$VerifyOnly
$trustedSetupPath = Join-Path $PSScriptRoot "setup-windows-device.ps1"
. $trustedSetupPath

$zip = (Resolve-Path -LiteralPath $ZipPath).Path
Assert-DevicePathNotRedirected -LiteralPath $zip
$sidecar = $zip + ".sha256"
if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) { throw "missing checksum file: $sidecar" }
$recorded = ((Get-Content -LiteralPath $sidecar -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
$work = ""
$archiveStream = $null
$archive = $null
$agent = $null
try {
    # Keep one file handle from the hash through extraction. On Windows this
    # sharing mode also denies writes/deletion while the archive is checked.
    # Reopening the original path could otherwise extract a substituted ZIP
    # while reporting the independently approved digest of its predecessor.
    $archiveStream = [IO.File]::Open($zip, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $actual = (Get-FileHash -InputStream $archiveStream -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($recorded -notmatch "^[a-f0-9]{64}$" -or $recorded -ne $actual) { throw "zip SHA-256 does not match its checksum file" }
    if ($ExpectedZipSha256 -and ($ExpectedZipSha256 -notmatch "^[a-fA-F0-9]{64}$" -or $actual -ine $ExpectedZipSha256)) {
        throw "zip SHA-256 differs from the independently approved archive digest"
    }
    $work = Join-Path ([IO.Path]::GetTempPath()) ("tp-kit-verify-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $work | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $kit = Join-Path $work "kit"
    $archiveStream.Position = 0
    $archive = New-Object IO.Compression.ZipArchive($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $true)
    [IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, $kit)
    $archive.Dispose()
    $archive = $null
    $archiveStream.Dispose()
    $archiveStream = $null

    $setup = Join-Path $kit "setup-windows-device.ps1"
    $verified = Confirm-DevicePackage -PackagePath $kit @verificationPolicy
    if ($verificationOnly) {
        if (-not $verified.trusted_signature_verified) { throw "signature-only verification requires a trusted signed candidate" }
        Write-Output ("TETHERPLANE_DEVICE_KIT_SIGNATURES_VERIFIED sha256={0} commit={1}" -f $actual, $verified.source_commit)
        return
    }
    $manifest = Get-Content -LiteralPath (Join-Path $kit "manifest.json") -Raw | ConvertFrom-Json

    $install = Join-Path $work "install"
    $state = Join-Path $work "state"
    # Only execute shipped setup after the trusted verifier has accepted it.
    # Unsigned mode is deliberately limited to developer/test distributions.
    $result = & $setup -DeviceId "KITVERIFY01" -InstallPrefix $install -StateDir $state -ExpectedPublisherSubject $verificationPolicy.ExpectedPublisherSubject -ExpectedSignerThumbprint $verificationPolicy.ExpectedSignerThumbprint -ExpectedSourceCommit $verificationPolicy.ExpectedSourceCommit -RequireTrustedSignature:$verificationPolicy.RequireTrustedSignature | ConvertFrom-Json
    if (-not $result.ok) { throw "setup from the unpacked kit did not report ok" }

    $installedAgent = Join-Path $install "bin\tetherd.exe"
    $shipped = (Get-FileHash -LiteralPath (Join-Path $kit "bin\tetherd.exe") -Algorithm SHA256).Hash
    $installedHash = (Get-FileHash -LiteralPath $installedAgent -Algorithm SHA256).Hash
    if ($shipped -ne $installedHash) { throw "installed agent differs from the shipped agent" }
    if ($verified.trusted_signature_verified) {
        foreach ($relative in $SignedDeviceCodeFiles) {
            $checked = Assert-TrustedDeviceSignature -Path (Join-Path $install $relative) -ExpectedPublisherSubject $verificationPolicy.ExpectedPublisherSubject -ExpectedSignerThumbprint $verificationPolicy.ExpectedSignerThumbprint -SignToolPath $verificationPolicy.SignToolPath
        }
    }

    $requestId = [Guid]::NewGuid().ToString()
    $request = @{
        protocol_version = "1.0"; request_id = $requestId; device_id = $null; capability = "device.status"
        arguments = @{}; actor = @{ id = "kit-verify"; kind = "ai_client" }; session_id = $null
        response_mode = "compact"; idempotency_key = $null; preconditions = @(); expectations = @()
    } | ConvertTo-Json -Depth 6 -Compress
    $inFile = Join-Path $work "in.jsonl"
    $outFile = Join-Path $work "out.jsonl"
    $errFile = Join-Path $work "err.log"
    [IO.File]::WriteAllText($inFile, $request + "`n", (New-Object System.Text.UTF8Encoding($false)))
    $agent = Start-Process -FilePath $installedAgent -ArgumentList ('--stdio-rpc --allow "{0}"' -f $work) -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru

    $line = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline -and -not $line) {
        Start-Sleep -Milliseconds 250
        if (Test-Path -LiteralPath $outFile) {
            $stream = $null
            try {
                $stream = New-Object IO.FileStream($outFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
                $text = (New-Object IO.StreamReader($stream)).ReadToEnd()
                $line = @($text -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($requestId) }) | Select-Object -First 1
            } catch { } finally { if ($stream) { $stream.Dispose() } }
        }
    }
    if (-not $line) { throw "the shipped agent did not answer device.status within 20 seconds" }
    $status = $line | ConvertFrom-Json
    if ($status.status -ne "success" -or $status.data.policy_mode -ne "background_only") {
        throw "the shipped agent returned an unexpected device.status result"
    }

    Write-Output ("TETHERPLANE_DEVICE_KIT_VERIFIED sha256={0} commit={1} dirty={2} agent={3}/{4} policy={5}" -f $actual, $verified.source_commit, $manifest.source_tree_dirty, $status.data.os, $status.data.arch, $status.data.policy_mode)
} finally {
    if ($archive) { $archive.Dispose() }
    if ($archiveStream) { $archiveStream.Dispose() }
    if ($agent) {
        if (-not $agent.HasExited) { try { $agent.Kill() } catch { } }
        try { [void]$agent.WaitForExit(5000) } catch { }
        $agent.Dispose()
    }
    if ($work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
