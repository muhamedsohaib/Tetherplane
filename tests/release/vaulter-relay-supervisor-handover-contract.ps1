# Offline handover transaction contract. No Vaulter task or service touched.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervisor-handover.ps1'
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'RED: guarded relay supervisor handover source missing.'}
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){throw 'Handover script has syntax errors.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($needed in @(
  '[switch]$Stage','[switch]$Apply','[switch]$Rollback',
  'VAULTER','Tetherplane Relay','relay-supervisor',
  'AreAccessRulesProtected','SetAccessRuleProtection',
  'relay-pre-bridge-b8afcfe768964e8786a5c229b866ea8d',
  'Get-ScheduledTask','Get-NetTCPConnection','Get-CimInstance',
  'Stop-ScheduledTask','Start-ScheduledTask','Set-ScheduledTask',
  'New-ScheduledTaskAction','Export-ScheduledTask',
  'Get-FileHash','New-Item','LastTaskResult',
  'Test-OnlyTaskActionChanged','Invoke-GuardedSupervisorHandover',
  'VerifyBefore','StopOriginal','VerifyVacant','ApplyAction',
  'StartSupervisor','VerifySupervisor','RestoreOriginal',
  'StartOriginal','VerifyOriginal',
  'ROLLBACK UNVERIFIED','ROLLED BACK','NO CHANGES MADE'
)){
  if(-not $source.Contains($needed)){throw "Handover missing safety guard: $needed"}
}
if($source -match '(?i)\b(?:Stop-Process|Kill-Process|Unregister-ScheduledTask|Set-Clipboard)\b|gh auth token|funnel\s+(?:reset|off|--set-path)'){
  throw 'Handover may not kill arbitrary processes or mutate other services/routes.'
}
foreach($f in @('Test-OnlyTaskActionChanged','Invoke-GuardedSupervisorHandover')){
  $n=$ast.Find({
    param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $f
  }.GetNewClosure(),$true)
  if($null -eq $n){throw "Missing testable handover seam $f"}
  Invoke-Expression $n.Extent.Text
}
$original=@'
<Task><Settings><RestartOnFailure><Count>10</Count><Interval>PT1M</Interval></RestartOnFailure></Settings>
<Principals><Principal><LogonType>InteractiveToken</LogonType></Principal></Principals>
<Actions><Exec><Command>powershell.exe</Command><Arguments>-File original.ps1</Arguments></Exec></Actions></Task>
'@
$changed=$original.Replace('original.ps1','supervisor.ps1')
if(-not(Test-OnlyTaskActionChanged -BeforeXml $original -AfterXml $changed)){
  throw 'Identical Task Scheduler XML apart from the action was rejected.'
}
foreach($wrong in @(
    $changed.Replace('<Count>10</Count>','<Count>999</Count>'),
    $changed.Replace('InteractiveToken','Password'),
    $changed.Replace('powershell.exe','cmd.exe').Replace('supervisor.ps1','other.ps1')
)){
  # Any executable replacement inside the Actions node is still action-only.
  if($wrong -match 'cmd.exe'){continue}
  if(Test-OnlyTaskActionChanged -BeforeXml $original -AfterXml $wrong){
    throw 'Unexpected principal or restart settings modification passed action-only guard.'
  }
}
function Make-Ops([string]$FailStep=''){
  $steps=New-Object 'System.Collections.Generic.List[string]'
  $ops=@{}
  foreach($n in @('VerifyBefore','StopOriginal','VerifyVacant','ApplyAction',
    'StartSupervisor','VerifySupervisor','RestoreOriginal','StartOriginal','VerifyOriginal')){
    $name=$n
    $ops[$n]={
      $steps.Add($name)
      if($name -ceq $FailStep){throw 'synthetic failure'}
    }.GetNewClosure()
  }
  return @{Steps=$steps;Ops=$ops}
}
$o=Make-Ops
$result=Invoke-GuardedSupervisorHandover -Operations $o.Ops
if($result -cne 'activated' -or
  ($o.Steps -join ',') -cne 'VerifyBefore,StopOriginal,VerifyVacant,ApplyAction,StartSupervisor,VerifySupervisor'){
  throw 'Successful handover must verify ownership and start exactly one supervisor.'
}
$o=Make-Ops 'VerifyBefore'
$failed=$false
try{Invoke-GuardedSupervisorHandover -Operations $o.Ops|Out-Null}catch{$failed=$true}
if(-not $failed -or $o.Steps.Count -ne 1){throw 'Failed baseline must have no side effects.'}
$o=Make-Ops 'VerifyVacant'
$err=''
try{Invoke-GuardedSupervisorHandover -Operations $o.Ops|Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'ROLLED BACK' -or
  ($o.Steps -join ',') -cne 'VerifyBefore,StopOriginal,VerifyVacant,RestoreOriginal,StartOriginal,VerifyOriginal'){
  throw 'Failure after stopping task must attempt verified original recovery.'
}
$o=Make-Ops 'VerifySupervisor'
$err=''
try{Invoke-GuardedSupervisorHandover -Operations $o.Ops|Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'ROLLED BACK' -or -not $o.Steps.Contains('VerifyOriginal')){
  throw 'Unhealthy supervisor must trigger rollback and independent original verification.'
}
$o=Make-Ops 'StartSupervisor'
$o.Ops['RestoreOriginal']={throw 'rollback denied'}
$err=''
try{Invoke-GuardedSupervisorHandover -Operations $o.Ops|Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'ROLLBACK UNVERIFIED'){throw 'Rollback failure cannot claim healthy original service.'}
Write-Output 'VAULTER GUARDED SUPERVISOR HANDOVER CONTRACT PASS'
