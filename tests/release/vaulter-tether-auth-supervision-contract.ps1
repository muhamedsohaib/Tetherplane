# Regression and safety checks for Windows 5.1-compatible, read-only task inspection.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourcePath = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-supervision-preflight.ps1'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw 'Missing read-only Vaulter scheduled-task supervision diagnostic.'
}
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $sourcePath).Path,
    [ref]$tokens, [ref]$errors
)
if (@($errors).Count -ne 0) { throw "Supervision diagnostic has PowerShell syntax errors." }
$source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $sourcePath).Path)

foreach ($required in @(
    'COMPUTERNAME', 'vaulter', 'Get-ScheduledTask',
    'Get-ScheduledTaskInfo', 'Win32_Process', 'Get-NetTCPConnection',
    '8788', '8790', 'Get-TaskRole', 'Get-TaskTriggerSummary',
    'Get-TaskLogonSummary', 'RestartCount', 'StartWhenAvailable',
    'No changes made', 'not proof'
)) {
    if (-not $source.Contains($required)) {
        throw "Supervision diagnostic missing mandatory guard: $required"
    }
}
$commands = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($bad in @(
    'Start-Process', 'Stop-Process', 'Register-ScheduledTask',
    'Unregister-ScheduledTask', 'Disable-ScheduledTask', 'Enable-ScheduledTask',
    'Set-ScheduledTask', 'New-ScheduledTaskAction', 'Start-ScheduledTask',
    'Stop-ScheduledTask', 'Set-Content', 'Set-Acl', 'Set-ExecutionPolicy',
    'Start-Service', 'Stop-Service', 'Restart-Service', 'Invoke-Expression'
)) {
    if ($commands -contains $bad) {
        throw "Supervision inspection must remain read-only, found $bad"
    }
}
if ($source -match '(?i)\btailscale\s+(serve|funnel)\s+(--set-path|reset|--bg)') {
    throw 'Supervision inspection must not alter network routing.'
}
if ($source -match '(?im)^\s*\$pid\s*=') {
    throw 'Script must not assign the reserved $PID automatic variable.'
}

# Extract helpers into this test scope to exercise Windows PowerShell 5.1 behavior.
foreach ($helper in @('Get-TaskRole', 'Get-TaskTriggerSummary', 'Get-TaskLogonSummary')) {
    $func = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $helper
    }.GetNewClosure(), $true)
    if ($null -eq $func) { throw "Missing helper $helper" }
    Invoke-Expression $func.Extent.Text
}

$authTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{
        Execute = 'C:\Program Files\nodejs\node.exe'
        Arguments = 'C:\repo\auth\dist\cli.js --config "C:\private\sensitive.json"'
    })
}
$relayTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{
        Execute = 'C:\Program Files\nodejs\node.exe'
        Arguments = 'C:\repo\relay\dist\cli.js --auth-config "C:\private\relay-auth.json"'
    })
}
$unknownTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = '-NoProfile' })
}
if ((Get-TaskRole $authTask) -ne 'auth' -or (Get-TaskRole $relayTask) -ne 'relay' -or
    (Get-TaskRole $unknownTask) -ne 'unclassified') {
    throw 'Task role recognition must be based on private action metadata, without printing it.'
}
$boot = [pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskBootTrigger' }; Enabled = $true }
$logon = [pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }; Enabled = $false }
$triggerTask = [pscustomobject]@{ Triggers = @($boot, $logon) }
if ((Get-TaskTriggerSummary $triggerTask) -ne 'startup') {
    throw 'Only enabled startup triggers may count as a startup task.'
}
$interactiveTask = [pscustomobject]@{ Principal = [pscustomobject]@{ LogonType = 'InteractiveToken' } }
$systemTask = [pscustomobject]@{ Principal = [pscustomobject]@{ LogonType = 'ServiceAccount' } }
if ((Get-TaskLogonSummary $interactiveTask) -ne 'requires-user-session' -or
    (Get-TaskLogonSummary $systemTask) -ne 'service-logon') {
    throw 'Scheduled task login requirements must be disclosed without usernames.'
}
Write-Output 'Read-only supervised-task classification tests passed.'
