$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or
    $env:GITHUB_REPOSITORY -cne 'muhamedsohaib/Tetherplane' -or
    $env:GITHUB_REF -cne 'refs/heads/work/github-release-readiness-20261030' -or
    $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$') { throw 'fresh hosted Windows candidate test only' }
if (@(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe' OR Name='tetherd-agentw.exe'").Count -ne 0 -or
    @(Get-ScheduledTask -TaskName 'Tetherplane*' -ErrorAction SilentlyContinue).Count -ne 0) {
    throw 'host already contains a Tetherplane agent or task'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$evidence = Join-Path $env:RUNNER_TEMP 'exact-candidate'
$verified = Join-Path $env:RUNNER_TEMP 'fresh-host-verified.json'
& python (Join-Path $repo 'scripts/release/github_candidate.py') attested $evidence $env:GITHUB_SHA $verified $env:GITHUB_RUN_ID $env:GITHUB_RUN_ATTEMPT
if ($LASTEXITCODE -ne 0) { throw 'expected upstream cryptographic verifier output missing or mismatched' }
$root = Join-Path $env:RUNNER_TEMP ('tetherplane-github-cleanhost-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $root 'package'
$install = Join-Path $root 'install'
$state = Join-Path $root 'state'
$allowed = Join-Path $root 'allowed'
$outside = Join-Path $root 'outside.txt'
function Assert-No-Owned-Process {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe' OR Name='tetherd-agentw.exe'" |
        Where-Object { [string]$_.ExecutablePath -and ([string]$_.ExecutablePath).StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) })
    if ($processes.Count -ne 0) { throw 'test-owned agent remains; refuse uninstall/cleanup' }
}
try {
    New-Item -ItemType Directory -Path $root, $allowed | Out-Null
    [IO.File]::WriteAllText($outside, 'OUTSIDE_MUST_NOT_BE_READ')
    $archive = Join-Path $evidence ('tetherplane-windows-x64-unsigned-' + $env:GITHUB_SHA + '.zip')
    Expand-Archive -LiteralPath $archive -DestinationPath $stage
    $inventory = Join-Path $evidence 'candidate-inventory.json'
    $inventoryHash = (Get-FileHash -LiteralPath $inventory -Algorithm SHA256).Hash.ToLowerInvariant()
    & node (Join-Path $repo 'scripts/release/windows-candidate-digests.mjs') verify $stage $env:GITHUB_SHA $inventory $inventoryHash
    if ($LASTEXITCODE -ne 0) { throw 'extracted payload differs from authenticated archive inventory' }
    foreach ($attempt in @(1, 2)) {
        & (Join-Path $stage 'install-windows.ps1') -PackagePath $stage -InstallPrefix $install -StateDir $state
        $receipt = Get-Content -LiteralPath (Join-Path $install 'config/install.json') -Raw | ConvertFrom-Json
        if ([string]$receipt.scheduled_task -or [bool]$receipt.state_created_by_installer -ne ($attempt -eq 1)) {
            throw 'unexpected task creation or state ownership'
        }
        foreach ($entry in (Get-Content -LiteralPath $inventory -Raw | ConvertFrom-Json).files) {
            if ($entry.path -match '^(bin|launch|adapters|protocol|browser)/') {
                $installedFile = Join-Path $install $entry.path
                if ((Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) {
                    throw 'installed bytes differ from authenticated candidate'
                }
            }
        }
        [IO.File]::WriteAllText((Join-Path $state 'retain.txt'), 'OWNER_STATE')
        & node (Join-Path $PSScriptRoot 'github-installed-smoke.mjs') $install $allowed $outside
        if ($LASTEXITCODE -ne 0) { throw 'installed launcher, core or path-denial smoke failed' }
        Assert-No-Owned-Process
        & (Join-Path $install 'uninstall-windows.ps1') -InstallPrefix $install
        if ((Test-Path -LiteralPath $install) -or
            [IO.File]::ReadAllText((Join-Path $state 'retain.txt')) -cne 'OWNER_STATE' -or
            [IO.File]::ReadAllText($outside) -cne 'OUTSIDE_MUST_NOT_BE_READ') { throw 'uninstall/state preservation failed' }
    }
    Write-Output 'EXACT_CANDIDATE_INSTALL_DENIAL_UNINSTALL_REINSTALL_OK'
    Write-Output 'PHYSICAL_SAC_PAIRING_REBOOT_FOUR_DEVICE_AND_VERSION_ROLLBACK_NOT_RUN_NO_GO'
} finally {
    Assert-No-Owned-Process
    $safeParent = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
    if ([IO.Path]::GetFullPath($root).StartsWith($safeParent + 'tetherplane-github-cleanhost-', [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}
