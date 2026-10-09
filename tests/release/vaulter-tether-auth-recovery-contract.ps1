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
    'AreAccessRulesProtected', 'Get-VerifiedRunnerVersion', 'vaulter-tether-auth-startup-runner-v2.ps1',
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


# A fault-injection gate must NOT accept the former out-of-schema count 999.
# Exercise exact registered XML/CIM agreement without querying any real task.
$restartPolicyAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Test-RegisteredRestartPolicy'
}, $true)
if ($null -eq $restartPolicyAst) {
    throw 'Recovery preflight is missing its independent registered restart-policy gate.'
}
Invoke-Expression $restartPolicyAst.Extent.Text
$validXml = '<Task><Settings><RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure></Settings></Task>'
$badXml = $validXml.Replace('<Count>10</Count>', '<Count>999</Count>')
$badInterval = $validXml.Replace('<Interval>PT1M</Interval>', '<Interval>PT2M</Interval>')
$validSettings = [pscustomobject]@{ RestartCount=10; RestartInterval='PT1M' }
$cases = @(
    @{ Name='repaired'; CIM=$validSettings; XML=$validXml; Expected=$true },
    @{ Name='out-of-range-XML'; CIM=$validSettings; XML=$badXml; Expected=$false },
    @{ Name='out-of-range-CIM'; CIM=([pscustomobject]@{RestartCount=999; RestartInterval='PT1M'}); XML=$validXml; Expected=$false },
    @{ Name='wrong-interval-XML'; CIM=$validSettings; XML=$badInterval; Expected=$false },
    @{ Name='wrong-interval-CIM'; CIM=([pscustomobject]@{RestartCount=10; RestartInterval='PT2M'}); XML=$validXml; Expected=$false },
    @{ Name='missing-policy'; CIM=$validSettings; XML='<Task><Settings /></Task>'; Expected=$false }
)
foreach ($case in $cases) {
    $actual = Test-RegisteredRestartPolicy -Settings $case.CIM -TaskXml $case.XML
    if ([bool]$actual -ne [bool]$case.Expected) {
        throw "Registered restart-policy gate failed fixture $($case.Name)."
    }
}
if (-not $src.Contains('Test-RegisteredRestartPolicy -Settings $task.Settings -TaskXml')) {
    throw 'Recovery script must invoke registered restart-policy gate before fault injection.'
}


# Supervisor instance refresh is a separate, explicitly enabled transaction.
# Its default must remain read-only; it must not misreport manual recovery as a refresh.
foreach ($required in @(
    '[switch]$RefreshSupervisor', 'if ($Exercise -and $RefreshSupervisor)',
    'Invoke-GuardedSupervisorRefresh', 'Settings.Enabled',
    'Stop-ScheduledTask', 'Enable-ScheduledTask',
    'SUPERVISOR INSTANCE REFRESH VERIFIED', 'SUPERVISOR REFRESH FAILED',
    'original listener PID', 'public signing keys',
    'Task instance restart does not prove automatic recovery'
)) {
    if (-not $src.Contains($required)) {
        throw "Supervisor refresh missing required safety marker: $required"
    }
}
$refreshAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Invoke-GuardedSupervisorRefresh'
}, $true)
if ($null -eq $refreshAst) { throw 'Missing standalone supervisor-refresh transaction.' }
Invoke-Expression $refreshAst.Extent.Text

function New-RefreshFixture([string[]]$Failures) {
    $events = New-Object 'System.Collections.Generic.List[string]'
    $ops = @{}
    foreach ($step in @(
        'VerifyBaseline', 'VerifyTarget', 'QuiesceTask', 'StopOwnedTask',
        'VerifyVacant', 'ReenableTask', 'StartTask', 'VerifyNewTask',
        'RestoreTask', 'VerifyRecoveredTask',
        'DisableTask', 'StopTask', 'ClearListener',
        'RecoverOriginalV1', 'VerifyRecoveredV1', 'RestoreStage', 'VerifyStage'
    )) {
        $name = $step
        $ops[$step] = {
            $events.Add($name)
            if ($Failures -ccontains $name) { throw 'simulated supervisor refresh failure' }
        }.GetNewClosure()
    }
    return @{ Operations=$ops; Events=$events }
}

$refresh = New-RefreshFixture @()
if ((Invoke-GuardedSupervisorRefresh -Operations $refresh.Operations) -cne 'refreshed' -or
    ($refresh.Events -join ',') -cne 'VerifyBaseline,VerifyTarget,QuiesceTask,StopOwnedTask,VerifyVacant,ReenableTask,StartTask,VerifyNewTask') {
    throw 'Successful refresh must quiesce once, stop the owned instance, start and verify a new instance.'
}

