# Read-only-by-default supervised-auth process recovery rehearsal.
# The contract mocks side effects; it is safe on GitHub-hosted Windows runners.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$path = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-recovery-rehearsal.ps1'
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw 'Missing restart recovery rehearsal.'
}
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $path).Path, [ref]$tokens, [ref]$errors
)
if (@($errors).Count -gt 0) { throw 'Restart rehearsal must parse on Windows.' }
$src = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach ($required in @(
    '[switch]$Exercise', 'COMPUTERNAME', 'vaulter',
    'if (-not $Exercise)', 'No changes made',
    'Tetherplane-TetherAuth-Startup', 'Get-ScheduledTask',
    'Get-NetTCPConnection', 'Get-CimInstance', 'Win32_Process',
    'ParentProcessId', 'CreationDate', 'Stop-Process',
    'Start-ScheduledTask', 'Stop-ScheduledTask', 'Disable-ScheduledTask',
    'Start-Process', 'RestartCount', 'RestartInterval', 'BootTrigger', 'S4U',
    'AreAccessRulesProtected', 'Get-FileHash',
    'tether-auth-supervised-postcheck.ps1',
    '127.0.0.1:8790', '127.0.0.1:8788',
    'https://tetherplane-dev.eu.auth0.com/',
    'bridge-token.secret', 'TETHERPLANE_AUTH_BRIDGE_TOKEN',
    'Invoke-RestartRecoveryTransaction', 'Wait-SupervisedAuth',
    'Restore-StagedAuth', 'Get-TaskOwnedListener',
    'RESTART AUTOMATICALLY VERIFIED', 'manual task restart verified',
    'staged auth restored', 'rollback unverified',
    'Reboot recovery remains unverified'
)) {
    if (-not $src.Contains($required)) {
        throw "Restart rehearsal is missing essential safeguard: $required"
    }
}
if ($src -match '(?i)\btailscale\s+(?:funnel|serve)\s+(?:--bg|--set-path|reset|off)' -or
    $src -match '(?i)\bgh auth token\b' -or
    $src -match '(?i)Stop-Process\s+-Name\s+node') {
    throw 'Restart rehearsal must not modify Funnel, disclose credentials, or kill Node by name.'
}
if ($src -match '(?im)^\s*\$pid\s*=') {
    throw 'Do not assign to PowerShell reserved PID variable.'
}
if ($src -match '(?i)Unregister-ScheduledTask|Register-ScheduledTask|Set-ScheduledTask') {
    throw 'Recovery rehearsal cannot re-register task definitions.'
}
if ($src -match '(?im)Write-(?:Output|Host|Warning|Error)\s+.*(?:CommandLine|UserId|SecurityIdentifier|bridgeToken|privateKey)') {
    throw 'Recovery rehearsal must not print process arguments or secrets.'
}
$transaction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Invoke-RestartRecoveryTransaction'
}, $true)
if ($null -eq $transaction) { throw 'Recovery transaction must be unit-testable.' }
Invoke-Expression $transaction.Extent.Text

function New-RecoveryFixture([string[]]$FailSteps) {
    $events = New-Object 'System.Collections.Generic.List[string]'
    $operations = @{}
    foreach ($step in @(
        'VerifyBaseline', 'VerifyCrashTarget', 'CrashOwnedAuth', 'WaitAutomatic',
        'StartTaskManually', 'WaitManual',
        'DisableTask', 'StopTask', 'ClearOwnedListener',
        'RestoreStage', 'VerifyStage'
    )) {
        $name = $step
        $operations[$step] = {
            $events.Add($name)
            if ($FailSteps -ccontains $name) { throw "simulated operation failed" }
        }.GetNewClosure()
    }
    return @{ Operations=$operations; Events=$events }
}

$automatic = New-RecoveryFixture @()
$result = Invoke-RestartRecoveryTransaction -Operations $automatic.Operations
if ($result -cne 'automatic' -or
    ($automatic.Events -join ',') -cne 'VerifyBaseline,VerifyCrashTarget,CrashOwnedAuth,WaitAutomatic') {
    throw 'Automatic restart must finish without manually disturbing task or restoring old service.'
}
$manual = New-RecoveryFixture @('WaitAutomatic')
$result = Invoke-RestartRecoveryTransaction -Operations $manual.Operations
if ($result -cne 'manual_only' -or
    ($manual.Events -join ',') -cne 'VerifyBaseline,VerifyCrashTarget,CrashOwnedAuth,WaitAutomatic,StartTaskManually,WaitManual') {
    throw 'Manual task recovery must not be misrepresented as automatic recovery.'
}
$rolled = New-RecoveryFixture @('WaitAutomatic','WaitManual')
try {
    Invoke-RestartRecoveryTransaction -Operations $rolled.Operations | Out-Null
    throw 'Recovery failure returned success.'
} catch {
    if ($_.Exception.Message -eq 'Recovery failure returned success.') { throw }
    if ($_.Exception.Message -notmatch 'staged auth restored') { throw }
}
if (($rolled.Events -join ',') -notmatch 'DisableTask,StopTask,ClearOwnedListener,RestoreStage,VerifyStage$') {
    throw 'Failed task recovery must disable the task and verify staged auth before reporting rollback.'
}
$unverified = New-RecoveryFixture @('WaitAutomatic','WaitManual','VerifyStage')
try {
    Invoke-RestartRecoveryTransaction -Operations $unverified.Operations | Out-Null
    throw 'Unverified rollback returned success.'
} catch {
    if ($_.Exception.Message -eq 'Unverified rollback returned success.') { throw }
    if ($_.Exception.Message -notmatch 'rollback unverified') { throw }
}
$targetFail = New-RecoveryFixture @('VerifyCrashTarget')
try {
    Invoke-RestartRecoveryTransaction -Operations $targetFail.Operations | Out-Null
    throw 'Failed target guard unexpectedly passed.'
} catch {
    if ($_.Exception.Message -eq 'Failed target guard unexpectedly passed.') { throw }
}
if (($targetFail.Events -join ',') -cne 'VerifyBaseline,VerifyCrashTarget') {
    throw 'A changed process must not be killed or trigger a recovery operation.'
}

$baselineFail = New-RecoveryFixture @('VerifyBaseline')
try {
    Invoke-RestartRecoveryTransaction -Operations $baselineFail.Operations | Out-Null
    throw 'Failed baseline unexpectedly passed.'
} catch {
    if ($_.Exception.Message -eq 'Failed baseline unexpectedly passed.') { throw }
}
if (($baselineFail.Events -join ',') -cne 'VerifyBaseline') {
    throw 'No mutations or recovery operations are allowed when baseline verification fails.'
}
# Never revive an unsupervised staged server while the S4U task remains
# enabled: a later automatic restart could race it for port 8790.
$restoreAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Restore-StagedAuth'
}, $true)
if ($null -eq $restoreAst) { throw 'Missing guarded stage restoration.' }
$restoreSource = $restoreAst.Extent.Text
if ($restoreSource -notmatch [regex]::Escape("Assert-Recovery ((Get-Task).State -eq 'Disabled')")) {
    throw 'Fallback must verify the S4U startup task is disabled before relaunching stage.'
}

Write-Output 'Guarded supervised auth restart transaction and rollback contracts passed.'
