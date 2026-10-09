# Guard activation of the already-registered DISABLED Vaulter auth startup task.
# Pure scripted handover tests run without touching live tasks, services or tokens.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$activationPath = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-activate.ps1'
if (-not (Test-Path -LiteralPath $activationPath -PathType Leaf)) {
    throw 'Missing guarded Vaulter auth activation script.'
}
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $activationPath).Path,
    [ref]$null, [ref]$null
)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $activationPath).Path,
    [ref]$tokens, [ref]$errors
)
if (@($errors).Count -ne 0) { throw 'Activation script does not parse.' }
$src = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $activationPath).Path)
foreach ($guard in @(
    '[switch]$Activate', 'COMPUTERNAME', 'vaulter',
    'Tetherplane-TetherAuth-Startup',
    'Disabled', 'S4U', 'BootTrigger', 'RestartCount', 'AreAccessRulesProtected',
    '127.0.0.1:8788', '127.0.0.1:8790', '/jwks',
    'Get-NetTCPConnection', 'Get-CimInstance', 'Win32_Process',
    'Get-Process', 'Enable-ScheduledTask', 'Disable-ScheduledTask',
    'Start-ScheduledTask', 'Stop-ScheduledTask',
    'Stop-Process', 'Start-Process',
    'Get-FileHash', 'Invoke-GuardedAuthHandover',
    'VerifyExistingAuth', 'VerifySupervisedAuth', 'VerifyRestoredAuth',
    'TETHERPLANE_AUTH_BRIDGE_TOKEN', 'bridge-token.secret',
    'No changes made', 'No identities or secrets printed'
)) {
    if (-not $src.Contains($guard)) {
        throw "Activation missing mandatory safety gate: $guard"
    }
}
if ($src -match '(?i)funnel\s+(reset|--https=443\s+off)' -or
    $src -match '(?i)gh auth token' -or
    $src -match '(?i)Stop-Process\s+-Name\s+node') {
    throw 'Activation must not change Funnel or stop processes by name.'
}
if ($src -match '(?i)Unregister-ScheduledTask|Register-ScheduledTask') {
    throw 'Activation must not mutate or recreate task registrations.'
}
if ($src -match '(?im)^\s*\$pid\s*=') {
    throw 'Activation must not assign to PowerShell reserved PID variable.'
}
if ($src -notmatch '(?m)if \(-not \$Activate\)') {
    throw 'Default mode must be read-only.'
}

$handover = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Invoke-GuardedAuthHandover'
}, $true)
if ($null -eq $handover) { throw 'Missing separately testable handover transaction.' }
Invoke-Expression $handover.Extent.Text

function New-OperationFixture([string]$FailAt) {
    $events = New-Object 'System.Collections.Generic.List[string]'
    $ops = @{}
    foreach ($key in @('StopStage','EnableTask','StartTask','VerifyNew',
                       'StopTask','DisableTask','RestoreStage','VerifyRestore')) {
        $operation = $key
        $ops[$key] = {
            $events.Add($operation)
            if ($FailAt -ceq $operation) { throw "fixture failure: $operation" }
        }.GetNewClosure()
    }
    return @{ ops=$ops; events=$events }
}

$good = New-OperationFixture ''
$result = Invoke-GuardedAuthHandover -Operations $good.ops
if ($result -cne 'activated' -or
    ($good.events -join ',') -cne 'StopStage,EnableTask,StartTask,VerifyNew') {
    throw 'Successful activation must stop only staging auth, enable/start task, and verify.'
}
foreach ($step in @('StopStage', 'EnableTask', 'StartTask', 'VerifyNew')) {
    $failed = New-OperationFixture $step
    $message = ''
    try {
        Invoke-GuardedAuthHandover -Operations $failed.ops | Out-Null
        throw 'Activation unexpectedly succeeded.'
    } catch {
        $message = $_.Exception.Message
    }
    if ($message -notmatch 'rolled back') {
        throw "Failure at $step did not report successful rollback: $message"
    }
    $events = $failed.events -join ','
    if ($events -notmatch 'StopTask,DisableTask,RestoreStage,VerifyRestore$') {
        throw "Failure at $step did not stop and disable the task and restore old auth: $events"
    }
}
$rollbackFailure = New-OperationFixture 'VerifyRestore'
$rollbackMessage = ''
try {
    Invoke-GuardedAuthHandover -Operations $rollbackFailure.ops | Out-Null
    throw 'Rollback failure unexpectedly succeeded.'
} catch {
    $rollbackMessage = $_.Exception.Message
}
# The fixture with VerifyRestore failure needs a primary error; fake it via VerifyNew.
$rollbackFailure.ops['VerifyNew'] = { throw 'fixture verification failure' }
$rollbackMessage = ''
try {
    Invoke-GuardedAuthHandover -Operations $rollbackFailure.ops | Out-Null
    throw 'Rollback failure unexpectedly succeeded.'
} catch {
    $rollbackMessage = $_.Exception.Message
}
if ($rollbackMessage -notmatch 'rollback unverified') {
    throw 'Failed rollback must report incomplete recovery instead of success.'
}
Write-Output 'Guarded staged-auth activation and rollback contracts passed.'