foreach ($failed in @('VerifyBaseline', 'VerifyTarget')) {
    $fixture = New-RefreshFixture @($failed)
    try {
        Invoke-GuardedSupervisorRefresh -Operations $fixture.Operations | Out-Null
        throw 'Unexpected success after refresh precondition failed.'
    } catch {
        if ($_.Exception.Message -eq 'Unexpected success after refresh precondition failed.') { throw }
    }
    if ($fixture.Events -ccontains 'QuiesceTask' -or $fixture.Events -ccontains 'StopOwnedTask') {
        throw 'Preflight failure must not modify or stop the original supervisor.'
    }
}
foreach ($failed in @('QuiesceTask','StopOwnedTask','VerifyVacant','ReenableTask','StartTask','VerifyNewTask')) {
    $fixture = New-RefreshFixture @($failed)
    $result = Invoke-GuardedSupervisorRefresh -Operations $fixture.Operations
    if ($result -cne 'manually_restored' -or
        ($fixture.Events -join ',') -notmatch 'RestoreTask,VerifyRecoveredTask$') {
        throw 'Failed refresh must verify manual task recovery without claiming success.'
    }
}
$recoverV1 = New-RefreshFixture @('VerifyNewTask','VerifyRecoveredTask')
if ((Invoke-GuardedSupervisorRefresh -Operations $recoverV1.Operations) -cne 'v1_restored' -or
    ($recoverV1.Events -join ',') -notmatch 'DisableTask,StopTask,ClearListener,RecoverOriginalV1,VerifyRecoveredV1$' -or
    $recoverV1.Events -ccontains 'RestoreStage') {
    throw 'Failed v2 and manual recovery must restore verified v1 before staged fallback.'
}
foreach ($failedV1 in @('RecoverOriginalV1','VerifyRecoveredV1')) {
    $fallback = New-RefreshFixture @('VerifyNewTask','VerifyRecoveredTask',$failedV1)
    try {
        Invoke-GuardedSupervisorRefresh -Operations $fallback.Operations | Out-Null
        throw 'Fallback to staged auth may never be called a successful refresh.'
    } catch {
        if ($_.Exception.Message -eq 'Fallback to staged auth may never be called a successful refresh.') { throw }
        if ($_.Exception.Message -notmatch 'staged auth restored') { throw }
    }
    if (($fallback.Events -join ',') -notmatch 'DisableTask,StopTask,ClearListener,RestoreStage,VerifyStage$') {
        throw 'Failed verified-v1 task recovery must still recover staged auth.'
    }
}
$unverified = New-RefreshFixture @('VerifyNewTask','VerifyRecoveredTask','RecoverOriginalV1','VerifyStage')
try {
    Invoke-GuardedSupervisorRefresh -Operations $unverified.Operations | Out-Null
    throw 'Rollback failure must never return success.'
} catch {
    if ($_.Exception.Message -eq 'Rollback failure must never return success.') { throw }
    if ($_.Exception.Message -notmatch 'rollback unverified') { throw }
}
foreach ($required in @(
    'RecoverOriginalV1', 'VerifyRecoveredV1', 'v1_restored',
    'SUPERVISOR REFRESH FAILED; verified original v1 task restored',
    '$script:offlineRescue', '-RestoreV1', '-EnableV1Task', '-StartV1Task'
)) {
    if (-not $src.Contains($required)) {
        throw "Guarded refresh has no verified offline v1 rescue before staged fallback: $required"
    }
}
if ($src -notmatch '(?s)if \(\$installedRunnerVersion -ceq .v2.\).*?\& \$script:offlineRescue') {
    throw 'Activation must preflight offline v1 rescue before any supervisor disruption.'
}


# Crash traces must distinguish a stuck original task parent from a failed
# task completion before the test enters the manual-recovery fallback.
$traceAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Format-RecoveryObservation'
}, $true)
if ($null -eq $traceAst) {
    throw 'Missing redacted, testable restart-lifecycle observation formatter.'
}
Invoke-Expression $traceAst.Extent.Text
$fixture = Format-RecoveryObservation -Phase 'automatic' -ElapsedSeconds 20 -ParentAlive $true -TaskState 'Running' -ResultCode '0x00041301' -ListenerState 'none'
if ($fixture -cne 'RESTART TRACE: phase=automatic; elapsed_s=20; original_parent=alive; task=Running; scheduler_result=0x00041301; listener=none') {
    throw 'Trace does not identify a still-running task parent after listener disappeared.'
}
$exited = Format-RecoveryObservation -Phase 'automatic' -ElapsedSeconds 40 -ParentAlive $false -TaskState 'Ready' -ResultCode '0x00000001' -ListenerState 'none'
if ($exited -cne 'RESTART TRACE: phase=automatic; elapsed_s=40; original_parent=exited; task=Ready; scheduler_result=0x00000001; listener=none') {
    throw 'Trace must distinguish a failed task completion from a stuck parent.'
}
$untrusted = Format-RecoveryObservation -Phase 'automatic;secret=sensitive' -ElapsedSeconds 60 -ParentAlive $false -TaskState "Running;token=secret" -ResultCode 'credentials' -ListenerState "new;credential=secret"
if ($untrusted -match 'secret|sensitive|credentials' -or
    $untrusted -notmatch 'phase=unknown;.*task=Unknown; scheduler_result=unknown; listener=unknown') {
    throw 'Restart observations must never print uncontrolled strings.'
}
$waitAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Wait-SupervisedAuth'
}, $true)
if ($null -eq $waitAst -or
    $waitAst.Extent.Text -notmatch 'Format-RecoveryObservation' -or
    $waitAst.Extent.Text -notmatch 'Get-ScheduledTaskInfo' -or
    $waitAst.Extent.Text -notmatch 'Write-Host') {
    throw 'Automatic wait must emit bounded observations outside the result pipeline.'
}
if (-not $src.Contains('Wait-SupervisedAuth -PriorPid $script:originalPid -Attempts 75 -TraceAutomatic')) {
    throw 'Automatic recovery phase must explicitly enable lifecycle tracing.'
}

Write-Output 'Guarded supervised auth restart transaction and rollback contracts passed.'
