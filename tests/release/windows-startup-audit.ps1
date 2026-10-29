$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$auditScript = Join-Path $repo 'scripts\audit-windows-startup.ps1'
$installer = Join-Path $repo 'scripts\install-windows.ps1'
if (!(Test-Path -LiteralPath $auditScript -PathType Leaf)) { throw 'missing audit script' }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('tp-startup-audit-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -Path $fixture -ItemType Directory -Force | Out-Null
    $resultJson = & $auditScript -InstallPrefix $fixture | Out-String
    $result = $resultJson | ConvertFrom-Json
    if ($result.mode -ne 'audit_only' -or $result.schema -ne 1) { throw 'audit schema mismatch' }
    if ($result.signatureStatus -ne 'missing') { throw 'unsigned fixture was approved' }
    if ($result.relayFlagPresent -or $result.credentialFileFlagPresent) { throw 'invented transport configuration' }
    if ($resultJson -match '(?i)bearer\s+\S+|password\s*[:=]') { throw 'possible credential leak in audit' }
    $source = Get-Content -LiteralPath $installer -Raw
    if ($source -notmatch 'WindowStyle Hidden') { throw 'legacy background window style missing' }
    $sourceOfAudit = Get-Content -LiteralPath $auditScript -Raw
    if ($sourceOfAudit -notmatch 'native_agent' -or
        $sourceOfAudit -notmatch 'nativeArgumentsFileOnly') {
        throw 'auditor cannot distinguish native owned tasks from legacy PowerShell supervisors'
    }
    # Use an isolated synthetic registry key, not the runner's actual
    # HKCU Run key. Audit only Tetherplane-named autoruns, never values.
    $runKey = Join-Path 'HKCU:\Software\Tetherplane\ci-startup-audit' ([guid]::NewGuid().ToString('N'))
    try {
        New-Item -Path $runKey -Force | Out-Null
        $secret = 'SYNTHETIC_PRIVATE_COMMAND_SENTINEL'
        $dummy = 'powershell.exe -NoProfile -WindowStyle Hidden -File "C:\ci\model-worker.ps1" --token ' + $secret
        New-ItemProperty -Path $runKey -Name 'TetherplaneModelWorker' -Value $dummy -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $runKey -Name 'ForeignStartup' -Value ('keep-private ' + $secret) -PropertyType String -Force | Out-Null
        $raw = & $auditScript -InstallPrefix $fixture -RunKeyPath $runKey | Out-String
        $report = $raw | ConvertFrom-Json
        if (@($report.autoruns).Count -ne 1) { throw 'expected one Tetherplane HKCU autorun, not foreign entries' }
        if ($report.autoruns[0].name -cne 'TetherplaneModelWorker') { throw 'autorun identity was lost' }
        if (-not $report.autoruns[0].usesPowerShell -or
            -not $report.autoruns[0].requestsHiddenWindow) {
            throw 'autorun command-type classification failed'
        }
        if ($raw.Contains($secret) -or $raw.Contains('C:\ci\model-worker.ps1')) {
            throw 'private startup command or token leaked into diagnostic output'
        }
        if (-not (Test-Path -LiteralPath $runKey)) { throw 'audit modified test registry' }
    } finally {
        Remove-Item -LiteralPath $runKey -Recurse -Force -ErrorAction SilentlyContinue
    }
    # A never-started, GUID-scoped scheduled task proves actual Scheduler
    # classification. Cleanup occurs even when an assertion fails.
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows') {
        throw 'synthetic task fixture must run only on hosted Windows CI'
    }
    $name = 'Tetherplane CI-Audit-' + [guid]::NewGuid().ToString('N')
    $created = $false
    try {
        $dummyLauncher = Join-Path $fixture 'ci-supervisor.ps1'
        Set-Content -LiteralPath $dummyLauncher -Value '# never executed'
        $dummySecret = 'SYNTHETIC_TASK_ARGUMENT_PRIVATE'
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
            '-NoProfile -NonInteractive -WindowStyle Hidden -File "' +
            $dummyLauncher + '" --token ' + $dummySecret
        )
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -Disable -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
        $created = $true
        $json = & $auditScript -InstallPrefix $fixture | Out-String
        $report = $json | ConvertFrom-Json
        $entry = @($report.tasks | Where-Object { $_.name -ceq $name })
        if ($entry.Count -ne 1) { throw 'synthetic scheduled task not discovered' }
        if ($entry[0].taskKind -cne 'powershell_supervisor' -or
            -not $entry[0].requestsHiddenWindow) {
            throw 'real Task Scheduler action was misclassified'
        }
        if ($entry[0].cleanupDisposition -cne 'hold_unknown') {
            throw 'unknown scheduled tasks must not be eligible for automatic deletion'
        }
        if ($json.Contains($dummySecret)) {
            throw 'private scheduled action arguments leaked'
        }
    } finally {
        if ($created) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
        }
    }
    Write-Output 'WINDOWS_STARTUP_AUDIT=PASS'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
