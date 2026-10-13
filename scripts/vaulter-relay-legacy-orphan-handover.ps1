<#
.SYNOPSIS
  Dedicated identity-bound recovery for a Ready Tetherplane Relay task whose
  original Auth0 listener is a proven legacy orphan.
.DESCRIPTION
  Existing -Apply/-Rollback refuse a Ready task with an occupied port; this
  script does not relax that refusal. Default is read-only Inspect.
  -Rehearse uses an isolated vacant loopback port and never the production
  relay or auth endpoints. -Recover stops only a revalidated identity-bound
  tree, then starts the already-registered protected supervisor.
  No bridge activation, Composio mutation, Funnel change, PostgreSQL, Holter
  or unrelated process termination.
#>
[CmdletBinding(DefaultParameterSetName='Inspect')]
param(
  [Parameter(ParameterSetName='Inspect')][switch]$Inspect,
  [Parameter(ParameterSetName='Rehearse')][switch]$Rehearse,
  [Parameter(ParameterSetName='Recover')][switch]$Recover
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$script:TaskName='Tetherplane Relay'
$script:StateDir=Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:StageDir=Join-Path $script:StateDir 'relay-supervisor'
$script:ProtectedBackupDir=Join-Path $script:StateDir 'relay-pre-bridge-b8afcfe768964e8786a5c229b866ea8d'
$script:InstalledSupervisor=Join-Path $script:StageDir 'vaulter-relay-bounded-supervisor.ps1'
$script:OriginalLauncherHash='5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8'
$script:TrustedNode=Join-Path $env:ProgramFiles 'nodejs\node.exe'
$script:RehearsalPort=18788
$script:RehearsalTask='Tetherplane-Orphan-Rehearsal'
$script:EvidenceDir=''

function Assert-Orphan([bool]$Ok,[string]$Reason){
  if(-not $Ok){throw $Reason}
}
function Get-ProcessFileArgument {
  [CmdletBinding()]
  param([string]$CommandLine)
  if([string]::IsNullOrWhiteSpace($CommandLine)){return $null}
  $matches=@([regex]::Matches($CommandLine,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))(?=\s|$)'))
  if($matches.Count -ne 1){return $null}
  foreach($group in @(1,2,3)){
    if($matches[0].Groups[$group].Success){
      return [string]$matches[0].Groups[$group].Value
    }
  }
  return $null
}
function Test-SameText([string]$Left,[string]$Right,[switch]$IgnoreCase){
  if($null -eq $Left -or $null -eq $Right){return $false}
  if($IgnoreCase){
    return [string]::Equals($Left,$Right,[StringComparison]::OrdinalIgnoreCase)
  }
  return [string]::Equals($Left,$Right,[StringComparison]::Ordinal)
}
function Test-LegacyOrphanIdentity {
  [CmdletBinding()]
  param($Expected,$Observed)
  try{
    if($null -eq $Expected -or $null -eq $Observed){return $false}
    if([bool]$Observed.GrandparentAlive){return $false}
    if(-not [string]::Equals([string]$Observed.ListenAddress,'127.0.0.1',[StringComparison]::Ordinal)){return $false}
    if([int]$Observed.ListenPort -ne [int]$Expected.ListenPort){return $false}
    if([int]$Observed.ListenPort -le 0){return $false}
    if([int]$Observed.NodePid -le 0 -or [int]$Observed.LauncherPid -le 0){return $false}
    if($null -eq $Observed.NodeCreated -or $null -eq $Observed.LauncherCreated){return $false}
    if([string]::IsNullOrWhiteSpace([string]$Observed.NodeExe) -or
       [string]::IsNullOrWhiteSpace([string]$Observed.NodeCommand) -or
       [string]::IsNullOrWhiteSpace([string]$Observed.LauncherExe) -or
       [string]::IsNullOrWhiteSpace([string]$Observed.LauncherCommand) -or
       [string]::IsNullOrWhiteSpace([string]$Observed.OwnerSid)){return $false}
    if([int]$Observed.NodePid -ne [int]$Expected.NodePid){return $false}
    if([datetime]$Observed.NodeCreated -ne [datetime]$Expected.NodeCreated){return $false}
    if(-not [string]::Equals([string]$Observed.NodeExe,[string]$Expected.NodeExe,[StringComparison]::OrdinalIgnoreCase)){return $false}
    if(-not [string]::Equals([string]$Observed.NodeCommand,[string]$Expected.NodeCommand,[StringComparison]::Ordinal)){return $false}
    if([int]$Observed.LauncherPid -ne [int]$Expected.LauncherPid){return $false}
    if([datetime]$Observed.LauncherCreated -ne [datetime]$Expected.LauncherCreated){return $false}
    if(-not [string]::Equals([string]$Observed.LauncherExe,[string]$Expected.LauncherExe,[StringComparison]::OrdinalIgnoreCase)){return $false}
    if(-not [string]::Equals([string]$Observed.LauncherCommand,[string]$Expected.LauncherCommand,[StringComparison]::Ordinal)){return $false}
    if(-not [string]::Equals([string]$Observed.OwnerSid,[string]$Expected.OwnerSid,[StringComparison]::Ordinal)){return $false}
    if([datetime]$Observed.LauncherCreated -gt [datetime]$Observed.NodeCreated){return $false}
    return $true
  }catch{return $false}
}
function Test-IdentityBoundStopTarget {
  [CmdletBinding()]
  param($Recorded,$Fresh)
  try{
    if($null -eq $Recorded -or $null -eq $Fresh){return $false}
    if([int]$Recorded.Pid -le 0 -or [int]$Fresh.Pid -le 0){return $false}
    if([int]$Recorded.Pid -ne [int]$Fresh.Pid){return $false}
    if($null -eq $Recorded.Created -or $null -eq $Fresh.Created){return $false}
    if([datetime]$Recorded.Created -ne [datetime]$Fresh.Created){return $false}
    if([string]::IsNullOrWhiteSpace([string]$Fresh.Exe) -or
       [string]::IsNullOrWhiteSpace([string]$Fresh.Command) -or
       [string]::IsNullOrWhiteSpace([string]$Fresh.OwnerSid)){return $false}
    if(-not [string]::Equals([string]$Recorded.Exe,[string]$Fresh.Exe,[StringComparison]::OrdinalIgnoreCase)){return $false}
    if(-not [string]::Equals([string]$Recorded.Command,[string]$Fresh.Command,[StringComparison]::Ordinal)){return $false}
    if(-not [string]::Equals([string]$Recorded.OwnerSid,[string]$Fresh.OwnerSid,[StringComparison]::Ordinal)){return $false}
    return $true
  }catch{return $false}
}
function Test-IsolatedRehearsalPort {
  [CmdletBinding()]
  param([int]$Port,[string]$TaskName)
  try{
    if($Port -in @(22,443,3389,5432,8001,8002,8443,8788,8790,9443,9445)){return $false}
    if($Port -lt 1024 -or $Port -gt 65535){return $false}
    if([string]::IsNullOrWhiteSpace($TaskName)){return $false}
    if($TaskName -match '(?i)^(Tetherplane Relay|Tetherplane VAULTER Agent|Tetherplane-TetherAuth-Startup|Composio Vaulter Bridge)$'){
      return $false
    }
    return ($TaskName -like 'Tetherplane-Orphan-Rehearsal*')
  }catch{return $false}
}
function Invoke-GuardedLegacyOrphanHandover {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][hashtable]$Operations)
  foreach($step in @('VerifyIdentity','StopIdentityBoundTree','VerifyVacant',
    'ConfirmTaskRegistration','StartSupervisor','VerifySupervised',
    'RestoreEvidence','VerifyRollback')){
    if(-not $Operations.ContainsKey($step) -or $Operations[$step] -isnot [scriptblock]){
      throw 'Missing legacy-orphan handover transaction operation.'
    }
  }
  & $Operations['VerifyIdentity']
  try{
    & $Operations['StopIdentityBoundTree']
    & $Operations['VerifyVacant']
    & $Operations['ConfirmTaskRegistration']
    & $Operations['StartSupervisor']
    & $Operations['VerifySupervised']
    return 'supervised'
  }catch{
    try{
      & $Operations['RestoreEvidence']
      & $Operations['VerifyRollback']
    }catch{
      throw 'LEGACY ORPHAN HANDOVER ROLLBACK UNVERIFIED. Do not repeat, reboot, or terminate unknown listeners.'
    }
    throw 'LEGACY ORPHAN HANDOVER FAILED; EVIDENCE PRESERVED AND ROLLED BACK.'
  }
}

