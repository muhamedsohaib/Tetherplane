<#
.SYNOPSIS
  Guarded and independently verifiable crash recovery rehearsal for Vaulter's
  currently registered, Interactive Tetherplane Relay Windows Scheduled Task.
.DESCRIPTION
  Default is READ-ONLY. -Exercise injects one failure into the exact task-owned
  Node relay child, observes Task Scheduler automatic recovery for 180 seconds,
  and if needed attempts a single bounded, ownership-checked manual task restart.
  This script never writes credentials, re-registers tasks, edits Funnel routes
  or touches an unrelated process. Run from the pinned, reviewed Git commit.
#>
[CmdletBinding()]
param([switch]$Exercise)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:TaskName='Tetherplane Relay'
$script:StateDir=Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:BackupDir=Join-Path $script:StateDir 'relay-pre-bridge-b8afcfe768964e8786a5c229b866ea8d'
$script:LauncherHash='5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8'
$script:Auth0Issuer='https://tetherplane-dev.eu.auth0.com/'
$script:PublicOrigin='https://vaulter.tailf65eba.ts.net'
$script:OriginalTaskXml=''
$script:OriginalAuthPid=0
$script:OriginalRelay=$null

function Assert-Relay([bool]$Condition,[string]$Reason){
  if(-not $Condition){throw $Reason}
}
function Test-RegisteredRelayRestartPolicy {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)]$Settings,[Parameter(Mandatory=$true)][string]$Xml)
  try {
    [xml]$doc=$Xml
    $c=$doc.SelectSingleNode("//*[local-name()='RestartOnFailure']/*[local-name()='Count']")
    $i=$doc.SelectSingleNode("//*[local-name()='RestartOnFailure']/*[local-name()='Interval']")
    if($null -eq $c -or $null -eq $i){return $false}
    return ([int]$c.InnerText -eq 10 -and [int]$Settings.RestartCount -eq 10 -and
      [string]$i.InnerText -ceq 'PT1M' -and [string]$Settings.RestartInterval -ceq 'PT1M')
  } catch{return $false}
}
function Get-Task {
  Get-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
}
function Get-TaskXml {
  [string](Export-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop)
}
function Get-RelayOwned {
  $task=Get-Task
  Assert-Relay ($task.State -eq 'Running' -and [bool]$task.Settings.Enabled -and
    [string]$task.Principal.LogonType -ceq 'Interactive' -and
    @($task.Actions).Count -eq 1) 'Original running Interactive relay task unavailable.'
  $action=$task.Actions[0]
  Assert-Relay ([IO.Path]::GetFileName([string]$action.Execute) -ieq 'powershell.exe') 'Relay task executable changed.'
  $m=[regex]::Match([string]$action.Arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Relay ($m.Success) 'Task-owned relay launcher path could not be determined.'
  $runner=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value) |
    Where-Object { -not [string]::IsNullOrEmpty($_) } | Select-Object -First 1
  $runner=[Environment]::ExpandEnvironmentVariables([string]$runner)
  Assert-Relay (Test-Path -LiteralPath $runner -PathType Leaf) 'Registered relay launcher file missing.'
  Assert-Relay ((Get-FileHash -LiteralPath $runner -Algorithm SHA256 -ErrorAction Stop).Hash -ceq $script:LauncherHash) 'Original relay launcher hash mismatch.'
  $listen=@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
  Assert-Relay ($listen.Count -eq 1 -and [string]$listen[0].LocalAddress -ceq '127.0.0.1') 'Port 8788 must have exactly one loopback listener.'
  $nodePid=[int]$listen[0].OwningProcess
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+$nodePid) -ErrorAction Stop
  Assert-Relay ($null -ne $node -and [string]$node.Name -ieq 'node.exe') 'Relay listener owner is not Node.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Relay ($null -ne $parent -and [string]$parent.Name -ieq 'powershell.exe') 'Relay Node parent is not PowerShell.'
  Assert-Relay ([string]$parent.CommandLine -like ('*'+$runner+'*')) 'Relay Node parent does not match the registered launcher.'
  Assert-Relay ([string]$node.CommandLine -match '(?i)(?:^|\s)(?:"[^"]*[/\\]dist[/\\]cli\.js"|\S+[/\\]dist[/\\]cli\.js)(?:\s|$)') 'Relay Node CLI entrypoint could not be identified.'
  return [pscustomobject]@{
    NodePid=$nodePid
    NodeCreated=[string]$node.CreationDate
    ParentPid=[int]$node.ParentProcessId
    ParentCreated=[string]$parent.CreationDate
  }
}
function Get-AuthPid {
  $listen=@(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
  Assert-Relay ($listen.Count -eq 1 -and [string]$listen[0].LocalAddress -ceq '127.0.0.1') 'Self-hosted auth loopback listener unavailable.'
  return [int]$listen[0].OwningProcess
}
function Test-Health {
  try {
    $rh=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 7 -ErrorAction Stop
    $ah=Invoke-RestMethod -Uri 'http://127.0.0.1:8790/healthz' -TimeoutSec 7 -ErrorAction Stop
    $local=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/.well-known/oauth-protected-resource/mcp' -TimeoutSec 7 -ErrorAction Stop
    $public=Invoke-RestMethod -Uri ($script:PublicOrigin+'/.well-known/oauth-protected-resource/mcp') -TimeoutSec 10 -ErrorAction Stop
    $publicHealth=Invoke-RestMethod -Uri ($script:PublicOrigin+'/healthz') -TimeoutSec 10 -ErrorAction Stop
    if([string]$rh.status -cne 'ok' -or [string]$ah.status -cne 'ok' -or
      [string]$publicHealth.status -cne 'ok' -or
      @($local.authorization_servers).Count -ne 1 -or
      @($public.authorization_servers).Count -ne 1 -or
      @($local.authorization_servers)[0] -cne $script:Auth0Issuer -or
      @($public.authorization_servers)[0] -cne $script:Auth0Issuer){
      return $false
    }
    return $true
  }catch{return $false}
}
function Assert-BackupReady {
  foreach($dir in @($script:StateDir,$script:BackupDir)){
    Assert-Relay (Test-Path -LiteralPath $dir -PathType Container) 'Private rollback checkpoint missing.'
    Assert-Relay ((Get-Acl -LiteralPath $dir -ErrorAction Stop).AreAccessRulesProtected) 'Private rollback checkpoint ACL not protected.'
  }
  $backupLauncher=Join-Path $script:BackupDir 'launcher.ps1'
  Assert-Relay (Test-Path -LiteralPath $backupLauncher -PathType Leaf) 'Original rollback launcher missing.'
  Assert-Relay ((Get-FileHash -LiteralPath $backupLauncher -Algorithm SHA256 -ErrorAction Stop).Hash -ceq $script:LauncherHash) 'Private rollback launcher differs from the trusted original.'
  foreach($leaf in @('launcher.ps1','auth-config.json','device-state.json','relay-task.xml')){
    Assert-Relay (Test-Path -LiteralPath (Join-Path $script:BackupDir $leaf) -PathType Leaf) 'Protected rollback checkpoint incomplete.'
  }
}
function Assert-RegistrationUnchanged {
  Assert-Relay ((Get-TaskXml) -ceq $script:OriginalTaskXml) 'Registered relay task definition changed during rehearsal.'
  $task=Get-Task
  Assert-Relay (Test-RegisteredRelayRestartPolicy -Settings $task.Settings -Xml $script:OriginalTaskXml) 'Registered retry policy changed during rehearsal.'
}
function Assert-Baseline {
  Assert-Relay ($env:COMPUTERNAME -ieq 'vaulter' -and $env:OS -eq 'Windows_NT') 'Vaulter-only operation.'
  Assert-BackupReady
  $t=Get-Task
  Assert-Relay (Test-RegisteredRelayRestartPolicy -Settings $t.Settings -Xml (Get-TaskXml)) 'Task retry count 10/interval PT1M not registered.'
  Assert-Relay ([string]$t.Settings.MultipleInstances -ceq 'IgnoreNew') 'Unexpected multiple-instance policy.'
  $script:OriginalTaskXml=Get-TaskXml
  $script:OriginalRelay=Get-RelayOwned
  $script:OriginalAuthPid=Get-AuthPid
  Assert-Relay (Test-Health) 'Relay/Auth0/self-hosted-auth health baseline is not green.'
  Assert-RegistrationUnchanged
}
function Assert-CrashTarget {
  Assert-RegistrationUnchanged
  $latest=Get-RelayOwned
  Assert-Relay ($latest.NodePid -eq $script:OriginalRelay.NodePid -and
    $latest.NodeCreated -ceq $script:OriginalRelay.NodeCreated -and
    $latest.ParentPid -eq $script:OriginalRelay.ParentPid -and
    $latest.ParentCreated -ceq $script:OriginalRelay.ParentCreated) 'Original task-owned relay process changed; fault injection refused.'
  Assert-Relay ((Get-AuthPid) -eq $script:OriginalAuthPid -and (Test-Health)) 'Auth0 baseline changed; fault injection refused.'
}
function Test-ReplacementHealthy {
  try {
    Assert-RegistrationUnchanged
    $task=Get-Task
    if($task.State -ne 'Running'){return $false}
    $live=Get-RelayOwned
    if($live.NodePid -eq $script:OriginalRelay.NodePid -or
      $live.ParentPid -eq $script:OriginalRelay.ParentPid -or
      $live.NodeCreated -ceq $script:OriginalRelay.NodeCreated -or
      $live.ParentCreated -ceq $script:OriginalRelay.ParentCreated){
      return $false
    }
    if((Get-AuthPid) -ne $script:OriginalAuthPid){return $false}
    return [bool](Test-Health)
  }catch{return $false}
}
function Wait-Replacement {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][int]$Seconds)
  $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
  while([DateTime]::UtcNow -lt $deadline){
    if(Test-ReplacementHealthy){return}
    Start-Sleep -Seconds 3
  }
  throw 'Task-owned relay replacement was not healthy within the bounded observation window.'
}
function Restore-TaskManually {
  Assert-RegistrationUnchanged
  Assert-Relay ((Get-AuthPid) -eq $script:OriginalAuthPid) 'Auth server identity changed; recovery cannot proceed.'
  if(Test-ReplacementHealthy){throw 'Automatic recovery appeared during manual fallback; no intervention is permitted.'}
  $occupied=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
  Assert-Relay ($occupied.Count -eq 0) 'Relay port occupied by an ambiguous process; manual fallback refused.'
  $task=Get-Task
  Assert-Relay ([bool]$task.Settings.Enabled -and $task.State -in @('Running','Ready')) 'Task cannot be safely restarted.'
  if($task.State -eq 'Running'){
    Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
      $task=Get-Task
      if($task.State -eq 'Ready'){break}
      Start-Sleep -Milliseconds 500
    }while([DateTime]::UtcNow -lt $deadline)
    Assert-Relay ($task.State -eq 'Ready') 'Task did not stop cleanly; manual recovery refused.'
  }
  Assert-Relay (@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'A listener appeared during recovery; task start refused.'
  Assert-RegistrationUnchanged
  Start-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
}
function Invoke-GuardedRelayCrashRehearsal {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][hashtable]$Operations)
  foreach($name in @('VerifyBaseline','VerifyTarget','InjectCrash','WaitAutomatic','TryManualRecovery','WaitManual')){
    if(-not $Operations.ContainsKey($name) -or -not ($Operations[$name] -is [scriptblock])){
      throw 'Missing crash-recovery transaction operation.'
    }
  }
  & $Operations['VerifyBaseline']
  & $Operations['VerifyTarget']
  & $Operations['InjectCrash']
  try{
    & $Operations['WaitAutomatic']
    return 'automatic'
  }catch{
    # Do not claim automatic restart after a manual recovery.
  }
  try{
    & $Operations['TryManualRecovery']
    & $Operations['WaitManual']
    return 'manual_only'
  }catch{
    throw 'RECOVERY UNVERIFIED. Inspect the original Tetherplane Relay scheduled task, health and private rollback checkpoint. Do not repeat fault injection or reboot.'
  }
}

