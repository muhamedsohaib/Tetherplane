# Rebuild a test-only Windows toast ZIP from one pinned GitHub Actions artifact.
# Offline, read-only source input. Refuses overwrite and mismatched hashes.
# NOT a production installer, signing or Store/MSIX distribution path.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ArtifactDirectory,
    [Parameter(Mandatory=$true)][string]$OutputZip,
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedCommit
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($ArtifactDirectory) -or
    -not (Test-Path -LiteralPath $ArtifactDirectory -PathType Container)) {
    throw 'BETA_ARTIFACT_DIRECTORY_MISSING_OR_RELATIVE'
}
if (-not [IO.Path]::IsPathRooted($OutputZip) -or
    ([IO.Path]::GetExtension($OutputZip) -ine '.zip')) {
    throw 'BETA_OUTPUT_PATH_MUST_BE_ABSOLUTE_ZIP'
}
$artifact = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
$output = [IO.Path]::GetFullPath($OutputZip)
if (Test-Path -LiteralPath $output) {
    throw 'BETA_KIT_OUTPUT_ALREADY_EXISTS: refusing overwrite'
}
if (-not (Test-Path -LiteralPath (Split-Path -Parent $output) -PathType Container)) {
    throw 'BETA_KIT_OUTPUT_PARENT_MISSING'
}
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$packagingCommit = & git -C $repository rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $packagingCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'BETA_KIT_PACKAGING_SOURCE_UNVERIFIED'
}
$packagingStatus = & git -C $repository status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'BETA_KIT_PACKAGING_STATUS_UNVERIFIED' }
$packagingDirty = if ($packagingStatus) { 'true' } else { 'false' }
$evidenceFile = Join-Path $artifact 'toast-beta-build-evidence.txt'
$toastFile = Join-Path $artifact 'target\release\tetherplane-toast-smoke.exe'
$agentFile = Join-Path $artifact 'target\release\tetherd.exe'
foreach ($file in @($evidenceFile,$toastFile,$agentFile)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw ('BETA_KIT_REQUIRED_ARTIFACT_MISSING: ' + (Split-Path -Leaf $file))
    }
    if (((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'BETA_KIT_REFUSES_REPARSE_POINT_INPUT'
    }
}
$build = @{}
foreach($line in Get-Content -LiteralPath $evidenceFile) {
    if ($line -notmatch '^([a-z0-9_]+)=([a-zA-Z0-9._-]+)$') {
        throw 'BETA_KIT_EVIDENCE_MALFORMED'
    }
    if ($build.ContainsKey($Matches[1])) {
        throw 'BETA_KIT_EVIDENCE_DUPLICATE_KEY'
    }
    $build[$Matches[1]] = $Matches[2]
}
if ($build['commit'] -cne $ExpectedCommit -or
    $build['artifact'] -cne 'tetherplane-toast-smoke.exe' -or
    $build['sha256'] -notmatch '^[0-9a-fA-F]{64}$' -or
    $build['agent_sha256'] -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'BETA_KIT_SOURCE_COMMIT_OR_EVIDENCE_INVALID'
}
$toastHash = (Get-FileHash -LiteralPath $toastFile -Algorithm SHA256).Hash
$agentHash = (Get-FileHash -LiteralPath $agentFile -Algorithm SHA256).Hash
if ($toastHash -ine $build['sha256'] -or $agentHash -ine $build['agent_sha256']) {
    throw 'BETA_KIT_BUILD_ARTIFACT_HASH_MISMATCH'
}
Write-Output 'BETA_KIT_CI_SOURCE_HASHES_VERIFIED'
# Refuse previously built CI artifacts that require a VC++ runtime absent on clean Windows.
$runtimeAudit = Join-Path $repository 'scripts\windows\check-pe-runtime-imports.mjs'
foreach($nativeFile in @($toastFile,$agentFile)) {
    & node.exe $runtimeAudit $nativeFile
    if ($LASTEXITCODE -ne 0) {
        throw 'BETA_KIT_DYNAMIC_VC_RUNTIME_DEPENDENCY: rebuild CI with static CRT'
    }
}
Write-Output 'BETA_KIT_PORTABLE_CRT_AUDIT_PASSED'
$temporary = Join-Path $env:TEMP ('TPToastKitBuild-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $temporary 'stage'
$verify = Join-Path $temporary 'verification'
$createdZip = $false
New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
try {
    foreach($rel in @('bin','scripts\windows','tests\release','docs','assets\windows')) {
        New-Item -ItemType Directory -Path (Join-Path $stage $rel) -Force | Out-Null
    }
    Copy-Item -LiteralPath $toastFile -Destination (Join-Path $stage 'bin\tetherplane-toast-smoke.exe')
    Copy-Item -LiteralPath $agentFile -Destination (Join-Path $stage 'bin\tetherd.exe')
    Copy-Item -LiteralPath $evidenceFile -Destination (Join-Path $stage 'toast-beta-build-evidence.txt')
    foreach($name in @('tetherplane-black-on-white.ico','tetherplane-white-on-black.ico','icon-provenance.json')) {
        Copy-Item -LiteralPath (Join-Path $repository ('assets\windows\' + $name)) -Destination (Join-Path $stage ('assets\windows\' + $name))
    }
    $iconProvenance = Get-Content -LiteralPath (Join-Path $stage 'assets\windows\icon-provenance.json') -Raw | ConvertFrom-Json
    foreach($variant in @('black-on-white','white-on-black')) {
        $entry = @($iconProvenance.images | Where-Object { $_.variant -ceq $variant })
        $iconFile = Join-Path $stage ('assets\windows\tetherplane-' + $variant + '.ico')
        if ($entry.Count -ne 1 -or
            (Get-FileHash -LiteralPath $iconFile -Algorithm SHA256).Hash -ine $entry[0].iconSha256) {
            throw 'BETA_KIT_ICON_PROVENANCE_MISMATCH'
        }
    }
    foreach($name in @(
        'Register-TetherplaneToastBeta.ps1',
        'Test-TetherplaneToastBeta.ps1',
        'Test-TetherplaneToastEventBeta.ps1'
    )) {
        Copy-Item -LiteralPath (Join-Path $repository ('scripts\windows\' + $name)) -Destination (Join-Path $stage ('scripts\windows\' + $name))
    }
    Copy-Item -LiteralPath (Join-Path $repository 'tests\release\windows-toast-loopback-relay.mjs') -Destination (Join-Path $stage 'tests\release\windows-toast-loopback-relay.mjs')
    Copy-Item -LiteralPath (Join-Path $repository 'docs\release\WINDOWS_TOAST_DEVELOPER_BETA_ACCEPTANCE_20261103.md') -Destination (Join-Path $stage 'docs\ACCEPTANCE.md')
    # --no-pause is for repeatable CLI/CI verification; normal double-click pauses.
    # Propagate a failed PowerShell test's nonzero exit code.
    $smokeLauncher = @'
@echo off
setlocal
powershell.exe -NoLogo -NoProfile -NonInteractive -File "%~dp0scripts\windows\Test-TetherplaneToastBeta.ps1" -ToastExecutable "%~dp0bin\tetherplane-toast-smoke.exe" -ExpectedSha256 "__TOAST_HASH__"
set "result=%errorlevel%"
echo.
if "%result%"=="0" (echo TETHERPLANE BETA SMOKE: PASS) else (echo TETHERPLANE BETA SMOKE: FAIL, exit %result%)
if /I not "%~1"=="--no-pause" pause
exit /b %result%
'@
    $eventLauncher = @'
@echo off
setlocal
powershell.exe -NoLogo -NoProfile -NonInteractive -File "%~dp0scripts\windows\Test-TetherplaneToastEventBeta.ps1" -ToastExecutable "%~dp0bin\tetherplane-toast-smoke.exe" -AgentExecutable "%~dp0bin\tetherd.exe" -ExpectedToastSha256 "__TOAST_HASH__" -ExpectedAgentSha256 "__AGENT_HASH__"
set "result=%errorlevel%"
echo.
if "%result%"=="0" (echo TETHERPLANE BETA CONNECTION: PASS) else (echo TETHERPLANE BETA CONNECTION: FAIL, exit %result%)
if /I not "%~1"=="--no-pause" pause
exit /b %result%
'@
    $smokeLauncher = $smokeLauncher.Replace('__TOAST_HASH__',$toastHash)
    $eventLauncher = $eventLauncher.Replace('__TOAST_HASH__',$toastHash).Replace('__AGENT_HASH__',$agentHash)
    [IO.File]::WriteAllText((Join-Path $stage 'TEST TOAST.cmd'),$smokeLauncher,[Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $stage 'TEST CONNECTION TOAST.cmd'),$eventLauncher,[Text.Encoding]::ASCII)
    $readme = @'
TETHERPLANE WINDOWS NOTIFICATION DEVELOPER BETA - TEST ONLY

This kit contains TWO test programs and TWO double-click launchers.
- TEST TOAST.cmd: Windows native local notification.
- TEST CONNECTION TOAST.cmd: local synthetic WebSocket denial, connect and
  disconnect/unknown test. Requires Node.js 22+ installed on this Windows PC.

Launch by double-clicking a .cmd. Tests report PASS or FAIL before closing.
Launch from a terminal with "--no-pause" to get a machine-checkable exit code.

Neither test registers a persistent service, connects to production, uses
OAuth credentials, configures startup or changes Windows security settings.
The temporary per-user notification shortcut is removed after each test.
If a test fails, synthetic acceptance evidence may remain in %TEMP% for review.

This is not an installer for real four-device notification monitoring.
The embedded tetherd.exe is ONLY for synthetic loopback acceptance; never
launch it against real device credentials, as that would risk displacing
an existing authorized agent. Windows Notification Center history verifies
recorded delivery, NOT whether a popup was visually seen.

If the test prints BETA_WINDOWS_APPLICATION_CONTROL_BLOCKED, the existing
Windows host policy refused the unsigned executable. This machine cannot
run that binary under its current policy. Do NOT disable Application Control,
antivirus or other protections to pass the test. Use a separately authorized
developer machine that already permits unsigned test executables.
Windows Do Not Disturb may suppress the popup even when the toast appears
in Notification Center history. Do not call history success visual proof.

The ZIP is unsigned. Do not redistribute as a production Windows release.
The binary source commit and packaging source HEAD/working-copy status are
recorded separately in KIT-MANIFEST.txt. SHA256SUMS.txt covers all other files.
The icon originals and rebuild script are retained in the source repository;
both converted ICO variants are included here. The shortcut uses black on white.
See docs\ACCEPTANCE.md and toast-beta-build-evidence.txt.
'@
    [IO.File]::WriteAllText((Join-Path $stage 'README.txt'),$readme,[Text.Encoding]::UTF8)
    $manifest = @(
        ('commit=' + $ExpectedCommit),
        ('binary_source_commit=' + $ExpectedCommit),
        ('packaging_source_commit=' + $packagingCommit),
        ('packaging_working_copy_dirty=' + $packagingDirty),
        ('toast_sha256=' + $toastHash),
        ('agent_sha256=' + $agentHash),
        'kit_type=unpackaged_developer_beta',
        'windows_dynamic_vc_runtime_imports=none',
        'production_ready=false'
    )
    [IO.File]::WriteAllLines((Join-Path $stage 'KIT-MANIFEST.txt'),$manifest,[Text.Encoding]::ASCII)
    $checksums = @()
    # Compare canonical FileInfo paths, not an unnormalized stage string.
    # GitHub-hosted Windows runners may normalize the temp path differently.
    $canonicalStage = (Get-Item -LiteralPath $stage -ErrorAction Stop).FullName.TrimEnd('\','/')
    $stagePrefix = $canonicalStage + [IO.Path]::DirectorySeparatorChar
    foreach($file in @(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName)) {
        $canonicalFile = (Get-Item -LiteralPath $file.FullName -ErrorAction Stop).FullName
        if (-not $canonicalFile.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'BETA_KIT_CHECKSUM_PATH_OUTSIDE_STAGE'
        }
        $relative = $canonicalFile.Substring($stagePrefix.Length).Replace('\','/')
        if ([string]::IsNullOrWhiteSpace($relative) -or $relative -match '(^|/)\.\.(/|$)') {
            throw 'BETA_KIT_CHECKSUM_RELATIVE_PATH_INVALID'
        }
        $checksums += ((Get-FileHash -LiteralPath $canonicalFile -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $relative)
    }
    [IO.File]::WriteAllLines((Join-Path $stage 'SHA256SUMS.txt'),$checksums,[Text.Encoding]::ASCII)
    $entries = @(Get-ChildItem -LiteralPath $stage -Force | Select-Object -ExpandProperty FullName)
    Compress-Archive -LiteralPath $entries -DestinationPath $output -CompressionLevel Optimal -ErrorAction Stop
    $createdZip = $true
    Expand-Archive -LiteralPath $output -DestinationPath $verify -ErrorAction Stop
    foreach($item in @(
        @{Path='bin\tetherplane-toast-smoke.exe';Expected=$toastHash},
        @{Path='bin\tetherd.exe';Expected=$agentHash}
    )) {
        $actual = (Get-FileHash -LiteralPath (Join-Path $verify $item.Path) -Algorithm SHA256).Hash
        if ($actual -ine $item.Expected) {
            throw 'BETA_KIT_VERIFICATION_AFTER_EXTRACTION_FAILED'
        }
    }
    foreach($name in @('TEST TOAST.cmd','TEST CONNECTION TOAST.cmd')) {
        $text = Get-Content -LiteralPath (Join-Path $verify $name) -Raw
        if ($text -notmatch '--no-pause' -or $text -notmatch 'exit /b %result%') {
            throw 'BETA_KIT_LAUNCHER_FAIL_CLOSED_CONTRACT_MISSING'
        }
    }
    $files = @(Get-ChildItem -LiteralPath $verify -Recurse -File)
    if ($files.Count -ne 16) {
        throw ('BETA_KIT_UNEXPECTED_FILE_COUNT: ' + $files.Count)
    }
    foreach($line in $checksums) {
        $expected = $line.Substring(0,64)
        $relative = $line.Substring(66)
        if ((Get-FileHash -LiteralPath (Join-Path $verify $relative) -Algorithm SHA256).Hash -ine $expected) {
            throw 'BETA_KIT_PACKAGED_FILE_HASH_MISMATCH'
        }
    }
    Write-Output 'BETA_KIT_EXTRACTED_CONTENTS_VERIFIED'
    [pscustomobject]@{
        Zip = $output
        Files = $files.Count
        Bytes = (Get-Item -LiteralPath $output).Length
        SHA256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
        Commit = $ExpectedCommit
        ToastSHA256 = $toastHash
        AgentSHA256 = $agentHash
    } | ConvertTo-Json -Compress
} catch {
    # Only remove the ZIP that THIS invocation just created.
    if ($createdZip -and (Test-Path -LiteralPath $output)) {
        Remove-Item -LiteralPath $output -ErrorAction Stop
    }
    throw
} finally {
    # Delete only this invocation's unique staging directory.
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction Stop
    }
}
