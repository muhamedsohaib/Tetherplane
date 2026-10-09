# Guard the self-hosted auth autostart runner and registration.
# Run under Windows PowerShell 5.1 and 7 without modifying tasks.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$base = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$registrationPath = Join-Path $base 'scripts\vaulter-tether-auth-autostart.ps1'
$runnerPath = Join-Path $base 'scripts\vaulter-tether-auth-startup-runner.ps1'
foreach ($path in @($registrationPath, $runnerPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'Autostart registration/runner scripts are missing.'
    }
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
    if (@($errors).Count -gt 0) { throw 'Autostart script contains syntax errors.' }
}
$registration = [IO.File]::ReadAllText($registrationPath)
$runner = [IO.File]::ReadAllText($runnerPath)

foreach ($required in @(
    'COMPUTERNAME', 'vaulter', '[switch]$Probe', '[switch]$Register',
    'New-ScheduledTaskPrincipal', '-LogonType S4U', '-RunLevel Limited',
    'New-ScheduledTaskTrigger -AtStartup', 'RestartInterval', 'RestartCount',
    'MultipleInstances IgnoreNew', 'ExecutionTimeLimit', 'StartWhenAvailable',
    'Register-ScheduledTask', 'Unregister-ScheduledTask', 'Start-ScheduledTask',
    'Tetherplane-TetherAuth-Startup', 'task already exists',
    'ProbeResultFile', 'Get-ScheduledTask', 'No permanent changes made',
    'auth-state', 'AreAccessRulesProtected', 'Copy-Item',
    'No existing service was restarted', 'Get-ActionArguments'
)) {
    if (-not $registration.Contains($required)) {
        throw "Autostart registrar missing required safeguard: $required"
    }
}
foreach ($required in @(
    '127.0.0.1:8788', '127.0.0.1:8790',
    'TETHERPLANE_AUTH_BRIDGE_TOKEN', 'bridge-token.secret', 'tether-auth-jwks.json',
    'tether-auth-config.json', '[switch]$Validate', '[switch]$Serve',
    'ProbeResultFile', 'AreAccessRulesProtected', 'No secrets are printed',
    '--allow-insecure-localhost', 'auth\dist\cli.js'
)) {
    if (-not $runner.Contains($required)) {
        throw "Autostart runner missing safeguard: $required"
    }
}
foreach ($danger in @(
    'gh auth token', 'funnel reset', 'serve reset', 'TaskName Tetherplane-Relay',
    'TETHERPLANE_AUTH_BRIDGE_TOKEN='
)) {
    if ($registration.Contains($danger)) {
        throw 'Unsafe command or inline secret found in autostart registration.'
    }
}
if ($registration -match '(?i)\b-RunLevel\s+Highest\b' -or
    $registration -match '(?im)New-ScheduledTaskPrincipal.*-UserId\s+[''"]?(?:NT AUTHORITY\\)?SYSTEM\b' -or
    $registration -match '(?i)\b-LogonType\s+(?:Password|ServiceAccount)\b') {
    throw 'Autostart must not request elevation, SYSTEM, or a stored password.'
}
if ($registration -notmatch '(?m)if \(-not \$Probe -and -not \$Register\)') {
    throw 'Autostart default must be read-only.'
}
if ($registration -match '(?im)^\s*(?:New-ScheduledTaskAction|Register-ScheduledTask).*bridgeToken') {
    throw 'Never put the bridge credential into a scheduled task action.'
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($registrationPath, [ref]$tokens, [ref]$errors)
$func = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Get-ActionArguments'
}, $true)
if ($null -eq $func) { throw 'Missing autostart action argument builder.' }
Invoke-Expression $func.Extent.Text
$sample = Get-ActionArguments -RunnerPath 'C:\test path\runner.ps1' `
    -StateDirectory 'C:\protected state' -RepoRoot 'C:\source code' `
    -NodeExecutable 'C:\Program Files\nodejs\node.exe' -Mode Validate `
    -ProbeResultFile 'C:\protected state\probe-result.txt'
if ($sample -notmatch '"C:\\test path\\runner.ps1"' -or
    $sample -notmatch '"C:\\protected state"' -or
    $sample -notmatch '"C:\\Program Files\\nodejs\\node.exe"' -or
    $sample -notmatch '\-Validate' -or $sample -notmatch '\-ProbeResultFile') {
    throw 'Action argument quoting or explicit operation flag is incorrect.'
}
foreach ($segment in @('bad"quote', "bad`nnewline")) {
    try {
        Get-ActionArguments -RunnerPath $segment -StateDirectory 'C:\safe' `
            -RepoRoot 'C:\safe' -NodeExecutable 'C:\node.exe' -Mode Serve | Out-Null
        throw 'Action argument builder accepted unsafe injected input.'
    } catch {
        if ($_.Exception.Message -eq 'Action argument builder accepted unsafe injected input.') {
            throw
        }
    }
}
# Cleanup failure must block promotion from a one-time probe to a startup task.
foreach ($gate in @(
    '$probeCleanupSucceeded = $false',
    'Assert-Autostart $probeCleanupSucceeded'
)) {
    if (-not $registration.Contains($gate)) {
        throw "S4U probe cleanup must fail closed before permanent registration: $gate"
    }
}

# Task Scheduler XML RestartOnFailure/Count is limited to 1..255.
$matchesCount = [regex]::Matches($registration, '-RestartCount\s+(\d+)')
if ($matchesCount.Count -ne 1) {
    throw 'Startup task definition must set one explicit RestartCount.'
}
$requestedCount = [int]$matchesCount[0].Groups[1].Value
if ($requestedCount -lt 1 -or $requestedCount -gt 255) {
    throw 'New startup tasks must never register an out-of-schema restart count.'
}


# The live v1 task runner must stay byte-for-byte compatible until a separate
# verified deployment. Stage a testable v2 candidate rather than modifying it.
$v2Path = Join-Path $base 'scripts\vaulter-tether-auth-startup-runner-v2.ps1'
if (-not (Test-Path -LiteralPath $v2Path -PathType Leaf)) {
    throw 'Missing isolated v2 child-supervisor candidate (live runner must remain unchanged).'
}
$v2Tokens = $null
$v2Errors = $null
$v2Ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $v2Path, [ref]$v2Tokens, [ref]$v2Errors
)
if (@($v2Errors).Count -ne 0) { throw 'Candidate child-supervisor script does not parse.' }
$v2 = [IO.File]::ReadAllText($v2Path)
foreach ($guard in @(
    '[switch]$Validate', '[switch]$Serve', 'ProbeResultFile',
    'AreAccessRulesProtected', 'bridge-token.secret',
    'TETHERPLANE_AUTH_BRIDGE_TOKEN', '127.0.0.1:8790',
    '127.0.0.1:8788', '--allow-insecure-localhost',
    'auth\dist\cli.js', 'Invoke-TetherAuthChildSupervisor',
    'AssertPortVacant', 'RunChild', 'PauseBeforeRestart'
)) {
    if (-not $v2.Contains($guard)) {
        throw "v2 supervisor candidate is missing protected contract: $guard"
    }
}
if ($v2 -match '(?i)\b(?:Stop-Process|Register-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask|gh auth token)\b' -or
    $v2 -match '(?i)\b(?:tailscale funnel|tailscale serve|Set-Clipboard)\b' -or
    $v2 -match '(?im)^\s*Write-(?:Output|Host|Error|Warning).*(?:bridgeToken|privateKey|CommandLine)') {
    throw 'v2 runner cannot terminate other processes, mutate task/Funnel, or print secrets.'
}
$v2Fn = $v2Ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Invoke-TetherAuthChildSupervisor'
}, $true)
if ($null -eq $v2Fn) { throw 'v2 candidate has no isolated child supervisor.' }
Invoke-Expression $v2Fn.Extent.Text

function New-ChildSupervisorFixture([double[]]$Uptimes, [int[]]$ExitCodes, [string]$FailStep = '') {
    $state = @{
        Events = New-Object 'System.Collections.Generic.List[string]'
        Index = 0
        Uptimes = $Uptimes
        ExitCodes = $ExitCodes
        FailStep = $FailStep
    }
    $ops = @{
        AssertPortVacant = {
            $state.Events.Add('vacant')
            if ($state.FailStep -ceq 'AssertPortVacant') { throw 'simulated occupied port' }
        }.GetNewClosure()
        RunChild = {
            $state.Events.Add('run')
            if ($state.FailStep -ceq 'RunChild') { throw 'simulated launch failure' }
            $i = $state.Index
            $state.Index++
            [pscustomobject]@{ UptimeSeconds=$state.Uptimes[$i]; ExitCode=$state.ExitCodes[$i] }
        }.GetNewClosure()
        PauseBeforeRestart = {
            param([int]$Seconds)
            $state.Events.Add("wait:$Seconds")
            if ($state.FailStep -ceq 'PauseBeforeRestart') { throw 'simulated backoff failure' }
        }.GetNewClosure()
    }
    return @{ Ops=$ops; State=$state }
}
$short = New-ChildSupervisorFixture @(1,1,1,1) @(1,1,0,1)
$shortResult = Invoke-TetherAuthChildSupervisor -Operations $short.Ops -MaxRunsForTest 4
if ($shortResult -cne 'test_limit' -or
    ($short.State.Events -join ',') -cne 'vacant,run,wait:1,vacant,run,wait:2,vacant,run,wait:4,vacant,run') {
    throw 'Unexpected exits, including exit=0, must retry with bounded backoff and a port check.'
}
$longRun = New-ChildSupervisorFixture @(1,1,400,1) @(1,1,1,1)
Invoke-TetherAuthChildSupervisor -Operations $longRun.Ops -MaxRunsForTest 4 | Out-Null
if (($longRun.State.Events -join ',') -cne 'vacant,run,wait:1,vacant,run,wait:2,vacant,run,wait:1,vacant,run') {
    throw 'Backoff must reset after an established long-running child exits.'
}
$cap = New-ChildSupervisorFixture @(1,1,1,1,1,1,1,1) @(1,1,1,1,1,1,1,1)
Invoke-TetherAuthChildSupervisor -Operations $cap.Ops -MaxRunsForTest 8 | Out-Null
if (($cap.State.Events -join ',') -notlike '*wait:60,vacant,run') {
    throw 'Restart delays must cap at 60 seconds while leaving the task runner alive.'
}
foreach ($step in @('AssertPortVacant','RunChild','PauseBeforeRestart')) {
    $fault = New-ChildSupervisorFixture @(1,1) @(1,1) $step
    try {
        Invoke-TetherAuthChildSupervisor -Operations $fault.Ops -MaxRunsForTest 2 | Out-Null
        throw 'Unexpected supervisor success after fault.'
    } catch {
        if ($_.Exception.Message -eq 'Unexpected supervisor success after fault.') { throw }
    }
    if ($step -ceq 'AssertPortVacant' -and $fault.State.Index -ne 0) {
        throw 'An occupied auth port must block child launch rather than terminate another process.'
    }
}
$invalid = New-ChildSupervisorFixture @(-1) @(1)
try {
    Invoke-TetherAuthChildSupervisor -Operations $invalid.Ops -MaxRunsForTest 1 | Out-Null
    throw 'Supervisor accepted an invalid process lifetime.'
} catch {
    if ($_.Exception.Message -eq 'Supervisor accepted an invalid process lifetime.') { throw }
}
Write-Output 'Isolated v2 supervised child-restart, backoff, and no-collision contracts passed.'

Write-Output 'Guarded S4U autostart contracts passed.'