if($env:COMPUTERNAME -ine 'vaulter'){throw 'Vaulter only.'}
if($env:OS -ne 'Windows_NT'){throw 'Windows only.'}
Assert-Baseline
if (-not $Exercise) {
  Write-Output 'RELAY CRASH REHEARSAL PREFLIGHT PASS: task-owned Node, original launcher, corrected retry policy, Auth0, protected backup and both services verified.'
  Write-Output 'No changes made. NO CHANGES MADE.'
  return
}
$operations=@{
  VerifyBaseline={ Assert-RegistrationUnchanged; Assert-CrashTarget }
  VerifyTarget={ Assert-CrashTarget }
  InjectCrash={
    # No process-name kill: the exact PID is checked against its parent,
    # creation time, listener and original registered launcher immediately
    # before injection.
    Assert-CrashTarget
    Stop-Process -Id $script:OriginalRelay.NodePid -Force -ErrorAction Stop
  }
  WaitAutomatic={ Wait-Replacement -Seconds 180 }
  TryManualRecovery={ Restore-TaskManually }
  WaitManual={ Wait-Replacement -Seconds 75 }
}
$result=Invoke-GuardedRelayCrashRehearsal -Operations $operations
Assert-RegistrationUnchanged
Assert-Relay (Test-ReplacementHealthy) 'Posttransaction relay replacement not independently verified.'
if($result -ceq 'automatic'){
  Write-Output 'RELAY RESTART AUTOMATICALLY VERIFIED: new task-owned relay, unchanged Auth0 and self-hosted auth. NO CONFIGURATION CHANGES.'
}elseif($result -ceq 'manual_only'){
  Write-Output 'RELAY MANUAL TASK RESTART VERIFIED. Automatic recovery FAILED; the automatic restart gate remains blocked.'
}else{
  throw 'RECOVERY UNVERIFIED.'
}
