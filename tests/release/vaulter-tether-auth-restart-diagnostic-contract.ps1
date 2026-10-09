# Windows Task Scheduler auth recovery diagnostic: safety and parsing contracts.
# Exercises safe event parsing on PowerShell 5.1/7 without touching Vaulter.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourcePath = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-restart-diagnostic.ps1'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw 'Missing independent read-only scheduled-task restart diagnostic.'
}
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $sourcePath).Path,
    [ref]$tokens, [ref]$errors
)
if (@($errors).Count -ne 0) { throw 'Restart diagnostic has PowerShell syntax errors.' }
$src = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $sourcePath).Path)
foreach ($expected in @(
    'COMPUTERNAME','vaulter',
    'Tetherplane-TetherAuth-Startup',
    'vaulter-tether-auth-supervised-postcheck.ps1',
    'Get-ScheduledTask', 'Get-ScheduledTaskInfo',
    'RestartCount', 'RestartInterval',
    'LastTaskResult', 'Get-WinEvent',
    'Microsoft-Windows-TaskScheduler/Operational',
    'Convert-TaskSchedulerEvent','Format-SchedulerResult',
    'EventData','TaskName','ResultCode',
    'No changes made','AUTH RESTART DIAGNOSTIC',
    'out-of-schema-range','history unavailable',
    'EventXml','TaskUserId'
)) {
    if (-not $src.Contains($expected)) {
        throw "Restart diagnostic missing safeguard: $expected"
    }
}
$commands = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($forbidden in @(
    'Start-Process','Stop-Process','Start-ScheduledTask','Stop-ScheduledTask',
    'Enable-ScheduledTask','Disable-ScheduledTask',
    'New-ScheduledTask','Set-ScheduledTask',
    'Register-ScheduledTask','Unregister-ScheduledTask',
    'Restart-Service','Start-Service','Stop-Service',
    'Set-Acl','Set-Content','Out-File','Remove-Item',
    'New-Item','Invoke-Expression','Export-Clixml'
)) {
    if ($commands -contains $forbidden) {
        throw "Restart diagnostic must never mutate the system: $forbidden"
    }
}
if ($src -match '(?i)\bgh auth token\b' -or
    $src -match '(?i)\btailscale\s+(?:funnel|serve)\b') {
    throw 'Restart diagnostic cannot read credentials or alter Funnel.'
}
if ($src -match '(?i)EventRecord\.Message|\.FormatDescription\(|Write-(?:Host|Output).*CommandLine') {
    throw 'Task event messages and executable arguments may contain secrets.'
}
foreach ($helper in @('Convert-TaskSchedulerEvent','Format-SchedulerResult')) {
    $func = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $helper
    }.GetNewClosure(), $true)
    if ($null -eq $func) { throw "Missing event redaction function $helper" }
    Invoke-Expression $func.Extent.Text
}
if ((Format-SchedulerResult -Code 0) -cne '0x00000000' -or
    (Format-SchedulerResult -Code 267009) -cne '0x00041301' -or
    (Format-SchedulerResult -Code -1073741510) -cne '0xC000013A') {
    throw 'Task Scheduler numeric result formatting is incorrect.'
}

$xmlText = @'
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
 <System><EventID>201</EventID></System>
 <EventData>
  <Data Name="TaskName">\Tetherplane-TetherAuth-Startup</Data>
  <Data Name="ResultCode">1</Data>
  <Data Name="ActionName">C:\private\bridge-token.secret</Data>
  <Data Name="UserName">SECRET_IDENTITY</Data>
 </EventData>
</Event>
'@
$evt = [pscustomobject]@{
    Id=201;TimeCreated=[datetime]'2026-10-09T21:13:00';EventXml=$xmlText
}
$evt | Add-Member -MemberType ScriptMethod -Name ToXml -Value { return $this.EventXml }
$parsed = Convert-TaskSchedulerEvent -Record $evt -ExactTaskName '\Tetherplane-TetherAuth-Startup'
if ($null -eq $parsed -or
    $parsed.EventId -ne 201 -or
    $parsed.ResultCode -cne '0x00000001') {
    throw 'Task event must be filtered and rendered as timestamp, ID and numeric status only.'
}
$safeString = ($parsed | Out-String)
if ($safeString.Contains('bridge-token.secret') -or
    $safeString.Contains('SECRET_IDENTITY') -or
    $safeString.Contains('ActionName') -or
    $safeString.Contains('TaskName')) {
    throw 'Private event fields must never be emitted.'
}
$evt.EventXml = $evt.EventXml.Replace('\Tetherplane-TetherAuth-Startup','\Other-Human-Task')
if ($null -ne (Convert-TaskSchedulerEvent -Record $evt -ExactTaskName '\Tetherplane-TetherAuth-Startup')) {
    throw 'Events belonging to a different scheduled task must never be exposed.'
}
$evt.EventXml = '<Event><System><EventID>102</EventID></System><EventData><Data Name="ActionName">private</Data></EventData></Event>'
if ($null -ne (Convert-TaskSchedulerEvent -Record $evt -ExactTaskName '\Tetherplane-TetherAuth-Startup')) {
    throw 'Events without a verifiable TaskName must be ignored.'
}
Write-Output 'Redacted scheduled-task event and restart diagnostics contract passed.'
