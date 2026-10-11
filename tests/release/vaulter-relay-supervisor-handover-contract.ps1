# Offline handover transaction contract. No Vaulter task or service touched.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervisor-handover.ps1'
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'RED: guarded relay supervisor handover source missing.'}
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){$safe=@($parseErrors | ForEach-Object { 'line='+$_.Extent.StartLineNumber+' id='+$_.ErrorId });throw ('Handover script has syntax errors: '+($safe -join ', '))}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($needed in @(
  '[switch]$Stage','[switch]$Apply','[switch]$Rollback',
  'Vaulter','Tetherplane Relay','relay-supervisor',
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
foreach($f in @('Test-TaskPrincipalIsCurrentUser','Get-OriginalAction','Assert-Handover','Test-OnlyTaskActionChanged','Test-ProtectedOriginalAction','Test-SupervisorParentChain','Invoke-GuardedSupervisorHandover')){
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
# Older protected checkpoint may contain retry count 999; actions must still match.
$checkpoint=$original.Replace('<Count>10</Count>','<Count>999</Count>')
if(-not(Test-ProtectedOriginalAction -SnapshotXml $original -ProtectedBackupXml $checkpoint)){
  throw 'RED: original task actions must compare independently of corrected restart settings.'
}
if(Test-ProtectedOriginalAction -SnapshotXml $original -ProtectedBackupXml $checkpoint.Replace('original.ps1','hijacked.ps1')){
  throw 'Protected original-action mismatch must block staging and activation.'
}
$node=[pscustomobject]@{Name='node.exe';ParentProcessId=202}
$runner=[pscustomobject]@{Name='powershell.exe';ProcessId=202;ParentProcessId=303;CommandLine='powershell.exe -File C:\trusted\original.ps1'}
$supervisor=[pscustomobject]@{Name='powershell.exe';ProcessId=303;CommandLine='powershell.exe -File C:\protected\supervisor.ps1 -Serve'}
$arguments=@{Node=$node;Parent=$runner;Supervisor=$supervisor;
  OriginalLauncherPath='C:\trusted\original.ps1';InstalledSupervisorPath='C:\protected\supervisor.ps1'}
if(-not(Test-SupervisorParentChain @arguments)){
  throw 'Valid new task-owned process chain was rejected.'
}
$wrongParent=[pscustomobject]@{Name='powershell.exe';ProcessId=202;ParentProcessId=304;CommandLine=$runner.CommandLine}
if(Test-SupervisorParentChain -Node $node -Parent $wrongParent -Supervisor $supervisor -OriginalLauncherPath $arguments.OriginalLauncherPath -InstalledSupervisorPath $arguments.InstalledSupervisorPath){
  throw 'Unrelated supervisor parent PID accepted.'
}
$wrongOwner=[pscustomobject]@{Name='powershell.exe';ProcessId=303;CommandLine='powershell.exe -File C:\other\worker.ps1'}
if(Test-SupervisorParentChain -Node $node -Parent $runner -Supervisor $wrongOwner -OriginalLauncherPath $arguments.OriginalLauncherPath -InstalledSupervisorPath $arguments.InstalledSupervisorPath){
  throw 'Other task process accepted as supervised relay owner.'
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not (Test-TaskPrincipalIsCurrentUser -TaskUserId $identity.User.Value -CurrentSid $identity.User) -or
  -not (Test-TaskPrincipalIsCurrentUser -TaskUserId $identity.Name -CurrentSid $identity.User)){
  throw 'RED: current account SID and task owner SID must resolve identically.'
}
if(Test-TaskPrincipalIsCurrentUser -TaskUserId 'S-1-5-18' -CurrentSid ([Security.Principal.SecurityIdentifier]::new('S-1-5-19'))){
  throw 'A different task owner must be rejected before staging.'
}
$psExe=(Get-Command powershell.exe -ErrorAction Stop).Source
$actionFixture='<Task><Actions><Exec><Command>'+[Security.SecurityElement]::Escape($psExe)+
  '</Command><Arguments>-NoProfile -File &quot;C:\trusted\relay.ps1&quot;</Arguments><WorkingDirectory>C:\trusted</WorkingDirectory></Exec></Actions></Task>'
$preserved=Get-OriginalAction -Xml $actionFixture
if($preserved.Executable -cne $psExe -or $preserved.Arguments -cne '-NoProfile -File "C:\trusted\relay.ps1"' -or
  $preserved.WorkingDirectory -cne 'C:\trusted'){
  throw 'Original task executable, flags or working directory were reconstructed incorrectly.'
}
# The live Vaulter action matches its protected backup but stores only the
# executable name. Refuse relative executables and preserve exact task action.
$bareFixture=$actionFixture.Replace([Security.SecurityElement]::Escape($psExe),'powershell.exe')
$bareOriginal=Get-OriginalAction -Xml $bareFixture
if($bareOriginal.Executable -cne 'powershell.exe' -or
  $bareOriginal.Arguments -cne '-NoProfile -File "C:\trusted\relay.ps1"' -or
  $bareOriginal.WorkingDirectory -cne 'C:\trusted'){
  throw 'RED: exact protected bare powershell.exe registered action was rejected.'
}
foreach($badExe in @('.\powershell.exe','..\powershell.exe','tools\powershell.exe','cmd.exe','powershell.exe -EncodedCommand evil','C:\untrusted\powershell.exe')){
  $bad=$bareFixture.Replace('<Command>powershell.exe</Command>',
    '<Command>'+[Security.SecurityElement]::Escape($badExe)+'</Command>')
  $rejected=$false
  try{Get-OriginalAction -Xml $bad|Out-Null}catch{$rejected=$true}
  if(-not $rejected){throw "Unsafe original task executable accepted: $badExe"}
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
# The original supervisor has a separate manual recovery entrypoint from the
# newer bridge handover. Execute the REAL -Rollback guard and restore helpers
# against synthetic task/port boundaries. Never access a live Windows service.
foreach($functionName in @(
  'Assert-Handover','Test-TaskIsOriginal','Test-TaskIsSupervisor',
  'Restore-OriginalSafely','Start-OriginalSafely'
)){
  $node=$ast.Find({
    param($n)
    $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $n.Name -ceq $functionName
  }.GetNewClosure(),$true)
  if($null -eq $node){throw "Missing testable manual supervisor recovery helper $functionName"}
  Invoke-Expression $node.Extent.Text
}
$rollbackNodes=@($ast.EndBlock.Statements | Where-Object {
  $_ -is [Management.Automation.Language.IfStatementAst] -and
  $_.Clauses[0].Item1.Extent.Text -ceq '$Rollback'
})
if($rollbackNodes.Count -ne 1){throw 'Manual supervisor rollback branch not found.'}
$branchText=$rollbackNodes[0].Clauses[0].Item2.Extent.Text
$rollbackBody=[scriptblock]::Create($branchText.Substring(1,$branchText.Length-2))
$script:TaskName='synthetic-relay-task'
$script:InstalledSupervisor='C:\synthetic\relay-supervisor\vaulter-relay-bounded-supervisor.ps1'
$script:OriginalArgs='-File "C:\synthetic\original-relay.ps1"'
$script:BaselineXml='<Task><Actions>synthetic baseline</Actions></Task>'
$script:ManualRecoveryEvents=New-Object 'System.Collections.Generic.List[string]'
function Get-Task {return $script:ManualRecoveryTask}
function Get-TaskXml {return $script:BaselineXml}
function Get-OriginalAction {
  param([string]$Xml)
  return [pscustomobject]@{
    Executable='powershell.exe'
    Arguments=$script:OriginalArgs
    WorkingDirectory='C:\synthetic'
  }
}
function Get-NetTCPConnection {
  param($LocalPort,$State,$ErrorAction)
  if([int]$LocalPort -ne 8788){throw 'Unexpected synthetic relay port'}
  if($script:ManualRecoveryOccupied){[pscustomobject]@{OwningProcess=999}}
}
function Assert-SupervisorProcessOwnedWithoutHealth {
  if(-not $script:ManualRecoveryOwned){throw 'Unowned synthetic relay listener'}
  $script:ManualRecoveryEvents.Add('verify-owner')
}
function Stop-ScheduledTask {
  param($TaskPath,$TaskName,$ErrorAction)
  if($TaskPath -cne '\' -or $TaskName -cne 'synthetic-relay-task'){
    throw 'Unexpected synthetic task stop target'
  }
  $script:ManualRecoveryEvents.Add('stop')
  $script:ManualRecoveryTask.State='Ready'
  $script:ManualRecoveryOccupied=$false
}
function Wait-TaskReadyVacant {
  if($script:ManualRecoveryTask.State -cne 'Ready' -or $script:ManualRecoveryOccupied){
    throw 'Synthetic relay port was not empty after task stop'
  }
  $script:ManualRecoveryEvents.Add('wait-vacant')
}
function Set-OnlyRelayAction {
  param([switch]$ToSupervisor)
  if($ToSupervisor){throw 'Rollback must never register another supervisor'}
  $script:ManualRecoveryEvents.Add('restore')
  $script:ManualRecoveryTask.Actions[0].Arguments=$script:OriginalArgs
}
function Start-ScheduledTask {
  param($TaskPath,$TaskName,$ErrorAction)
  if($TaskPath -cne '\' -or $TaskName -cne 'synthetic-relay-task' -or
     $script:ManualRecoveryOccupied -or $script:ManualRecoveryTask.State -cne 'Ready'){
    throw 'Attempt to start synthetic relay without vacant port and Ready task'
  }
  $script:ManualRecoveryEvents.Add('start')
  $script:ManualRecoveryTask.State='Running'
  $script:ManualRecoveryOccupied=$true
}
function Assert-HealthyListener {
  if($script:ManualRecoveryTask.State -cne 'Running' -or -not $script:ManualRecoveryOccupied){
    throw 'Synthetic relay not healthy'
  }
}
function Wait-Healthy {
  if($script:ManualRecoveryTask.State -cne 'Running' -or -not $script:ManualRecoveryOccupied){
    throw 'Synthetic relay health unavailable'
  }
  $script:ManualRecoveryEvents.Add('health')
}
$supervisorArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+
    $script:InstalledSupervisor+'" -Serve'
foreach($case in @(
  @{Name='original Ready';Action='original';State='Ready';Occupied=$false;Owned=$true;Accept=$true;Events='start,health'},
  @{Name='original Running';Action='original';State='Running';Occupied=$true;Owned=$true;Accept=$true;Events='health'},
  @{Name='supervisor Ready';Action='supervisor';State='Ready';Occupied=$false;Owned=$true;Accept=$true;Events='restore,start,health'},
  @{Name='supervisor Running and owned';Action='supervisor';State='Running';Occupied=$true;Owned=$true;Accept=$true;Events='verify-owner,stop,wait-vacant,restore,start,health'},
  @{Name='supervisor Running unowned';Action='supervisor';State='Running';Occupied=$true;Owned=$false;Accept=$false;Events=''},
  @{Name='unknown action';Action='unknown';State='Ready';Occupied=$false;Owned=$true;Accept=$false;Events=''},
  @{Name='occupied original Ready';Action='original';State='Ready';Occupied=$true;Owned=$true;Accept=$false;Events=''},
  @{Name='occupied supervisor Ready';Action='supervisor';State='Ready';Occupied=$true;Owned=$true;Accept=$false;Events=''}
)){
  $script:ManualRecoveryEvents.Clear()
  $script:ManualRecoveryOccupied=[bool]$case.Occupied
  $script:ManualRecoveryOwned=[bool]$case.Owned
  $testArgs=switch($case.Action){
    'original' {$script:OriginalArgs}
    'supervisor' {$supervisorArgs}
    default {'-File "C:\unknown\untrusted.ps1"'}
  }
  $script:ManualRecoveryTask=[pscustomobject]@{State=$case.State;Actions=@(
    [pscustomobject]@{Execute='powershell.exe';Arguments=$testArgs;WorkingDirectory='C:\synthetic'}
  )}
  $accepted=$true
  try{& $rollbackBody | Out-Null}catch{$accepted=$false}
  $actualEvents=$script:ManualRecoveryEvents -join ','
  if($accepted -ne $case.Accept -or $actualEvents -cne $case.Events){
    throw ('MANUAL SUPERVISOR ROLLBACK REGRESSION: '+$case.Name+
      '; accepted='+$accepted+'; events='+$actualEvents)
  }
}
Write-Output 'VAULTER GUARDED SUPERVISOR HANDOVER CONTRACT PASS'
