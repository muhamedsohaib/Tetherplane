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

Write-Output 'Guarded S4U autostart contracts passed.'
