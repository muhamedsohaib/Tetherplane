# Synthetic protected supervised bridge handover contract; no live task changes.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervised-bridge-handover.ps1'
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'RED: protected supervised bridge handover source absent.'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'Bridge handover PowerShell parse failed.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($text in @('[switch]$Stage','[switch]$Apply','[switch]$Rollback',
  'relay-supervisor-bridge','relay-supervisor','pre-supervisor-task.xml',
  'BridgeHelperSha256','BridgeLauncherSha256','SupervisorSha256','TaskSha256',
  'BridgeConfigSha256','ExpectedSupervisorSha256','ExpectedBridgeLauncherSha256',
  'ExpectedBridgeHelperSha256','Set-ScheduledTask','Stop-ScheduledTask','Start-ScheduledTask',
  'Copy-Item','New-Item','Get-FileHash','AreAccessRulesProtected','Export-ScheduledTask',
  'Test-BridgeActionOnlyChanged','Invoke-GuardedBridgeHandover',
  'VerifyBefore','StopAuth0','VerifyVacant','RegisterBridge','StartBridge',
  'VerifyBridge','RestoreAuth0','StartAuth0','VerifyAuth0')){
  if(-not $source.Contains($text)){throw "Missing protected bridge handover contract: $text"}
}
if($source -match '(?i)\b(?:Stop-Process|Set-Clipboard|Unregister-ScheduledTask|Register-ScheduledTask)\b|gh auth token|funnel\s+(?:reset|off|--set-path)'){
  throw 'Handover has forbidden arbitrary mutation or token command.'
}
foreach($name in @('Test-BridgeActionOnlyChanged','Invoke-GuardedBridgeHandover')){
  $fn=$ast.Find({
    param($n)
    $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $n.Name -ceq $name
  }.GetNewClosure(),$true)
  if($null -eq $fn){throw "Bridge handover missing testable function $name"}
  Invoke-Expression $fn.Extent.Text
}
$original='<Task><Principals><Principal><LogonType>InteractiveToken</LogonType></Principal></Principals><Settings><Count>10</Count></Settings><Actions><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -File &quot;C:\protected\relay-supervisor\vaulter-relay-bounded-supervisor.ps1&quot; -Serve</Arguments><WorkingDirectory>C:\trusted</WorkingDirectory></Exec></Actions></Task>'
$updated=$original.Replace('relay-supervisor\vaulter-relay-bounded-supervisor.ps1','relay-supervisor-bridge\vaulter-relay-bounded-supervisor.ps1').Replace(' -Serve</Arguments>',' -Serve -Bridge</Arguments>')
if(-not (Test-BridgeActionOnlyChanged -BeforeXml $original -AfterXml $updated)){throw 'Valid action-only supervised bridge switch was rejected.'}
foreach($broken in @($updated.Replace('<Count>10</Count>','<Count>11</Count>'),$updated.Replace('InteractiveToken','S4U'))){
  if(Test-BridgeActionOnlyChanged -BeforeXml $original -AfterXml $broken){
    throw 'Non-action task modification accepted.'
  }
}
function Ops([string]$FailAt='') {
  $order=New-Object 'System.Collections.Generic.List[string]'
  $ops=@{}
  foreach($n in @('VerifyBefore','StopAuth0','VerifyVacant','RegisterBridge','StartBridge','VerifyBridge','RestoreAuth0','StartAuth0','VerifyAuth0')){
    $key=$n
    $ops[$n]={
      $order.Add($key)
      if($key -ceq $FailAt){throw 'synthetic injected failure'}
    }.GetNewClosure()
  }
  return @{Operations=$ops;Order=$order}
}
$good=Ops
$success=Invoke-GuardedBridgeHandover -Operations $good.Operations
if($success -cne 'activated' -or
   ($good.Order -join ',') -cne 'VerifyBefore,StopAuth0,VerifyVacant,RegisterBridge,StartBridge,VerifyBridge'){
  throw 'Healthy bridge switch did not obey bounded transaction sequence.'
}
$before=Ops 'VerifyBefore'
$failed=$false
try{Invoke-GuardedBridgeHandover -Operations $before.Operations | Out-Null}catch{$failed=$true}
if(-not $failed -or ($before.Order -join ',') -cne 'VerifyBefore'){throw 'Failed preflight performed forbidden mutation.'}
$mid=Ops 'VerifyVacant'
$err=''
try{Invoke-GuardedBridgeHandover -Operations $mid.Operations | Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'ROLLED BACK' -or
  ($mid.Order -join ',') -cne 'VerifyBefore,StopAuth0,VerifyVacant,RestoreAuth0,StartAuth0,VerifyAuth0'){
  throw 'Failed bridge activation must attempt and verify original supervised Auth0 restoration.'
}
$bad=Ops 'VerifyBridge'
$bad.Operations['RestoreAuth0']={throw 'protected rollback denied'}
$err=''
try{Invoke-GuardedBridgeHandover -Operations $bad.Operations | Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'ROLLBACK UNVERIFIED'){throw 'Failed rollback was incorrectly accepted.'}
Write-Output 'VAULTER SUPERVISED BRIDGE HANDOVER CONTRACT PASS'
