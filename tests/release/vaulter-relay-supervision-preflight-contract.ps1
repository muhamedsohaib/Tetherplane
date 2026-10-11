# Synthetic read-only Vaulter relay ownership inventory.
# No scheduled tasks, services, authentication state or processes are modified.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourcePath=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervision-preflight.ps1'
if(-not(Test-Path -LiteralPath $sourcePath -PathType Leaf)){
  throw 'RED: read-only Vaulter supervision preflight is missing.'
}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $sourcePath).Path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -gt 0){throw 'Vaulter preflight has PowerShell syntax errors.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $sourcePath).Path)
foreach($forbidden in @(
  'Stop-ScheduledTask','Start-ScheduledTask','Set-ScheduledTask','Register-ScheduledTask',
  'Unregister-ScheduledTask','Stop-Process','Start-Process','Remove-Item',
  'New-Item','Set-Content','Set-Acl','Set-MpPreference'
)){
  if($source.Contains($forbidden)){
    throw ('A read-only supervisor inventory may not mutate a system: '+$forbidden)
  }
}
# The legacy task's exact, previously approved argument string includes
# an execution-policy flag. It may be compared as data, but never executed.
if($source -match '(?im)^\s*(?:&\s*\S*|Start-Process\s+\S*|powershell(?:\.exe)?\s+)[^\r\n]*-ExecutionPolicy\s+Bypass'){
  throw 'Read-only preflight may not invoke a policy-bypassing child process.'
}
foreach($expected in @('Get-ScheduledTask','Get-NetTCPConnection',
    'Get-CimInstance','Get-FileHash','Get-Acl','Invoke-RestMethod',
    'oauth-protected-resource/mcp','Get-SupervisionVerdict',
    'Test-RelayProcessAncestry','Get-ProcessFileArgument',
    'no_changes_made','task_owned_process_chain_verified')){
  if(-not $source.Contains($expected)){
    throw ('Missing read-only supervisory evidence: '+$expected)
  }
}
foreach($name in @('Get-ProcessFileArgument','Test-RelayProcessAncestry','Get-SupervisionVerdict')){
  $fn=$ast.Find({
    param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $n.Name -ceq $name
  }.GetNewClosure(),$true)
  if($null -eq $fn){throw "Missing testable preflight function: $name"}
  Invoke-Expression $fn.Extent.Text
}
$launcherPath='C:\trusted\original-relay.ps1'
$supervisorPath='C:\private\relay-supervisor\vaulter-relay-bounded-supervisor.ps1'
$launcher=[pscustomobject]@{
  Name='powershell.exe';ProcessId=101;ParentProcessId=100
  CreationDate=([datetime]'2026-10-11T08:02:00Z')
  CommandLine=('powershell.exe -NoProfile -File "'+$launcherPath+'"')
}
$supervisor=[pscustomobject]@{
  Name='powershell.exe';ProcessId=100;ParentProcessId=1
  CreationDate=([datetime]'2026-10-11T08:01:00Z')
  CommandLine=('powershell.exe -NoProfile -File "'+$supervisorPath+'" -Serve')
}
$node=[pscustomobject]@{
  Name='node.exe';ProcessId=102;ParentProcessId=101
  CreationDate=([datetime]'2026-10-11T08:03:00Z')
  CommandLine='node.exe relay.js'
}
$proof=@{Node=$node;Launcher=$launcher;Supervisor=$supervisor;
  ListenerOwnerPid=102;ExpectedLauncherPath=$launcherPath;
  ExpectedSupervisorPath=$supervisorPath}
if(-not(Test-RelayProcessAncestry @proof)){
  throw 'Valid bounded supervisor ownership chain rejected.'
}
function MustReject([string]$reason,[hashtable]$changes) {
  $args=@{};foreach($k in $proof.Keys){$args[$k]=$proof[$k]}
  foreach($k in $changes.Keys){$args[$k]=$changes[$k]}
  if(Test-RelayProcessAncestry @args){throw ('Unsafe relay ownership accepted: '+$reason)}
}
MustReject 'wrong listener PID' @{ListenerOwnerPid=999}
MustReject 'missing supervisor' @{Supervisor=$null}
MustReject 'wrong parent PID' @{Node=[pscustomobject]@{
  Name='node.exe';ProcessId=102;ParentProcessId=999
  CreationDate=$node.CreationDate;CommandLine=$node.CommandLine}}
MustReject 'spoofed path substring' @{Supervisor=[pscustomobject]@{
  Name='powershell.exe';ProcessId=100;ParentProcessId=1
  CreationDate=$supervisor.CreationDate
  CommandLine=('powershell.exe -NoProfile -File "C:\untrusted\loader.ps1" -Metadata "'+$supervisorPath+'" -Serve')}}
MustReject 'bridge instead of Auth0' @{Supervisor=[pscustomobject]@{
  Name='powershell.exe';ProcessId=100;ParentProcessId=1
  CreationDate=$supervisor.CreationDate
  CommandLine=('powershell.exe -NoProfile -File "'+$supervisorPath+'" -Serve -Bridge')}}
MustReject 'wrong launcher path' @{Launcher=[pscustomobject]@{
  Name='powershell.exe';ProcessId=101;ParentProcessId=100
  CreationDate=$launcher.CreationDate
  CommandLine='powershell.exe -NoProfile -File "C:\untrusted\original-relay.ps1"'}}
MustReject 'reused supervisor PID after child start' @{Supervisor=[pscustomobject]@{
  Name='powershell.exe';ProcessId=100;ParentProcessId=1
  CreationDate=([datetime]'2026-10-11T09:01:00Z')
  CommandLine=$supervisor.CommandLine}}
MustReject 'extra supervisor argument' @{Supervisor=[pscustomobject]@{
  Name='powershell.exe';ProcessId=100;ParentProcessId=1
  CreationDate=$supervisor.CreationDate
  CommandLine=($supervisor.CommandLine+' -EncodedCommand AAA')}}
$verified=@{TaskState='Running';ActionVerified=$true;StageVerified=$true;
  LoopbackVerified=$true;AncestryVerified=$true;RelayHealthy=$true;
  AuthHealthy=$true;IssuerVerified=$true}
if((Get-SupervisionVerdict @verified) -cne 'SUPERVISED_AUTH0_VERIFIED'){
  throw 'Fully verified running relay was not classified as task supervised.'
}
$variants=@(
  @{Case='Task Ready with listener';Changes=@{TaskState='Ready'};Expected='TASK_INACTIVE_LISTENER_PRESENT'},
  @{Case='Task Ready and vacant';Changes=@{TaskState='Ready';LoopbackVerified=$false};Expected='OWNERSHIP_UNVERIFIED'},
  @{Case='Missing ancestor';Changes=@{AncestryVerified=$false};Expected='OWNERSHIP_UNVERIFIED'},
  @{Case='Unknown action';Changes=@{ActionVerified=$false};Expected='OWNERSHIP_UNVERIFIED'},
  @{Case='Untrusted stage';Changes=@{StageVerified=$false};Expected='OWNERSHIP_UNVERIFIED'},
  @{Case='Unhealthy relay';Changes=@{RelayHealthy=$false};Expected='HEALTH_NOT_VERIFIED'},
  @{Case='Unhealthy auth';Changes=@{AuthHealthy=$false};Expected='HEALTH_NOT_VERIFIED'},
  @{Case='Issuer drift';Changes=@{IssuerVerified=$false};Expected='HEALTH_NOT_VERIFIED'}
)
foreach($case in $variants){
  $args=@{};foreach($k in $verified.Keys){$args[$k]=$verified[$k]}
  foreach($k in $case.Changes.Keys){$args[$k]=$case.Changes[$k]}
  $actual=Get-SupervisionVerdict @args
  if($actual -cne $case.Expected){
    throw ('Wrong supervisor verdict for '+$case.Case+': '+$actual)
  }
}
Write-Output 'VAULTER RELAY SUPERVISION READ-ONLY PREFLIGHT CONTRACT PASS'
