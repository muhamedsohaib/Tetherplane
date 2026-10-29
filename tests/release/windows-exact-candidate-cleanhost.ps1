param(
    [Parameter(Mandatory = $true)][string]$EvidenceDir,
    [Parameter(Mandatory = $true)][string]$ExpectedSource
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false

# This is NOT human/production acceptance. It runs only on a new GitHub-hosted
# Windows runner and only after an independent upstream attestation check.
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'RELEASE_NO_GO: acceptance must execute on Windows'
}
if ($env:GITHUB_REPOSITORY -cne 'muhamedsohaib/Tetherplane' -or
    $env:GITHUB_REF -cne 'refs/heads/test/windows-exact-candidate-cleanhost-20261030' -or
    $ExpectedSource -cne '9c0cf237609c282c169537f89de25bc7fe697532') {
    throw 'RELEASE_NO_GO: unexpected repository, runner ref, or source'
}
$existingAgents = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe' OR Name='tetherd-agentw.exe'" -ErrorAction Stop)
$existingTasks = @(Get-ScheduledTask -TaskName 'Tetherplane*' -ErrorAction SilentlyContinue)
if ($existingAgents.Count -ne 0 -or $existingTasks.Count -ne 0) {
    throw 'RELEASE_NO_GO: host is not an uncontaminated disposable Tetherplane test runner'
}
$registryValue = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'TetherplaneModelWorker' -ErrorAction SilentlyContinue
if ($null -ne $registryValue) {
    throw 'RELEASE_NO_GO: preexisting model-worker registration prevents isolated test'
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root = Join-Path $env:RUNNER_TEMP ('tetherplane-cleanhost-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $root 'extracted'
$install = Join-Path $root 'install'
$state = Join-Path $root 'state'
$allow = Join-Path $root 'allow'
$broken = Join-Path $root 'broken-package'
$sentinel = Join-Path $root 'outside-preserve.txt'
$stateMarker = Join-Path $state 'retain-after-uninstall.txt'
$archive = Join-Path $EvidenceDir ('tetherplane-windows-x64-unsigned-' + $ExpectedSource + '.zip')
$inventory = Join-Path $EvidenceDir 'candidate-inventory.json'
$record = Join-Path $EvidenceDir 'build-evidence.json'
$verifier = Join-Path $repo 'scripts\release\windows-candidate-digests.mjs'

function Assert-Scoped-No-Running-Agent {
    $owned = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe' OR Name='tetherd-agentw.exe'" -ErrorAction Stop |
        Where-Object { [string]$_.ExecutablePath -and [string]$_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
    if ($owned.Count -ne 0) { throw 'RELEASE_NO_GO: isolated agent process remains running' }
}

function Assert-BinaryIdentity {
    foreach ($name in @('tetherd.exe', 'tetherd-agentw.exe')) {
        $relative = Join-Path 'bin' $name
        $stagedHash = (Get-FileHash -LiteralPath (Join-Path $stage $relative) -Algorithm SHA256).Hash
        $installedHash = (Get-FileHash -LiteralPath (Join-Path $install $relative) -Algorithm SHA256).Hash
        if ($stagedHash -cne $installedHash) {
            throw "RELEASE_NO_GO: installed binary mismatch: $name"
        }
    }
}

function Invoke-Installed-Smoke {
    $script = Join-Path $install 'adapters\compact-mcp\smoke-six-tools.mjs'
    & node $script --tetherd (Join-Path $install 'bin\tetherd.exe') --allow $allow --state-dir $state
    if ($LASTEXITCODE -ne 0) { throw 'RELEASE_NO_GO: packaged Compact MCP functional smoke failed' }
    Assert-Scoped-No-Running-Agent
}

function Invoke-Clean-Install {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $stage 'install-windows.ps1') -PackagePath $stage -InstallPrefix $install -StateDir $state
    if ($LASTEXITCODE -ne 0) { throw 'RELEASE_NO_GO: actual packaged installer failed' }
    $timer.Stop()
    $installedManifest = Get-Content -LiteralPath (Join-Path $install 'manifest.json') -Raw | ConvertFrom-Json
    if ([string]$installedManifest.source_commit -cne $ExpectedSource) {
        throw 'RELEASE_NO_GO: installed manifest source mismatch'
    }
    Assert-BinaryIdentity
    Write-Output ('CLEANHOST_INSTALL_ELAPSED_MS=' + $timer.ElapsedMilliseconds)
}

function Invoke-Clean-Uninstall {
    Assert-Scoped-No-Running-Agent
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $install 'uninstall-windows.ps1') -InstallPrefix $install
    if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $install)) {
        throw 'RELEASE_NO_GO: clean uninstall failed or left its install prefix'
    }
    if ((Get-Content -LiteralPath $stateMarker -Raw) -cne 'PRESERVE') {
        throw 'RELEASE_NO_GO: uninstall altered user state'
    }
    if ((Get-Content -LiteralPath $sentinel -Raw) -cne 'DO-NOT-TOUCH') {
        throw 'RELEASE_NO_GO: uninstall touched outside scope'
    }
    Assert-Scoped-No-Running-Agent
}

