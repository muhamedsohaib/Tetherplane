# Read-only Vaulter relay Task Scheduler event forensics, entirely synthetic.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-restart-forensics.ps1'
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){
  throw 'RED: relay restart diagnostic missing.'
}
$tokens=$null;$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -gt 0){throw 'Diagnostic does not parse.'}
$src=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($needed in @(
    'COMPUTERNAME','vaulter','Tetherplane Relay',
    'vaulter-tether-auth-supervised-postcheck.ps1',
    'Get-ScheduledTask','Get-ScheduledTaskInfo','Interactive',
    'RestartCount','RestartInterval','LastTaskResult','LastRunTime',
    'Microsoft-Windows-TaskScheduler/Operational','Get-WinEvent',
    'Format-SchedulerResult','Convert-RelayTaskEvent',
    'TaskName','ResultCode','ErrorCode','EventData',
    'TaskInstanceId','InstanceId','Record','MaxEvents',
    'No changes made','RELAY RESTART FORENSICS','history unavailable'
)){
  if(-not $src.Contains($needed)){throw "Diagnostic missing requirement: $needed"}
}
$commands=@($ast.FindAll({
  param($node) $node -is [System.Management.Automation.Language.CommandAst]
},$true) | ForEach-Object{$_.GetCommandName()})
foreach($bad in @(
    'Start-Process','Stop-Process','Start-ScheduledTask','Stop-ScheduledTask',
    'Enable-ScheduledTask','Disable-ScheduledTask','Register-ScheduledTask',
    'Unregister-ScheduledTask','Set-ScheduledTask','New-ScheduledTask',
    'Restart-Service','Stop-Service','Start-Service','Set-Acl','Set-Content',
    'Out-File','Remove-Item','New-Item','Invoke-Expression','Export-Clixml',
    'Set-Clipboard'
)){
  if($commands -contains $bad){throw "Read-only diagnostic includes unsafe command $bad"}
}
if($src -match '(?i)(?:\.Message\b|\.FormatDescription\s*\(|gh auth token|tailscale\s+(?:serve|funnel)\s+(?:--set-path|reset|off))'){
  throw 'Private task event descriptions, credentials or Funnel mutations forbidden.'
}
foreach($functionName in @('Format-SchedulerResult','Convert-RelayTaskEvent')){
  $node=$ast.Find({
    param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $n.Name -ceq $functionName
  }.GetNewClosure(),$true)
  if($null -eq $node){throw "Missing testable helper $functionName"}
  Invoke-Expression $node.Extent.Text
}
if((Format-SchedulerResult -Code 0) -cne '0x00000000' -or
   (Format-SchedulerResult -Code 267009) -cne '0x00041301' -or
   (Format-SchedulerResult -Code -1073741510) -cne '0xC000013A'){
  throw 'Scheduler exit-code interpretation incorrect.'
}
$xml=@'
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
 <System><EventID>201</EventID></System>
 <EventData>
  <Data Name="TaskName">\Tetherplane Relay</Data>
  <Data Name="ResultCode">3221225786</Data>
  <Data Name="TaskInstanceId">{12345678-1111-2222-3333-444444444444}</Data>
  <Data Name="ActionName">C:\private\bridge-token.secret</Data>
  <Data Name="UserName">SECRET_IDENTITY</Data>
 </EventData>
</Event>
'@
$evt=[pscustomobject]@{Id=201;TimeCreated=[datetime]'2026-10-10T12:47:00';XmlText=$xml}
$evt|Add-Member -MemberType ScriptMethod -Name ToXml -Value{return $this.XmlText}
$event=Convert-RelayTaskEvent -Record $evt -ExactTaskName '\Tetherplane Relay'
if($null -eq $event -or $event.EventId -ne 201 -or
  $event.ResultCode -cne '0xC000013A' -or
  $event.InstanceTag -cne '12345678'){
  throw 'Matching event must yield a safe timestamp, event ID, result and instance tag.'
}
$dump=$event|Out-String
foreach($s in @('bridge-token.secret','SECRET_IDENTITY','ActionName','UserName','TaskName')){
  if($dump.Contains($s)){throw "Redacted event leaked $s"}
}
$evt.XmlText=$evt.XmlText.Replace('\Tetherplane Relay','\Other Human Task')
if($null -ne (Convert-RelayTaskEvent -Record $evt -ExactTaskName '\Tetherplane Relay')){
  throw 'Events belonging to human tasks must be excluded.'
}
$evt.XmlText=$evt.XmlText.Replace('\Other Human Task','\Tetherplane Relay')
$evt.XmlText=$evt.XmlText.Replace('3221225786','unexpected sensitive payload')
$event=Convert-RelayTaskEvent -Record $evt -ExactTaskName '\Tetherplane Relay'
if($event.ResultCode -cne 'not-present'){
  throw 'Arbitrary event result data cannot reach diagnostic output.'
}
$evt.XmlText='<Event><EventData><Data Name="ActionName">private</Data></EventData></Event>'
if($null -ne (Convert-RelayTaskEvent -Record $evt -ExactTaskName '\Tetherplane Relay')){
  throw 'Event without exact named task must be dropped.'
}
Write-Output 'VAULTER RELAY RESTART FORENSICS CONTRACT PASS'