function Get-ProcessOwnerSid([int]$ProcessId){
  $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId) -ErrorAction Stop
  $owner=Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid -ErrorAction Stop
  Assert-Orphan (-not [string]::IsNullOrWhiteSpace([string]$owner.Sid)) 'Process owner SID unavailable.'
  return [string]$owner.Sid
}
function Get-ProcessIdentity([int]$ProcessId){
  $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId) -ErrorAction Stop
  Assert-Orphan ($null -ne $proc) 'Required process identity disappeared.'
  return @{
    Pid=[int]$proc.ProcessId
    ParentProcessId=[int]$proc.ParentProcessId
    Created=[datetime]$proc.CreationDate
    Exe=[string]$proc.ExecutablePath
    Command=[string]$proc.CommandLine
    Name=[string]$proc.Name
    OwnerSid=(Get-ProcessOwnerSid -ProcessId $ProcessId)
  }
}
function Get-TrustedOriginalLauncher {
  $copy=Join-Path $script:ProtectedBackupDir 'launcher.ps1'
  $snapshot=Join-Path $script:StageDir 'pre-supervisor-task.xml'
  Assert-Orphan (Test-Path -LiteralPath $copy -PathType Leaf) 'Protected original launcher copy missing.'
  Assert-Orphan ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Protected rollback launcher digest mismatch.'
  [xml]$xml=Get-Content -LiteralPath $snapshot -Raw -ErrorAction Stop
  $action=@($xml.SelectNodes("//*[local-name()='Actions']/*"))
  Assert-Orphan ($action.Count -eq 1) 'Protected original action missing.'
  $argsNode=$action[0].SelectSingleNode("*[local-name()='Arguments']")
  $launcher=Get-ProcessFileArgument -CommandLine ([string]$argsNode.InnerText)
  Assert-Orphan (Test-Path -LiteralPath $launcher -PathType Leaf) 'Live original launcher missing.'
  Assert-Orphan ((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Live original launcher hash changed.'
  return [IO.Path]::GetFullPath($launcher)
}
function Get-LiveOrphanObservation {
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction Stop)
  Assert-Orphan ($listeners.Count -eq 1 -and
    [string]$listeners[0].LocalAddress -ceq '127.0.0.1' -and
    [int]$listeners[0].OwningProcess -gt 0) 'No exclusive identity-bound loopback relay.'
  $node=Get-ProcessIdentity -ProcessId ([int]$listeners[0].OwningProcess)
  Assert-Orphan ($node.Name -ieq 'node.exe') 'Relay listener is not Node.'
  $launcher=Get-ProcessIdentity -ProcessId ([int]$node.ParentProcessId)
  Assert-Orphan ($launcher.Name -ieq 'powershell.exe') 'Relay parent is not PowerShell.'
  $grandparentAlive=$false
  try{
    $gp=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$launcher.ParentProcessId) -ErrorAction Stop
    if($null -ne $gp){$grandparentAlive=$true}
  }catch{}
  $current=[Security.Principal.WindowsIdentity]::GetCurrent()
  Assert-Orphan ((Test-SameText $node.OwnerSid ([string]$current.User.Value)) -and
    (Test-SameText $launcher.OwnerSid ([string]$current.User.Value))) 'Relay tree owner SID differs from operator.'
  return [pscustomobject]@{
    NodePid=$node.Pid
    NodeCreated=$node.Created
    NodeExe=$node.Exe
    NodeCommand=$node.Command
    LauncherPid=$launcher.Pid
    LauncherCreated=$launcher.Created
    LauncherExe=$launcher.Exe
    LauncherCommand=$launcher.Command
    OwnerSid=$node.OwnerSid
    ListenAddress=[string]$listeners[0].LocalAddress
    ListenPort=8788
    GrandparentAlive=$grandparentAlive
    NodeParentProcessId=$node.ParentProcessId
    LauncherParentProcessId=$launcher.ParentProcessId
  }
}
function Test-TrustedOrphanShape($Observed,[string]$LauncherPath){
  if($null -eq $Observed){return $false}
  if(-not (Test-SameText ([string]$Observed.NodeExe) $script:TrustedNode -IgnoreCase)){return $false}
  if(([string]$Observed.NodeCommand) -notmatch '(?i)--host\s+127\.0\.0\.1'){return $false}
  if(([string]$Observed.NodeCommand) -notmatch '(?i)--port\s+8788'){return $false}
  if(([string]$Observed.NodeCommand) -match '(?i)(?:^|\s)-(?:Bridge|EncodedCommand)(?=\s|$)'){return $false}
  $trustedPs=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if(-not (Test-SameText ([string]$Observed.LauncherExe) $trustedPs -IgnoreCase)){return $false}
  $file=Get-ProcessFileArgument -CommandLine ([string]$Observed.LauncherCommand)
  if([string]::IsNullOrWhiteSpace($file)){return $false}
  if(-not (Test-SameText ([IO.Path]::GetFullPath($file)) ([IO.Path]::GetFullPath($LauncherPath)) -IgnoreCase)){return $false}
  return $true
}
function Assert-TaskIsProtectedSupervisor {
  $task=Get-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
  $expected='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:InstalledSupervisor+'" -Serve'
  Assert-Orphan ([bool]$task.Settings.Enabled -and
    [string]$task.State -ceq 'Ready' -and
    [string]$task.Principal.LogonType -ceq 'Interactive' -and
    [string]$task.Settings.MultipleInstances -ceq 'IgnoreNew' -and
    [int]$task.Settings.RestartCount -eq 10 -and
    [string]$task.Settings.RestartInterval -ceq 'PT1M' -and
    @($task.Actions).Count -eq 1 -and
    [string]$task.Actions[0].Arguments -ceq $expected) 'Protected supervisor task registration is not Ready for identity-bound recovery.'
  return $task
}
function Save-OrphanEvidence([string]$Phase,$Observation,[string]$Verdict){
  if([string]::IsNullOrWhiteSpace($script:EvidenceDir)){
    $script:EvidenceDir=Join-Path $script:StateDir ('legacy-orphan-handover-'+(Get-Date -Format 'yyyyMMddHHmmss'))
    New-Item -ItemType Directory -Path $script:EvidenceDir -ErrorAction Stop | Out-Null
    $acl=Get-Acl -LiteralPath $script:EvidenceDir -ErrorAction Stop
    $acl.SetAccessRuleProtection($true,$true)
    Set-Acl -LiteralPath $script:EvidenceDir -AclObject $acl -ErrorAction Stop
    Assert-Orphan ((Get-Acl -LiteralPath $script:EvidenceDir).AreAccessRulesProtected) 'Orphan evidence ACL not protected.'
  }
  $record=[ordered]@{
    phase=$Phase
    verdict=$Verdict
    node_pid=if($null -eq $Observation){0}else{[int]$Observation.NodePid}
    node_created=if($null -eq $Observation){''}else{[string]$Observation.NodeCreated}
    launcher_pid=if($null -eq $Observation){0}else{[int]$Observation.LauncherPid}
    launcher_created=if($null -eq $Observation){''}else{[string]$Observation.LauncherCreated}
    owner_sid_present=[bool]($null -ne $Observation -and -not [string]::IsNullOrWhiteSpace([string]$Observation.OwnerSid))
    no_command_lines=$true
  }
  $path=Join-Path $script:EvidenceDir ($Phase+'.json')
  [IO.File]::WriteAllText($path,($record|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
function Stop-IdentityBoundProcess($Recorded){
  $fresh=Get-ProcessIdentity -ProcessId ([int]$Recorded.Pid)
  Assert-Orphan (Test-IdentityBoundStopTarget -Recorded $Recorded -Fresh $fresh) 'Fresh process identity diverged; stop refused.'
  Stop-Process -Id ([int]$fresh.Pid) -ErrorAction Stop
}
function Wait-PortVacant([int]$Port,[int]$Seconds=25){
  $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
  while([DateTime]::UtcNow -lt $deadline){
    $listen=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if($listen.Count -eq 0){return}
    Start-Sleep -Milliseconds 400
  }
  throw ('Port '+$Port+' remained an occupied port after identity-bound stop.')
}
function Get-SupervisionProbe {
  . (Join-Path $PSScriptRoot 'vaulter-relay-supervision-preflight.ps1')
  return Get-VaulterSupervisionSnapshot
}

if($MyInvocation.InvocationName -eq '.'){return}

Assert-Orphan ($env:OS -eq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'Vaulter') 'Vaulter-only identity-bound orphan recovery.'
$modeCount=@($Inspect,$Rehearse,$Recover | Where-Object {$_}).Count
Assert-Orphan ($modeCount -le 1) 'Choose exactly one of Inspect, Rehearse or Recover.'

if($Rehearse){
  Assert-Orphan (Test-IsolatedRehearsalPort -Port $script:RehearsalPort -TaskName $script:RehearsalTask) 'Rehearsal refused production relay/auth identity.'
  Assert-Orphan (@(Get-NetTCPConnection -State Listen -LocalPort $script:RehearsalPort -ErrorAction SilentlyContinue).Count -eq 0) 'Isolated rehearsal port is already occupied.'
  $child=$null
  try{
    $psi=New-Object Diagnostics.ProcessStartInfo
    $psi.FileName=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $psi.Arguments='-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -Command "$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,'+$script:RehearsalPort+');$l.Start();try{Start-Sleep -Seconds 60}finally{$l.Stop()}"'
    $psi.UseShellExecute=$false
    $psi.CreateNoWindow=$true
    $child=[Diagnostics.Process]::Start($psi)
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    do{
      $listen=@(Get-NetTCPConnection -State Listen -LocalPort $script:RehearsalPort -ErrorAction SilentlyContinue)
      if($listen.Count -eq 1 -and [int]$listen[0].OwningProcess -eq [int]$child.Id){break}
      Start-Sleep -Milliseconds 200
    }while([DateTime]::UtcNow -lt $deadline)
    $recorded=Get-ProcessIdentity -ProcessId ([int]$child.Id)
    $fresh=Get-ProcessIdentity -ProcessId ([int]$child.Id)
    Assert-Orphan (Test-IdentityBoundStopTarget -Recorded $recorded -Fresh $fresh) 'Rehearsal identity could not be revalidated.'
    Stop-IdentityBoundProcess -Recorded $recorded
    Wait-PortVacant -Port $script:RehearsalPort -Seconds 10
    Write-Output 'LEGACY ORPHAN REHEARSAL PASS: isolated identity-bound stop vacated the non-production port.'
    Write-Output 'NO CHANGES MADE to Tetherplane Relay, Auth0, or occupied production listeners.'
  }finally{
    if($null -ne $child -and -not $child.HasExited){
      try{Stop-Process -Id ([int]$child.Id) -ErrorAction SilentlyContinue}catch{}
    }
    if($null -ne $child){$child.Dispose()}
  }
  return
}

$probe=Get-SupervisionProbe
if(-not $Recover){
  Write-Output ($probe|ConvertTo-Json -Depth 5)
  Write-Output 'LEGACY ORPHAN INSPECT: read-only identity inventory only.'
  Write-Output 'NO CHANGES MADE. Recover requires a separate identity-bound -Recover after rehearsal.'
  return
}

Assert-Orphan ($probe.supervisor_verdict -ceq 'TASK_INACTIVE_LISTENER_PRESENT') 'Recover requires a Ready task with a present loopback listener.'
Assert-Orphan ([bool]$probe.protected_supervisor_stage_verified -and
  [bool]$probe.exact_supervisor_task_action_verified -and
  [bool]$probe.relay_listener_loopback_only -and
  [bool]$probe.local_and_public_relay_healthy -and
  [bool]$probe.auth_healthy -and
  [bool]$probe.auth0_issuer_unchanged -and
  -not [bool]$probe.task_owned_process_chain_verified) 'Ownership or Auth0 health gates failed; no interruption.'

$launcherPath=Get-TrustedOriginalLauncher
$script:BaselineXml=[string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop)
$null=Assert-TaskIsProtectedSupervisor
$script:recorded=$null
$script:authPid=0
$ops=@{
  VerifyIdentity={
    $authListeners=@(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction Stop)
    Assert-Orphan ($authListeners.Count -eq 1 -and
      [string]$authListeners[0].LocalAddress -ceq '127.0.0.1') 'Auth loopback identity changed.'
    $script:authPid=[int]$authListeners[0].OwningProcess
    $first=Get-LiveOrphanObservation
    Assert-Orphan (-not [bool]$first.GrandparentAlive) 'Living supervisor grandparent is not a legacy orphan.'
    Assert-Orphan (Test-TrustedOrphanShape -Observed $first -LauncherPath $launcherPath) 'Live tree is not the trusted original Auth0 launcher/node pair.'
    Start-Sleep -Milliseconds 250
    $second=Get-LiveOrphanObservation
    Assert-Orphan (Test-LegacyOrphanIdentity -Expected $first -Observed $second) 'Orphan identity was not stable under revalidation.'
    $mutex=$null
    $owns=$false
    try{
      $mutex=[Threading.Mutex]::new($false,'Global\TetherplaneVaulterRelaySupervisor')
      try{$owns=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owns=$true}
      Assert-Orphan $owns 'Supervisor mutex still held; identity-bound recovery refused.'
    }finally{
      if($owns -and $null -ne $mutex){$mutex.ReleaseMutex()}
      if($null -ne $mutex){$mutex.Dispose()}
    }
    $script:recorded=$second
    Save-OrphanEvidence -Phase 'verify-identity' -Observation $second -Verdict 'identity-bound'
    $null=Assert-TaskIsProtectedSupervisor
    Assert-Orphan (([string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName)) -ceq $script:BaselineXml) 'Task XML drifted before interruption.'
  }
  StopIdentityBoundTree={
    $nodeTarget=@{
      Pid=[int]$script:recorded.NodePid
      Created=[datetime]$script:recorded.NodeCreated
      Exe=[string]$script:recorded.NodeExe
      Command=[string]$script:recorded.NodeCommand
      OwnerSid=[string]$script:recorded.OwnerSid
    }
    $launcherTarget=@{
      Pid=[int]$script:recorded.LauncherPid
      Created=[datetime]$script:recorded.LauncherCreated
      Exe=[string]$script:recorded.LauncherExe
      Command=[string]$script:recorded.LauncherCommand
      OwnerSid=[string]$script:recorded.OwnerSid
    }
    Stop-IdentityBoundProcess -Recorded $nodeTarget
    try{Stop-IdentityBoundProcess -Recorded $launcherTarget}catch{}
  }
  VerifyVacant={
    Wait-PortVacant -Port 8788
    $task=Get-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    Assert-Orphan ([string]$task.State -ceq 'Ready') 'Relay task left Ready state during vacancy proof.'
    $auth=@(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction Stop)
    Assert-Orphan ($auth.Count -eq 1 -and [int]$auth[0].OwningProcess -eq $script:authPid) 'Auth process identity changed during relay vacancy.'
  }
  ConfirmTaskRegistration={
    Assert-Orphan (([string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName)) -ceq $script:BaselineXml) 'Task XML changed after vacancy.'
    $null=Assert-TaskIsProtectedSupervisor
  }
  StartSupervisor={
    $listen=@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
    Assert-Orphan ($listen.Count -eq 0) 'Supervisor start refused due to occupied port.'
    Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
  }
  VerifySupervised={
    $deadline=[DateTime]::UtcNow.AddSeconds(90)
    do{
      try{
        $current=Get-SupervisionProbe
        if([string]$current.supervisor_verdict -ceq 'SUPERVISED_AUTH0_VERIFIED'){
          Save-OrphanEvidence -Phase 'supervised' -Observation $null -Verdict 'SUPERVISED_AUTH0_VERIFIED'
          return
        }
      }catch{}
      Start-Sleep -Seconds 2
    }while([DateTime]::UtcNow -lt $deadline)
    throw 'Supervised Auth0 verification did not complete.'
  }
  RestoreEvidence={
    Save-OrphanEvidence -Phase 'restore-evidence' -Observation $script:recorded -Verdict 'preserve'
  }
  VerifyRollback={
    $listen=@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
    $task=Get-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    if($listen.Count -eq 0 -and [string]$task.State -ceq 'Ready'){
      Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    }
    $current=Get-SupervisionProbe
    Assert-Orphan ([string]$current.supervisor_verdict -ceq 'SUPERVISED_AUTH0_VERIFIED') 'Rollback could not independently prove SUPERVISED_AUTH0_VERIFIED.'
  }
}
$result=Invoke-GuardedLegacyOrphanHandover -Operations $ops
Assert-Orphan ($result -ceq 'supervised') 'Unexpected legacy-orphan handover result.'
Write-Output 'LEGACY ORPHAN HANDOVER ACTIVATED: identity-bound tree replaced by protected supervisor.'
Write-Output 'SUPERVISED_AUTH0_VERIFIED'
