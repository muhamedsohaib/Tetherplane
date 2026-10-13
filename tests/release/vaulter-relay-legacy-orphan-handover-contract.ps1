# Offline identity-bound legacy-orphan handover contract. No live Vaulter
# task, listener, Auth0, Composio, PostgreSQL, Holter or human process is
# inspected beyond this synthetic fixture.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-legacy-orphan-handover.ps1'
$existingHandover=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervisor-handover.ps1'
if(-not(Test-Path -LiteralPath $existingHandover -PathType Leaf)){
  throw 'Existing guarded supervisor handover source missing.'
}
$existingSource=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $existingHandover).Path)
foreach($guard in @(
  'Original task restart refused due to occupied port.',
  'Ambiguous live listener during rollback.',
  'Apply requires identical original task snapshot.'
)){
  if(-not $existingSource.Contains($guard)){
    throw ('Existing Apply/Rollback occupied-port refusal was relaxed: '+$guard)
  }
}
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){
  throw 'RED: dedicated legacy-orphan handover source missing.'
}
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){
  $safe=@($parseErrors | ForEach-Object { 'line='+$_.Extent.StartLineNumber+' id='+$_.ErrorId })
  throw ('Legacy-orphan handover has syntax errors: '+($safe -join ', '))
}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($needed in @(
  '[switch]$Inspect','[switch]$Rehearse','[switch]$Recover',
  'Vaulter','Tetherplane Relay','relay-supervisor',
  'AreAccessRulesProtected','Get-FileHash','Get-CimInstance',
  'CreationDate','ExecutablePath','CommandLine','ProcessId',
  'ParentProcessId','Get-NetTCPConnection','Export-ScheduledTask',
  'Start-ScheduledTask','SUPERVISED_AUTH0_VERIFIED',
  'Invoke-GuardedLegacyOrphanHandover','VerifyIdentity',
  'StopIdentityBoundTree','VerifyVacant','ConfirmTaskRegistration',
  'StartSupervisor','VerifySupervised','RestoreEvidence','VerifyRollback',
  'Test-LegacyOrphanIdentity','NO CHANGES MADE','ROLLBACK UNVERIFIED',
  'identity-bound','occupied port'
)){
  if(-not $source.Contains($needed)){throw "Legacy-orphan handover missing safety guard: $needed"}
}
if($source -match '(?i)\btaskkill\b|/T\b|Stop-Process\s+-Name|Kill-Process|Unregister-ScheduledTask|Set-Clipboard|gh auth token|funnel\s+(?:reset|off|--set-path)'){
  throw 'Legacy-orphan handover may not use wildcard kill, taskkill, or mutate other services.'
}
if($source -match '(?i)Stop-Process\s+-Id\s+\d{2,}'){
  throw 'Hard-coded historical PIDs are forbidden.'
}
foreach($f in @(
  'Test-LegacyOrphanIdentity','Invoke-GuardedLegacyOrphanHandover',
  'Test-IdentityBoundStopTarget','Test-IsolatedRehearsalPort'
)){
  $n=$ast.Find({
    param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $f
  }.GetNewClosure(),$true)
  if($null -eq $n){throw "Missing testable legacy-orphan seam $f"}
  Invoke-Expression $n.Extent.Text
}
$created=[datetime]'2026-10-11T12:02:57'
$launcherCreated=[datetime]'2026-10-11T12:02:55'
$expected=@{
  NodePid=4212
  NodeCreated=$created
  NodeExe='C:\Program Files\nodejs\node.exe'
  NodeCommand='node.exe C:\trusted\relay\dist\cli.js --host 127.0.0.1 --port 8788'
  LauncherPid=6024
  LauncherCreated=$launcherCreated
  LauncherExe='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  LauncherCommand='powershell.exe -File C:\trusted\tetherplane-relay.ps1'
  OwnerSid='S-1-5-21-2992529796-3245801626-657214106-1001'
  ListenAddress='127.0.0.1'
  ListenPort=8788
}
$observed=[pscustomobject]@{
  NodePid=4212
  NodeCreated=$created
  NodeExe=$expected.NodeExe
  NodeCommand=$expected.NodeCommand
  LauncherPid=6024
  LauncherCreated=$launcherCreated
  LauncherExe=$expected.LauncherExe
  LauncherCommand=$expected.LauncherCommand
  OwnerSid=$expected.OwnerSid
  ListenAddress='127.0.0.1'
  ListenPort=8788
  GrandparentAlive=$false
}
if(-not(Test-LegacyOrphanIdentity -Expected $expected -Observed $observed)){
  throw 'Exact identity-bound orphan evidence was rejected.'
}
$pidOnly=[pscustomobject]@{
  NodePid=4212;NodeCreated=$null;NodeExe=$null;NodeCommand=$null
  LauncherPid=6024;LauncherCreated=$null;LauncherExe=$null;LauncherCommand=$null
  OwnerSid=$null;ListenAddress='127.0.0.1';ListenPort=8788;GrandparentAlive=$false
}
if(Test-LegacyOrphanIdentity -Expected $expected -Observed $pidOnly){
  throw 'PID-only historical evidence must not authorize recovery.'
}
$stale=[pscustomobject]@{
  NodePid=4212;NodeCreated=([datetime]'2026-10-10T00:00:00')
  NodeExe=$expected.NodeExe;NodeCommand=$expected.NodeCommand
  LauncherPid=6024;LauncherCreated=$launcherCreated
  LauncherExe=$expected.LauncherExe;LauncherCommand=$expected.LauncherCommand
  OwnerSid=$expected.OwnerSid;ListenAddress='127.0.0.1';ListenPort=8788
  GrandparentAlive=$false
}
if(Test-LegacyOrphanIdentity -Expected $expected -Observed $stale){
  throw 'Stale creation time must fail closed.'
}
$wrongSid=[pscustomobject]@{
  NodePid=4212;NodeCreated=$created;NodeExe=$expected.NodeExe
  NodeCommand=$expected.NodeCommand;LauncherPid=6024;LauncherCreated=$launcherCreated
  LauncherExe=$expected.LauncherExe;LauncherCommand=$expected.LauncherCommand
  OwnerSid='S-1-5-18';ListenAddress='127.0.0.1';ListenPort=8788
  GrandparentAlive=$false
}
if(Test-LegacyOrphanIdentity -Expected $expected -Observed $wrongSid){
  throw 'Owner SID mismatch must fail closed.'
}
$publicBind=[pscustomobject]@{
  NodePid=4212;NodeCreated=$created;NodeExe=$expected.NodeExe
  NodeCommand=$expected.NodeCommand;LauncherPid=6024;LauncherCreated=$launcherCreated
  LauncherExe=$expected.LauncherExe;LauncherCommand=$expected.LauncherCommand
  OwnerSid=$expected.OwnerSid;ListenAddress='0.0.0.0';ListenPort=8788
  GrandparentAlive=$false
}
if(Test-LegacyOrphanIdentity -Expected $expected -Observed $publicBind){
  throw 'Non-loopback listener must fail closed.'
}
$aliveGp=[pscustomobject]@{
  NodePid=4212;NodeCreated=$created;NodeExe=$expected.NodeExe
  NodeCommand=$expected.NodeCommand;LauncherPid=6024;LauncherCreated=$launcherCreated
  LauncherExe=$expected.LauncherExe;LauncherCommand=$expected.LauncherCommand
  OwnerSid=$expected.OwnerSid;ListenAddress='127.0.0.1';ListenPort=8788
  GrandparentAlive=$true
}
if(Test-LegacyOrphanIdentity -Expected $expected -Observed $aliveGp){
  throw 'Living grandparent is not a legacy orphan; dedicated recovery must refuse.'
}
$validTarget=@{
  Pid=4212;Created=$created;Exe=$expected.NodeExe;Command=$expected.NodeCommand
  OwnerSid=$expected.OwnerSid
}
$fresh=$validTarget.Clone()
if(-not(Test-IdentityBoundStopTarget -Recorded $validTarget -Fresh $fresh)){
  throw 'Matching revalidated identity must be stop-eligible.'
}
$stalePid=$fresh.Clone();$stalePid.Created=([datetime]'2026-10-10T00:00:00')
if(Test-IdentityBoundStopTarget -Recorded $validTarget -Fresh $stalePid){
  throw 'Recycled PID with different creation time must not be stopped.'
}
$wrongCmd=$fresh.Clone();$wrongCmd.Command='node.exe C:\other\service.js'
if(Test-IdentityBoundStopTarget -Recorded $validTarget -Fresh $wrongCmd){
  throw 'Command identity mismatch must not be stopped.'
}
if(Test-IsolatedRehearsalPort -Port 8788 -TaskName 'Tetherplane Relay'){
  throw 'Rehearsal must refuse the production relay port and task.'
}
if(Test-IsolatedRehearsalPort -Port 8790 -TaskName 'synthetic-orphan-rehearsal'){
  throw 'Rehearsal must refuse the production auth port.'
}
if(-not(Test-IsolatedRehearsalPort -Port 18788 -TaskName 'Tetherplane-Orphan-Rehearsal')){
  throw 'Independent vacant rehearsal port/task was rejected.'
}
function Make-OrphanOps([string]$FailStep=''){
  $steps=New-Object 'System.Collections.Generic.List[string]'
  $ops=@{}
  foreach($n in @('VerifyIdentity','StopIdentityBoundTree','VerifyVacant',
    'ConfirmTaskRegistration','StartSupervisor','VerifySupervised',
    'RestoreEvidence','VerifyRollback')){
    $name=$n
    $ops[$n]={
      $steps.Add($name)
      if($name -ceq $FailStep){throw 'synthetic failure'}
    }.GetNewClosure()
  }
  return @{Steps=$steps;Ops=$ops}
}
$o=Make-OrphanOps
$result=Invoke-GuardedLegacyOrphanHandover -Operations $o.Ops
if($result -cne 'supervised' -or
  ($o.Steps -join ',') -cne 'VerifyIdentity,StopIdentityBoundTree,VerifyVacant,ConfirmTaskRegistration,StartSupervisor,VerifySupervised'){
  throw 'Successful orphan handover must revalidate identity, vacate, then start exactly one supervisor.'
}
$o=Make-OrphanOps 'VerifyIdentity'
$failed=$false
try{Invoke-GuardedLegacyOrphanHandover -Operations $o.Ops|Out-Null}catch{$failed=$true}
if(-not $failed -or $o.Steps.Count -ne 1 -or $o.Steps.Contains('StopIdentityBoundTree')){
  throw 'Failed identity proof must have no interruption.'
}
$o=Make-OrphanOps 'VerifyVacant'
$err=''
try{Invoke-GuardedLegacyOrphanHandover -Operations $o.Ops|Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'ROLLBACK UNVERIFIED|ROLLED BACK' -or
  -not $o.Steps.Contains('RestoreEvidence')){
  throw 'Failure after stopping the proven tree must attempt verified evidence preservation.'
}
$o=Make-OrphanOps 'VerifySupervised'
$o.Ops['RestoreEvidence']={throw 'rollback denied'}
$err=''
try{Invoke-GuardedLegacyOrphanHandover -Operations $o.Ops|Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'ROLLBACK UNVERIFIED'){
  throw 'Rollback failure cannot claim supervised restoration.'
}
Write-Output 'VAULTER LEGACY ORPHAN HANDOVER CONTRACT PASS'
