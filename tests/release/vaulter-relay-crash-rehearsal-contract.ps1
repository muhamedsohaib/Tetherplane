# Offline Vaulter relay crash/restart rehearsal contract.
# ALL side effects are mock scriptblocks; this file never accesses a real task.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-crash-rehearsal.ps1'
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){
  throw 'RED: guarded relay crash rehearsal source absent.'
}
$tokens=$null;$errorsFound=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$errorsFound)
if(@($errorsFound).Count -ne 0){throw 'Relay rehearsal PowerShell syntax invalid.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($required in @('[switch]$Exercise','if (-not $Exercise)',
  'vaulter','COMPUTERNAME','Tetherplane Relay','Interactive',
  'RestartCount','RestartInterval','PT1M','Get-ScheduledTask',
  'Export-ScheduledTask','Get-FileHash','Get-NetTCPConnection',
  'Get-CimInstance','CreationDate','ParentProcessId','node.exe',
  'Stop-Process','Start-ScheduledTask','Stop-ScheduledTask',
  'AreAccessRulesProtected','VerifyTarget','InjectCrash',
  'WaitAutomatic','TryManualRecovery','WaitManual',
  'Invoke-GuardedRelayCrashRehearsal','Test-RegisteredRelayRestartPolicy',
  'AUTH0','automatic','manual_only','RECOVERY UNVERIFIED',
  'NO CHANGES MADE','No changes made')){
  if($source.IndexOf($required,[StringComparison]::OrdinalIgnoreCase) -lt 0){
    throw "Missing guarded crash-rehearsal requirement: $required"
  }
}
if($source -match '(?i)\b(?:Register|Unregister|Set)-ScheduledTask\b|Stop-Process\s+-Name|gh auth token|tailscale\s+(?:funnel|serve)\s+(?:reset|off|--set-path)|Set-Clipboard'){
  throw 'Rehearsal may not mutate task registrations, routes, secrets, or arbitrary processes.'
}
$functions=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true))
foreach($name in @('Test-RegisteredRelayRestartPolicy','Invoke-GuardedRelayCrashRehearsal')){
  $found=$functions|Where-Object{$_.Name -ceq $name}|Select-Object -First 1
  if($null -eq $found){throw "Missing testable operation: $name"}
  Invoke-Expression $found.Extent.Text
}
$xml='<Task><Settings><RestartOnFailure><Count>10</Count><Interval>PT1M</Interval></RestartOnFailure></Settings></Task>'
$settings=[pscustomobject]@{RestartCount=10;RestartInterval='PT1M'}
if(-not(Test-RegisteredRelayRestartPolicy -Settings $settings -Xml $xml)){throw 'Valid policy rejected.'}
foreach($case in @(
  @{s=$settings;x=$xml.Replace('<Count>10</Count>','<Count>999</Count>')},
  @{s=([pscustomobject]@{RestartCount=999;RestartInterval='PT1M'});x=$xml},
  @{s=$settings;x=$xml.Replace('PT1M','PT2M')},
  @{s=([pscustomobject]@{RestartCount=10;RestartInterval='PT2M'});x=$xml},
  @{s=$settings;x='<Task><Settings/></Task>'}
)){
  if(Test-RegisteredRelayRestartPolicy -Settings $case.s -Xml $case.x){
    throw 'Unsafe restart policy was accepted.'
  }
}
function New-Fixture([string[]]$Fail) {
  $steps=New-Object 'System.Collections.Generic.List[string]'
  $ops=@{}
  foreach($step in @('VerifyBaseline','VerifyTarget','InjectCrash','WaitAutomatic','TryManualRecovery','WaitManual')){
    $name=$step
    $ops[$step]={
      $steps.Add($name)
      if($Fail -ccontains $name){throw 'synthetic action failure'}
    }.GetNewClosure()
  }
  return @{Steps=$steps;Operations=$ops}
}
$a=New-Fixture @()
$result=Invoke-GuardedRelayCrashRehearsal -Operations $a.Operations
if($result -cne 'automatic' -or ($a.Steps -join ',') -cne 'VerifyBaseline,VerifyTarget,InjectCrash,WaitAutomatic'){
  throw 'Automatic recovery must finish without manual task restart.'
}
$m=New-Fixture @('WaitAutomatic')
$result=Invoke-GuardedRelayCrashRehearsal -Operations $m.Operations
if($result -cne 'manual_only' -or ($m.Steps -join ',') -cne 'VerifyBaseline,VerifyTarget,InjectCrash,WaitAutomatic,TryManualRecovery,WaitManual'){
  throw 'Manual recovery must not be reported as automatic.'
}
foreach($step in @('VerifyBaseline','VerifyTarget')){
  $f=New-Fixture @($step);$failed=$false
  try{Invoke-GuardedRelayCrashRehearsal -Operations $f.Operations|Out-Null}catch{$failed=$true}
  if(-not $failed -or $f.Steps.Contains('InjectCrash')){throw 'Failed precondition injected a crash.'}
}
$f=New-Fixture @('WaitAutomatic','TryManualRecovery');$message=''
try{Invoke-GuardedRelayCrashRehearsal -Operations $f.Operations|Out-Null}catch{$message=$_.Exception.Message}
if($message -notmatch 'RECOVERY UNVERIFIED'){throw 'Failed manual attempt reported success.'}
$f=New-Fixture @('WaitAutomatic','WaitManual');$message=''
try{Invoke-GuardedRelayCrashRehearsal -Operations $f.Operations|Out-Null}catch{$message=$_.Exception.Message}
if($message -notmatch 'RECOVERY UNVERIFIED'){throw 'Unhealthy manual recovery reported success.'}
# Verify the first preflight snapshot remains authoritative until injection.
if($source -notmatch 'VerifyBaseline\s*=\s*\{\s*Assert-RegistrationUnchanged'){
  throw 'RED: live transaction must not silently rebaseline an altered task.'
}
if(-not $source.Contains('Get-FileHash -LiteralPath $backupLauncher')){
  throw 'RED: private rollback launcher copy must match pinned original hash.'
}
Write-Output 'VAULTER RELAY CRASH REHEARSAL CONTRACT PASS'
