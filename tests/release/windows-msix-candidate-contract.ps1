# Fail-first contract for a source-bound, unsigned Store packaging artifact.
# No installation, signing, relay, or Windows security changes.
[CmdletBinding()]
param(
    [switch]$PreflightOnly,
    [string]$TetherdPath = "",
    [string]$OutputDirectory = "",
    [string]$SourceCommit = ""
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$builder = Join-Path $repo "scripts\build-windows-store-candidate.ps1"
if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) {
    throw "MSIX_CANDIDATE_RED: source-bound artifact builder not implemented"
}
$builderSource = Get-Content -LiteralPath $builder -Raw -ErrorAction Stop
foreach ($forbidden in @("Add-AppxPackage", "Set-MpPreference", "Register-ScheduledTask", "Start-ScheduledTask", "Invoke-WebRequest", "Invoke-RestMethod", "New-SelfSignedCertificate")) {
    if ($builderSource.Contains($forbidden)) { throw "candidate builder must not install/sign/connect/change Windows security: $forbidden" }
}
if ($PreflightOnly) {
    Write-Output "MSIX_CANDIDATE_PREFLIGHT_OK"
    exit 0
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory) -or [string]::IsNullOrWhiteSpace($TetherdPath) -or
    $SourceCommit -cnotmatch '^[a-f0-9]{40}$') {
    throw "the test requires an output directory, real release agent and exact source commit"
}
if (-not (Test-Path -LiteralPath $TetherdPath -PathType Leaf)) {
    throw "native agent executable is missing"
}
$expectedHead = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $expectedHead -cne $SourceCommit) {
    throw "source commit is not the exact checked-out revision"
}
$fakeOutput = Join-Path $env:TEMP ("tp-msix-mismatch-" + [Guid]::NewGuid().ToString("N"))
$wrongSourceFailed = $false
try {
    & $builder -TetherdPath $TetherdPath -OutputDirectory $fakeOutput -SourceCommit ('0' * 40) | Out-Null
} catch { $wrongSourceFailed = $true }
if (-not $wrongSourceFailed -or (Test-Path -LiteralPath $fakeOutput)) {
    throw "source-mismatch candidate build must fail before writing output"
}

& $builder -TetherdPath $TetherdPath -OutputDirectory $OutputDirectory -SourceCommit $SourceCommit
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) { throw "output directory missing" }
$packages = @(Get-ChildItem -LiteralPath $OutputDirectory -Filter '*.msix' -File)
$provenance = @(Get-ChildItem -LiteralPath $OutputDirectory -Filter '*.provenance.json' -File)
$warnings = @(Get-ChildItem -LiteralPath $OutputDirectory -Filter 'UNSIGNED-*.txt' -File)
if ($packages.Count -ne 1 -or $provenance.Count -ne 1 -or $warnings.Count -ne 1) {
    throw "expected exactly one MSIX, provenance JSON and explicit unsigned warning"
}
$msix = $packages[0]
$sidecar = $msix.FullName + ".sha256"
if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) { throw "missing SHA-256 sidecar" }
$packageHash = (Get-FileHash -LiteralPath $msix.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$sidecarHash = ((Get-Content -LiteralPath $sidecar -Raw).Trim() -split '\s+')[0]
if ($packageHash -cne $sidecarHash) { throw "package hash/sidecar mismatch" }
$record = Get-Content -LiteralPath $provenance[0].FullName -Raw | ConvertFrom-Json
$agentHash = (Get-FileHash -LiteralPath $TetherdPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ([string]$record.source_commit -cne $SourceCommit -or
    [string]$record.native_agent_sha256 -cne $agentHash -or
    [string]$record.msix_sha256 -cne $packageHash -or
    [string]$record.signing_status -cne "unsigned" -or
    [string]$record.distribution_status -cne "store_development_candidate" -or
    $record.store_certified -ne $false -or
    $record.device_runtime_verified -ne $false) {
    throw "provenance must tie exact input and unsigned, uncertified distribution status"
}
$warningText = Get-Content -LiteralPath $warnings[0].FullName -Raw
if ($warningText -notmatch 'NOT SIGNED' -or $warningText -notmatch 'DO NOT INSTALL') {
    throw "candidate warning must explicitly prohibit installation"
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($msix.FullName)
try {
    if ($zip.GetEntry("AppxSignature.p7x")) { throw "unsigned prototype unexpectedly contains a package signature" }
    $agentEntry = $zip.GetEntry("bin/tetherd.exe")
    $manifestEntry = $zip.GetEntry("AppxManifest.xml")
    if (-not $agentEntry -or -not $manifestEntry) { throw "candidate archive missing native agent or manifest" }
    $stream = $agentEntry.Open()
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $embeddedHash = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally { $stream.Dispose(); $hasher.Dispose() }
    if ($embeddedHash -cne $agentHash) { throw "embedded native agent bytes differ from built release input" }
} finally { $zip.Dispose() }

$before = $packageHash
$overwriteRejected = $false
try {
    & $builder -TetherdPath $TetherdPath -OutputDirectory $OutputDirectory -SourceCommit $SourceCommit | Out-Null
} catch { $overwriteRejected = $true }
if (-not $overwriteRejected -or (Get-FileHash -LiteralPath $msix.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $before) {
    throw "candidate builder must fail closed when output already exists"
}
Write-Output ("MSIX_CANDIDATE_OK: source=" + $SourceCommit + " agent=" + $agentHash + " msix=" + $packageHash + " unsigned/uninstalled/uncertified")