try {
    if (Test-Path -LiteralPath $root) { throw 'RELEASE_NO_GO: test root exists' }
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf) -or
        -not (Test-Path -LiteralPath $record -PathType Leaf) -or
        -not (Test-Path -LiteralPath $inventory -PathType Leaf)) {
        throw 'RELEASE_NO_GO: verified evidence files are missing'
    }
    New-Item -ItemType Directory -Path $root,$allow,$broken | Out-Null
    [IO.File]::WriteAllText($sentinel, 'DO-NOT-TOUCH')
    Expand-Archive -LiteralPath $archive -DestinationPath $stage
    $metadata = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    & node $verifier verify $stage $ExpectedSource $inventory ([string]$metadata.inventory_sha256)
    if ($LASTEXITCODE -ne 0) { throw 'RELEASE_NO_GO: archive extraction differs from independently attested inventory' }
    Write-Output 'CLEANHOST_EXTRACT_INVENTORY_MATCH_OK'

    # Negative installation: deliberately incomplete package must fail BEFORE
    # creating either a new install prefix or a state directory.
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $stage 'install-windows.ps1') -PackagePath $broken -InstallPrefix $install -StateDir $state *> $null
    if ($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $state)) {
        throw 'RELEASE_NO_GO: invalid package caused installation or state mutation'
    }
    if ((Get-Content -LiteralPath $sentinel -Raw) -cne 'DO-NOT-TOUCH') {
        throw 'RELEASE_NO_GO: rejected install altered unrelated files'
    }
    Write-Output 'CLEANHOST_MISSING_PAYLOAD_DENIED_BEFORE_WRITE_OK'

    Invoke-Clean-Install
    $receipt = Get-Content -LiteralPath (Join-Path $install 'config\install.json') -Raw | ConvertFrom-Json
    if (-not [bool]$receipt.state_created_by_installer -or [string]$receipt.scheduled_task) {
        throw 'RELEASE_NO_GO: clean install incorrectly claimed ownership or registered a task'
    }
    [IO.File]::WriteAllText($stateMarker, 'PRESERVE')
    Invoke-Installed-Smoke
    Write-Output 'CLEANHOST_FIRST_SIX_TOOL_STATUS_OK'
    Invoke-Clean-Uninstall
    Write-Output 'CLEANHOST_FIRST_UNINSTALL_PRESERVED_STATE_OK'

    # Reinstall the exact same candidate into the now-vacant prefix. This is
    # recovery/idempotence evidence, NOT rollback from a previous version.
    Invoke-Clean-Install
    $secondReceipt = Get-Content -LiteralPath (Join-Path $install 'config\install.json') -Raw | ConvertFrom-Json
    if ([bool]$secondReceipt.state_created_by_installer -or [string]$secondReceipt.scheduled_task) {
        throw 'RELEASE_NO_GO: reinstall claimed previously preserved state'
    }
    if ((Get-Content -LiteralPath $stateMarker -Raw) -cne 'PRESERVE') {
        throw 'RELEASE_NO_GO: reinstall altered existing state'
    }
    Invoke-Installed-Smoke
    Invoke-Clean-Uninstall
    Write-Output 'CLEANHOST_EXACT_ARCHIVE_REINSTALL_RECOVERY_OK'
    Write-Output 'UPGRADE_ROLLBACK_NOT_TESTED_NO_GO'
    Write-Output 'EXACT_CANDIDATE_FRESH_HOST_NO_PRODUCTION_ACCEPTANCE_PASS'
}
finally {
    # The unique GUID directory is created exclusively under RUNNER_TEMP; no
    # production path, credential, scheduled task, or registry key is modified.
    $safeBase = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
    $safeRoot = [IO.Path]::GetFullPath($root)
    if ($safeRoot.StartsWith($safeBase + 'tetherplane-cleanhost-', [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $root)) {
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}
