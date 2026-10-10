<#
.SYNOPSIS
  Guarded installation, activation and rollback of the Vaulter Auth0 relay supervisor.
.DESCRIPTION
  Default is read-only. -Stage creates a NEW protected source/hash/task backup
  without touching the running service. -Apply switches only the pre-existing
  Tetherplane Relay task action during an authorized maintenance window, verifies
  new process ownership and Auth0 public health, and attempts independently
  verified rollback on any failure. -Rollback restores the exact old action.
  No bridge activation, OAuth cutover, secrets, Funnel changes or unrelated kills.
#>
[CmdletBinding(DefaultParameterSetName='Inspect')]
param(
  [Parameter(ParameterSetName='Stage')][switch]$Stage,
  [Parameter(ParameterSetName='Stage')][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSupervisorSha256,
  [Parameter(ParameterSetName='Apply')][switch]$Apply,
  [Parameter(ParameterSetName='Rollback')][switch]$Rollback
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$script:TaskName='Tetherplane Relay'
$script:StateDir=Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:StageDir=Join-Path $script:StateDir 'relay-supervisor'
$script:ProtectedBackupDir=Join-Path $script:StateDir 'relay-pre-bridge-b8afcfe768964e8786a5c229b866ea8d'
$script:SourceSupervisor=Join-Path $PSScriptRoot 'vaulter-relay-bounded-supervisor.ps1'
$script:InstalledSupervisor=Join-Path $script:StageDir 'vaulter-relay-bounded-supervisor.ps1'
$script:BeforeTaskXml=Join-Path $script:StageDir 'pre-supervisor-task.xml'
$script:ManifestPath=Join-Path $script:StageDir 'manifest.json'
$script:OriginalLauncherHash='5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8'
$script:AuthPid=0
$script:BaselineXml=''

function Assert-Handover([bool]$Ok,[string]$Reason){
  if(-not $Ok){throw $Reason}
}
function Test-TaskPrincipalIsCurrentUser {
  [CmdletBinding()]
  param(
    [AllowEmptyString()][string]$TaskUserId,
    [Security.Principal.SecurityIdentifier]$CurrentSid
  )
  if([string]::IsNullOrWhiteSpace($TaskUserId) -or $null -eq $CurrentSid){
    return $false
  }
  try{
    if($TaskUserId -match '^S-\d-\d+(?:-\d+)+
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$BeforeXml,
    [Parameter(Mandatory=$true)][string]$AfterXml)
  try {
    [xml]$before=$BeforeXml
    [xml]$after=$AfterXml
    $b=$before.SelectSingleNode("//*[local-name()='Actions']")
    $a=$after.SelectSingleNode("//*[local-name()='Actions']")
    if($null -eq $b -or $null -eq $a){return $false}
    $replacement=$after.ImportNode($b,$true)
    $null=$a.ParentNode.ReplaceChild($replacement,$a)
    return ($before.DocumentElement.OuterXml -ceq $after.DocumentElement.OuterXml)
  }catch{return $false}
}
function Test-ProtectedOriginalAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$SnapshotXml,
    [Parameter(Mandatory=$true)][string]$ProtectedBackupXml)
  try{
    [xml]$snapshot=$SnapshotXml
    [xml]$protected=$ProtectedBackupXml
    $current=$snapshot.SelectSingleNode("//*[local-name()='Actions']")
    $original=$protected.SelectSingleNode("//*[local-name()='Actions']")
    return ($null -ne $current -and $null -ne $original -and
      $current.OuterXml -ceq $original.OuterXml)
  }catch{return $false}
}
function Test-SupervisorParentChain {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)]$Node,
    [Parameter(Mandatory=$true)]$Parent,
    [Parameter(Mandatory=$true)]$Supervisor,
    [Parameter(Mandatory=$true)][string]$OriginalLauncherPath,
    [Parameter(Mandatory=$true)][string]$InstalledSupervisorPath
  )
  try{
    return (
      [string]$Node.Name -ieq 'node.exe' -and
      [string]$Parent.Name -ieq 'powershell.exe' -and
      [string]$Supervisor.Name -ieq 'powershell.exe' -and
      [int]$Node.ParentProcessId -eq [int]$Parent.ProcessId -and
      [int]$Parent.ParentProcessId -eq [int]$Supervisor.ProcessId -and
      ([string]$Parent.CommandLine).IndexOf($OriginalLauncherPath,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      ([string]$Supervisor.CommandLine).IndexOf($InstalledSupervisorPath,[StringComparison]::OrdinalIgnoreCase) -ge 0
    )
  }catch{return $false}
}
function Invoke-GuardedSupervisorHandover {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][hashtable]$Operations)
  foreach($step in @('VerifyBefore','StopOriginal','VerifyVacant','ApplyAction',
    'StartSupervisor','VerifySupervisor','RestoreOriginal','StartOriginal','VerifyOriginal')){
    if(-not $Operations.ContainsKey($step) -or $Operations[$step] -isnot [scriptblock]){
      throw 'Missing supervisor handover transaction operation.'
    }
  }
  & $Operations['VerifyBefore']
  try{
    & $Operations['StopOriginal']
    & $Operations['VerifyVacant']
    & $Operations['ApplyAction']
    & $Operations['StartSupervisor']
    & $Operations['VerifySupervisor']
    return 'activated'
  }catch{
    # Never report activation after an unsuccessful health or action-only gate.
    try{
      & $Operations['RestoreOriginal']
      & $Operations['StartOriginal']
      & $Operations['VerifyOriginal']
    }catch{
      throw 'SUPERVISOR HANDOVER ROLLBACK UNVERIFIED. Do not repeat, reboot, or alter other tasks. Inspect private backup and current listener.'
    }
    throw 'SUPERVISOR HANDOVER FAILED; ORIGINAL AUTH0 RELAY ROLLED BACK AND VERIFIED.'
  }
}
function Get-Task {
  Get-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
}
function Get-TaskXml {
  [string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop)
}
function Assert-RegisteredTask {
  $t=Get-Task
  Assert-Handover ([bool]$t.Settings.Enabled -and
    [string]$t.Principal.LogonType -ceq 'Interactive' -and
    [string]$t.Settings.MultipleInstances -ceq 'IgnoreNew' -and
    [int]$t.Settings.RestartCount -eq 10 -and
    [string]$t.Settings.RestartInterval -ceq 'PT1M' -and
    @($t.Actions).Count -eq 1) 'Relay task registration differs from approved baseline.'
  Assert-Handover (@($t.Triggers|Where-Object{
    $_.CimClass.CimClassName -match 'LogonTrigger
}
function Read-TaskResultSafely {
  $info=Get-ScheduledTaskInfo -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
  # LastTaskResult describes the latest instance, not successful recovery.
  return ('0x{0:X8}' -f ([uint32]([long]$info.LastTaskResult -band 4294967295)))
}
function Assert-PrivateBaseline {
  Assert-Handover ($env:COMPUTERNAME -ieq 'Vaulter' -and $env:OS -eq 'Windows_NT') 'Vaulter-only handover.'
  foreach($p in @($script:StateDir,$script:ProtectedBackupDir)){
    Assert-Handover (Test-Path -LiteralPath $p -PathType Container) 'Protected state or baseline checkpoint missing.'
    Assert-Handover ((Get-Acl -LiteralPath $p).AreAccessRulesProtected) 'Protected state ACL no longer isolated.'
  }
  $copy=Join-Path $script:ProtectedBackupDir 'launcher.ps1'
  Assert-Handover ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Protected rollback launcher digest mismatch.'
  $null=Assert-RegisteredTask
}
function Get-OriginalAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Xml)
  [xml]$x=$Xml
  $items=@($x.SelectNodes("//*[local-name()='Actions']/*"))
  Assert-Handover ($items.Count -eq 1 -and $items[0].LocalName -ceq 'Exec') 'Original action shape changed.'
  $cmd=$items[0].SelectSingleNode("*[local-name()='Command']")
  $args=$items[0].SelectSingleNode("*[local-name()='Arguments']")
  $cwd=$items[0].SelectSingleNode("*[local-name()='WorkingDirectory']")
  Assert-Handover ($null -ne $cmd -and $null -ne $args) 'Original action command or arguments missing.'
  $exe=[string]$cmd.InnerText
  $arguments=[string]$args.InnerText
  Assert-Handover ([IO.Path]::IsPathRooted($exe) -and
    [IO.Path]::GetFileName($exe) -ieq 'powershell.exe' -and
    $arguments -match '(?i)(?:^|\s)-File(?=\s)') 'Original task must execute a trusted PowerShell launcher.'
  return [pscustomobject]@{
    Executable=$exe
    Arguments=$arguments
    WorkingDirectory=if($null -ne $cwd){[string]$cwd.InnerText}else{''}
  }
}
function New-ExactAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$Arguments,
    [string]$WorkingDirectory='')
  if(-not [string]::IsNullOrWhiteSpace($WorkingDirectory)){
    return (New-ScheduledTaskAction -Execute $Executable -Argument $Arguments -WorkingDirectory $WorkingDirectory)
  }
  return (New-ScheduledTaskAction -Execute $Executable -Argument $Arguments)
}
function Assert-Auth0Baseline {
  $relay=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 10 -ErrorAction Stop
  $auth=Invoke-RestMethod -Uri 'http://127.0.0.1:8790/healthz' -TimeoutSec 10 -ErrorAction Stop
  $metadata=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/.well-known/oauth-protected-resource/mcp' -TimeoutSec 15 -ErrorAction Stop
  $public=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/healthz' -TimeoutSec 15 -ErrorAction Stop
  Assert-Handover ($relay.status -ceq 'ok' -and $auth.status -ceq 'ok' -and
    $public.status -ceq 'ok' -and
    @($metadata.authorization_servers).Count -eq 1 -and
    @($metadata.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Original Auth0 and public relay health not verified.'
  $authConnections=@(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)
  Assert-Handover ($authConnections.Count -eq 1 -and
    $authConnections[0].LocalAddress -ceq '127.0.0.1') 'Protected auth loopback listener changed.'
  if($script:AuthPid -gt 0){
    Assert-Handover ([int]$authConnections[0].OwningProcess -eq $script:AuthPid) 'Self-hosted auth server identity changed.'
  }else{$script:AuthPid=[int]$authConnections[0].OwningProcess}
}
function Assert-HealthyListener([switch]$Supervised){
  $listeners=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
  Assert-Handover ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') 'No exclusive loopback relay.'
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop
  Assert-Handover ($null -ne $node -and $node.Name -ieq 'node.exe') 'Relay listener is not Node.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $parent -and $parent.Name -ieq 'powershell.exe') 'Node parent is not PowerShell.'
  $original=Get-OriginalAction -Xml $script:BaselineXml
  $fileMatch=[regex]::Match($original.Arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Handover ($fileMatch.Success) 'Original launcher path unknown.'
  $runner=@($fileMatch.Groups[1].Value,$fileMatch.Groups[2].Value,$fileMatch.Groups[3].Value) |
    Where-Object {$_} | Select-Object -First 1
  Assert-Handover ((Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Live original launcher hash changed.'
  Assert-Handover ([string]$parent.CommandLine -like ('*'+$runner+'*')) 'Relay Node not owned by original launch command.'
  if($Supervised){
    $grandparent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId) -ErrorAction Stop
    Assert-Handover ($null -ne $grandparent -and
      (Test-SupervisorParentChain -Node $node -Parent $parent -Supervisor $grandparent -OriginalLauncherPath ([string]$runner) -InstalledSupervisorPath $script:InstalledSupervisor)) 'Active relay process not descended from registered protected supervisor.'
  }
  Assert-Auth0Baseline
}
function Wait-TaskReadyVacant {
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  while([DateTime]::UtcNow -lt $deadline){
    $task=Get-Task
    $listen=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
    if($task.State -eq 'Ready' -and $listen.Count -eq 0){return}
    Start-Sleep -Milliseconds 400
  }
  throw 'Relay task not Ready with empty port; ambiguous process ownership; no action replacement.'
}
function Assert-StagedFiles {
  Assert-Handover (Test-Path -LiteralPath $script:StageDir -PathType Container) 'Supervisor staging not present.'
  Assert-Handover ((Get-Acl -LiteralPath $script:StageDir).AreAccessRulesProtected) 'Supervisor staging ACL not protected.'
  foreach($p in @($script:InstalledSupervisor,$script:BeforeTaskXml,$script:ManifestPath)){
    Assert-Handover (Test-Path -LiteralPath $p -PathType Leaf) 'Supervisor staged file missing.'
    Assert-Handover (-not ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Supervisor staged reparse point refused.'
  }
  $manifest=Get-Content -LiteralPath $script:ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  Assert-Handover ([string]$manifest.SourceSha256 -match '^[0-9A-F]{64}$' -and
    (Get-FileHash -LiteralPath $script:InstalledSupervisor -Algorithm SHA256).Hash -ceq [string]$manifest.SourceSha256 -and
    (Get-FileHash -LiteralPath $script:BeforeTaskXml -Algorithm SHA256).Hash -ceq [string]$manifest.TaskSha256) 'Supervisor installation or private task backup hash mismatch.'
  return [IO.File]::ReadAllText($script:BeforeTaskXml)
}
function Assert-ProtectedOriginalAction {
  $protected=Join-Path $script:ProtectedBackupDir 'relay-task.xml'
  Assert-Handover (Test-Path -LiteralPath $protected -PathType Leaf) 'Protected pre-bridge original task snapshot missing.'
  Assert-Handover (-not ((Get-Item -LiteralPath $protected -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Protected original task XML reparse point refused.'
  Assert-Handover (
    (Test-ProtectedOriginalAction -SnapshotXml $script:BaselineXml -ProtectedBackupXml ([IO.File]::ReadAllText($protected)))
  ) 'Original action differs from protected pre-bridge checkpoint.'
}
function Assert-SupervisorProcessOwnedWithoutHealth {
  $listeners=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
  if($listeners.Count -eq 0){return}
  Assert-Handover ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') 'Unrecognized port binding; task stop refused.'
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop
  Assert-Handover ($null -ne $node -and $node.Name -ieq 'node.exe') 'Unrecognized relay listener process; task stop refused.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $parent) 'Relay launcher parent missing; task stop refused.'
  $supervisor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $supervisor) 'Supervisor parent missing; task stop refused.'
  $expectedLauncher=Get-OriginalAction -Xml $script:BaselineXml
  $m=[regex]::Match($expectedLauncher.Arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Handover ($m.Success) 'Original runner path unavailable for verified task stop.'
  $runner=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value) |
    Where-Object {$_} | Select-Object -First 1
  Assert-Handover (
    (Test-SupervisorParentChain -Node $node -Parent $parent -Supervisor $supervisor -OriginalLauncherPath ([string]$runner) -InstalledSupervisorPath $script:InstalledSupervisor)
  ) 'Relay listener process is not proven task-supervisor-owned; task stop refused.'
}
function Test-TaskIsOriginal {
  $task=Get-Task
  $before=Get-OriginalAction -Xml $script:BaselineXml
  return (@($task.Actions).Count -eq 1 -and
    [string]$task.Actions[0].Execute -ieq $before.Executable -and
    [string]$task.Actions[0].Arguments -ceq $before.Arguments -and
    [string]$task.Actions[0].WorkingDirectory -ceq $before.WorkingDirectory)
}
function Test-TaskIsSupervisor {
  $t=Get-Task
  $original=Get-OriginalAction -Xml $script:BaselineXml
  return (@($t.Actions).Count -eq 1 -and
    [string]$t.Actions[0].Execute -ieq $original.Executable -and
    [string]$t.Actions[0].Arguments -ceq
      ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:InstalledSupervisor+'" -Serve') -and
    [string]$t.Actions[0].WorkingDirectory -ceq $original.WorkingDirectory)
}
function Set-OnlyRelayAction([switch]$ToSupervisor){
  $original=Get-OriginalAction -Xml $script:BaselineXml
  $args=if($ToSupervisor){
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:InstalledSupervisor+'" -Serve'
  }else{$original.Arguments}
  $new=New-ExactAction -Executable $original.Executable -Arguments $args -WorkingDirectory $original.WorkingDirectory
  Set-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -Action $new -ErrorAction Stop | Out-Null
  Assert-Handover (Test-OnlyTaskActionChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Handover altered task XML outside its action.'
  $null=Assert-RegisteredTask
}
function Wait-Healthy([switch]$Supervised){
  $deadline=[DateTime]::UtcNow.AddSeconds(90)
  while([DateTime]::UtcNow -lt $deadline){
    try{
      $task=Get-Task
      if($task.State -eq 'Running'){
        Assert-HealthyListener -Supervised:$Supervised
        return
      }
    }catch{}
    Start-Sleep -Seconds 2
  }
  throw 'Relay did not reach independently healthy original/owned supervised state.'
}
function Restore-OriginalSafely {
  # Called only after baseline proof. Never terminate a non-task-owned listener.
  if(Test-TaskIsSupervisor){
    $current=Get-Task
    if($current.State -eq 'Running'){
      # After handover, the only permitted running instance is verified
      # via the exact grandparent supervisor chain.
      Assert-SupervisorProcessOwnedWithoutHealth
      Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
      Wait-TaskReadyVacant
    }else{
      Assert-Handover ($current.State -eq 'Ready') 'Unexpected task state; rollback cannot safely stop it.'
      Assert-Handover (@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Ambiguous live listener during rollback.'
    }
    Set-OnlyRelayAction
  }elseif(-not(Test-TaskIsOriginal)){
    throw 'Task action differs from both known supervised and original actions; rollback refused.'
  }
}
function Start-OriginalSafely {
  $t=Get-Task
  Assert-Handover (Test-TaskIsOriginal) 'Original task action not restored.'
  if($t.State -eq 'Running'){
    Assert-HealthyListener
    return
  }
  Assert-Handover ($t.State -eq 'Ready') 'Original task unavailable for restart.'
  Assert-Handover (@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Original task restart refused due to occupied port.'
  Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
}

Assert-PrivateBaseline
$task=Get-Task
if(-not $Stage -and -not $Apply -and -not $Rollback){
  Assert-Handover ($task.State -eq 'Running') 'Current relay task not running.'
  $script:BaselineXml=Get-TaskXml
  Assert-ProtectedOriginalAction
  Assert-Handover (Test-TaskIsOriginal) 'Read-only preflight expects original registered launcher.'
  Assert-HealthyListener
  Write-Output 'RELAY SUPERVISOR HANDOVER PREFLIGHT PASS: original Auth0 task running, listener ownership verified.'
  Write-Output ('Current task LastTaskResult='+[string](Read-TaskResultSafely)+' (not recovery proof).')
  Write-Output 'NO CHANGES MADE. -Stage, -Apply or -Rollback require explicit separate execution.'
  return
}
if($Stage){
  Assert-Handover ($task.State -eq 'Running' -and (Test-Path -LiteralPath $script:SourceSupervisor -PathType Leaf)) 'Source or running original relay unavailable.'
  Assert-Handover (-not(Test-Path -LiteralPath $script:StageDir)) 'Supervisor stage exists already; do not overwrite the backup.'
  Assert-Handover (-not [string]::IsNullOrWhiteSpace($ExpectedSupervisorSha256)) 'Pinned supervisor source hash required.'
  Assert-Handover ((Get-FileHash -LiteralPath $script:SourceSupervisor -Algorithm SHA256).Hash -ceq
    $ExpectedSupervisorSha256.ToUpperInvariant()) 'Source supervisor digest differs from reviewed revision.'
  $script:BaselineXml=Get-TaskXml
  Assert-ProtectedOriginalAction
  Assert-Handover (Test-TaskIsOriginal) 'Original task action does not match private baseline.'
  Assert-HealthyListener
  New-Item -ItemType Directory -Path $script:StageDir -ErrorAction Stop | Out-Null
  $acl=Get-Acl -LiteralPath $script:StageDir -ErrorAction Stop
  $acl.SetAccessRuleProtection($true,$true)
  Set-Acl -LiteralPath $script:StageDir -AclObject $acl -ErrorAction Stop
  Assert-Handover ((Get-Acl -LiteralPath $script:StageDir).AreAccessRulesProtected) 'Protected supervisor staging ACL could not be applied.'
  Copy-Item -LiteralPath $script:SourceSupervisor -Destination $script:InstalledSupervisor -ErrorAction Stop
  [IO.File]::WriteAllText($script:BeforeTaskXml,$script:BaselineXml,[Text.UTF8Encoding]::new($false))
  $manifest=[pscustomobject]@{
    SourceSha256=$ExpectedSupervisorSha256.ToUpperInvariant()
    TaskSha256=(Get-FileHash -LiteralPath $script:BeforeTaskXml -Algorithm SHA256).Hash
  }|ConvertTo-Json -Compress
  [IO.File]::WriteAllText($script:ManifestPath,$manifest,[Text.UTF8Encoding]::new($false))
  $null=Assert-StagedFiles
  Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Task changed during staging.'
  Assert-HealthyListener
  Write-Output 'RELAY SUPERVISOR PROTECTED STAGING VERIFIED: original task untouched, source and rollback hashes persisted.'
  return
}

$script:BaselineXml=Assert-StagedFiles
Assert-ProtectedOriginalAction
Assert-Handover (Test-OnlyTaskActionChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Unexpected task settings, principal or triggers drift.'
if($Apply){
  Assert-Handover ($task.State -eq 'Running' -and (Test-TaskIsOriginal) -and
    (Get-TaskXml) -ceq $script:BaselineXml) 'Apply requires identical original task snapshot.'
  Assert-HealthyListener
  $ops=@{
    VerifyBefore={
      Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml -and
        (Test-TaskIsOriginal)) 'Concurrent registration modification; handover refused.'
      Assert-HealthyListener
    }
    StopOriginal={
      Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    }
    VerifyVacant={Wait-TaskReadyVacant}
    ApplyAction={Set-OnlyRelayAction -ToSupervisor}
    StartSupervisor={
      Assert-Handover (Test-TaskIsSupervisor) 'Supervisor task action not registered.'
      Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    }
    VerifySupervisor={
      Assert-Handover (Test-TaskIsSupervisor) 'Unexpected relay task action after activation.'
      Wait-Healthy -Supervised
    }
    RestoreOriginal={Restore-OriginalSafely}
    StartOriginal={Start-OriginalSafely}
    VerifyOriginal={
      Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Original task XML not restored.'
      Wait-Healthy
    }
  }
  $result=Invoke-GuardedSupervisorHandover -Operations $ops
  Assert-Handover ($result -ceq 'activated') 'Unexpected handover result.'
  Write-Output 'RELAY SUPERVISOR ACTIVATED: original Auth0 relay task, protected supervisor parent and public/local health verified.'
  Write-Output 'AUTOMATIC RECOVERY STILL UNVERIFIED until a separately approved logged fault rehearsal.'
  return
}

if($Rollback){
  Assert-Handover (Test-TaskIsSupervisor -or (Test-TaskIsOriginal)) 'Registered action does not match either reviewed configuration.'
  Restore-OriginalSafely
  Start-OriginalSafely
  Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Original task registration not restored exactly.'
  Wait-Healthy
  Write-Output 'RELAY SUPERVISOR ROLLBACK VERIFIED: original task restored, unchanged Auth0 health.'
  return
}
throw 'Unknown relay supervisor handover mode.'
){
      $resolved=[Security.Principal.SecurityIdentifier]::new($TaskUserId)
    }else{
      $name=[Security.Principal.NTAccount]::new($TaskUserId)
      $resolved=$name.Translate([Security.Principal.SecurityIdentifier])
    }
    return ([string]$resolved.Value -ceq [string]$CurrentSid.Value)
  }catch{return $false}
}
function Test-OnlyTaskActionChanged {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$BeforeXml,
    [Parameter(Mandatory=$true)][string]$AfterXml)
  try {
    [xml]$before=$BeforeXml
    [xml]$after=$AfterXml
    $b=$before.SelectSingleNode("//*[local-name()='Actions']")
    $a=$after.SelectSingleNode("//*[local-name()='Actions']")
    if($null -eq $b -or $null -eq $a){return $false}
    $replacement=$after.ImportNode($b,$true)
    $null=$a.ParentNode.ReplaceChild($replacement,$a)
    return ($before.DocumentElement.OuterXml -ceq $after.DocumentElement.OuterXml)
  }catch{return $false}
}
function Test-ProtectedOriginalAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$SnapshotXml,
    [Parameter(Mandatory=$true)][string]$ProtectedBackupXml)
  try{
    [xml]$snapshot=$SnapshotXml
    [xml]$protected=$ProtectedBackupXml
    $current=$snapshot.SelectSingleNode("//*[local-name()='Actions']")
    $original=$protected.SelectSingleNode("//*[local-name()='Actions']")
    return ($null -ne $current -and $null -ne $original -and
      $current.OuterXml -ceq $original.OuterXml)
  }catch{return $false}
}
function Test-SupervisorParentChain {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)]$Node,
    [Parameter(Mandatory=$true)]$Parent,
    [Parameter(Mandatory=$true)]$Supervisor,
    [Parameter(Mandatory=$true)][string]$OriginalLauncherPath,
    [Parameter(Mandatory=$true)][string]$InstalledSupervisorPath
  )
  try{
    return (
      [string]$Node.Name -ieq 'node.exe' -and
      [string]$Parent.Name -ieq 'powershell.exe' -and
      [string]$Supervisor.Name -ieq 'powershell.exe' -and
      [int]$Node.ParentProcessId -eq [int]$Parent.ProcessId -and
      [int]$Parent.ParentProcessId -eq [int]$Supervisor.ProcessId -and
      ([string]$Parent.CommandLine).IndexOf($OriginalLauncherPath,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      ([string]$Supervisor.CommandLine).IndexOf($InstalledSupervisorPath,[StringComparison]::OrdinalIgnoreCase) -ge 0
    )
  }catch{return $false}
}
function Invoke-GuardedSupervisorHandover {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][hashtable]$Operations)
  foreach($step in @('VerifyBefore','StopOriginal','VerifyVacant','ApplyAction',
    'StartSupervisor','VerifySupervisor','RestoreOriginal','StartOriginal','VerifyOriginal')){
    if(-not $Operations.ContainsKey($step) -or $Operations[$step] -isnot [scriptblock]){
      throw 'Missing supervisor handover transaction operation.'
    }
  }
  & $Operations['VerifyBefore']
  try{
    & $Operations['StopOriginal']
    & $Operations['VerifyVacant']
    & $Operations['ApplyAction']
    & $Operations['StartSupervisor']
    & $Operations['VerifySupervisor']
    return 'activated'
  }catch{
    # Never report activation after an unsuccessful health or action-only gate.
    try{
      & $Operations['RestoreOriginal']
      & $Operations['StartOriginal']
      & $Operations['VerifyOriginal']
    }catch{
      throw 'SUPERVISOR HANDOVER ROLLBACK UNVERIFIED. Do not repeat, reboot, or alter other tasks. Inspect private backup and current listener.'
    }
    throw 'SUPERVISOR HANDOVER FAILED; ORIGINAL AUTH0 RELAY ROLLED BACK AND VERIFIED.'
  }
}
function Get-Task {
  Get-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
}
function Get-TaskXml {
  [string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop)
}
function Assert-RegisteredTask {
  $t=Get-Task
  Assert-Handover ([bool]$t.Settings.Enabled -and
    [string]$t.Principal.LogonType -ceq 'Interactive' -and
    [string]$t.Settings.MultipleInstances -ceq 'IgnoreNew' -and
    [int]$t.Settings.RestartCount -eq 10 -and
    [string]$t.Settings.RestartInterval -ceq 'PT1M' -and
    @($t.Actions).Count -eq 1) 'Relay task registration differs from approved baseline.'
  Assert-Handover (@($t.Triggers|Where-Object{
    $_.CimClass.CimClassName -match 'LogonTrigger$'
  }).Count -gt 0) 'Expected Interactive relay task logon trigger missing.'
  return $t
}
function Read-TaskResultSafely {
  $info=Get-ScheduledTaskInfo -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
  # LastTaskResult describes the latest instance, not successful recovery.
  return ('0x{0:X8}' -f ([uint32]([long]$info.LastTaskResult -band 4294967295)))
}
function Assert-PrivateBaseline {
  Assert-Handover ($env:COMPUTERNAME -ieq 'Vaulter' -and $env:OS -eq 'Windows_NT') 'Vaulter-only handover.'
  foreach($p in @($script:StateDir,$script:ProtectedBackupDir)){
    Assert-Handover (Test-Path -LiteralPath $p -PathType Container) 'Protected state or baseline checkpoint missing.'
    Assert-Handover ((Get-Acl -LiteralPath $p).AreAccessRulesProtected) 'Protected state ACL no longer isolated.'
  }
  $copy=Join-Path $script:ProtectedBackupDir 'launcher.ps1'
  Assert-Handover ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Protected rollback launcher digest mismatch.'
  $null=Assert-RegisteredTask
}
function Get-OriginalAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Xml)
  [xml]$x=$Xml
  $items=@($x.SelectNodes("//*[local-name()='Actions']/*"))
  Assert-Handover ($items.Count -eq 1 -and $items[0].LocalName -ceq 'Exec') 'Original action shape changed.'
  $cmd=$items[0].SelectSingleNode("*[local-name()='Command']")
  $args=$items[0].SelectSingleNode("*[local-name()='Arguments']")
  $cwd=$items[0].SelectSingleNode("*[local-name()='WorkingDirectory']")
  Assert-Handover ($null -ne $cmd -and $null -ne $args) 'Original action command or arguments missing.'
  $exe=[string]$cmd.InnerText
  $arguments=[string]$args.InnerText
  Assert-Handover ([IO.Path]::IsPathRooted($exe) -and
    [IO.Path]::GetFileName($exe) -ieq 'powershell.exe' -and
    $arguments -match '(?i)(?:^|\s)-File(?=\s)') 'Original task must execute a trusted PowerShell launcher.'
  return [pscustomobject]@{
    Executable=$exe
    Arguments=$arguments
    WorkingDirectory=if($null -ne $cwd){[string]$cwd.InnerText}else{''}
  }
}
function New-ExactAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$Arguments,
    [string]$WorkingDirectory='')
  if(-not [string]::IsNullOrWhiteSpace($WorkingDirectory)){
    return (New-ScheduledTaskAction -Execute $Executable -Argument $Arguments -WorkingDirectory $WorkingDirectory)
  }
  return (New-ScheduledTaskAction -Execute $Executable -Argument $Arguments)
}
function Assert-Auth0Baseline {
  $relay=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 10 -ErrorAction Stop
  $auth=Invoke-RestMethod -Uri 'http://127.0.0.1:8790/healthz' -TimeoutSec 10 -ErrorAction Stop
  $metadata=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/.well-known/oauth-protected-resource/mcp' -TimeoutSec 15 -ErrorAction Stop
  $public=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/healthz' -TimeoutSec 15 -ErrorAction Stop
  Assert-Handover ($relay.status -ceq 'ok' -and $auth.status -ceq 'ok' -and
    $public.status -ceq 'ok' -and
    @($metadata.authorization_servers).Count -eq 1 -and
    @($metadata.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Original Auth0 and public relay health not verified.'
  $authConnections=@(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)
  Assert-Handover ($authConnections.Count -eq 1 -and
    $authConnections[0].LocalAddress -ceq '127.0.0.1') 'Protected auth loopback listener changed.'
  if($script:AuthPid -gt 0){
    Assert-Handover ([int]$authConnections[0].OwningProcess -eq $script:AuthPid) 'Self-hosted auth server identity changed.'
  }else{$script:AuthPid=[int]$authConnections[0].OwningProcess}
}
function Assert-HealthyListener([switch]$Supervised){
  $listeners=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
  Assert-Handover ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') 'No exclusive loopback relay.'
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop
  Assert-Handover ($null -ne $node -and $node.Name -ieq 'node.exe') 'Relay listener is not Node.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $parent -and $parent.Name -ieq 'powershell.exe') 'Node parent is not PowerShell.'
  $original=Get-OriginalAction -Xml $script:BaselineXml
  $fileMatch=[regex]::Match($original.Arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Handover ($fileMatch.Success) 'Original launcher path unknown.'
  $runner=@($fileMatch.Groups[1].Value,$fileMatch.Groups[2].Value,$fileMatch.Groups[3].Value) |
    Where-Object {$_} | Select-Object -First 1
  Assert-Handover ((Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Live original launcher hash changed.'
  Assert-Handover ([string]$parent.CommandLine -like ('*'+$runner+'*')) 'Relay Node not owned by original launch command.'
  if($Supervised){
    $grandparent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId) -ErrorAction Stop
    Assert-Handover ($null -ne $grandparent -and
      (Test-SupervisorParentChain -Node $node -Parent $parent -Supervisor $grandparent -OriginalLauncherPath ([string]$runner) -InstalledSupervisorPath $script:InstalledSupervisor)) 'Active relay process not descended from registered protected supervisor.'
  }
  Assert-Auth0Baseline
}
function Wait-TaskReadyVacant {
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  while([DateTime]::UtcNow -lt $deadline){
    $task=Get-Task
    $listen=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
    if($task.State -eq 'Ready' -and $listen.Count -eq 0){return}
    Start-Sleep -Milliseconds 400
  }
  throw 'Relay task not Ready with empty port; ambiguous process ownership; no action replacement.'
}
function Assert-StagedFiles {
  Assert-Handover (Test-Path -LiteralPath $script:StageDir -PathType Container) 'Supervisor staging not present.'
  Assert-Handover ((Get-Acl -LiteralPath $script:StageDir).AreAccessRulesProtected) 'Supervisor staging ACL not protected.'
  foreach($p in @($script:InstalledSupervisor,$script:BeforeTaskXml,$script:ManifestPath)){
    Assert-Handover (Test-Path -LiteralPath $p -PathType Leaf) 'Supervisor staged file missing.'
    Assert-Handover (-not ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Supervisor staged reparse point refused.'
  }
  $manifest=Get-Content -LiteralPath $script:ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  Assert-Handover ([string]$manifest.SourceSha256 -match '^[0-9A-F]{64}$' -and
    (Get-FileHash -LiteralPath $script:InstalledSupervisor -Algorithm SHA256).Hash -ceq [string]$manifest.SourceSha256 -and
    (Get-FileHash -LiteralPath $script:BeforeTaskXml -Algorithm SHA256).Hash -ceq [string]$manifest.TaskSha256) 'Supervisor installation or private task backup hash mismatch.'
  return [IO.File]::ReadAllText($script:BeforeTaskXml)
}
function Assert-ProtectedOriginalAction {
  $protected=Join-Path $script:ProtectedBackupDir 'relay-task.xml'
  Assert-Handover (Test-Path -LiteralPath $protected -PathType Leaf) 'Protected pre-bridge original task snapshot missing.'
  Assert-Handover (-not ((Get-Item -LiteralPath $protected -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Protected original task XML reparse point refused.'
  Assert-Handover (
    (Test-ProtectedOriginalAction -SnapshotXml $script:BaselineXml -ProtectedBackupXml ([IO.File]::ReadAllText($protected)))
  ) 'Original action differs from protected pre-bridge checkpoint.'
}
function Assert-SupervisorProcessOwnedWithoutHealth {
  $listeners=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
  if($listeners.Count -eq 0){return}
  Assert-Handover ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') 'Unrecognized port binding; task stop refused.'
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop
  Assert-Handover ($null -ne $node -and $node.Name -ieq 'node.exe') 'Unrecognized relay listener process; task stop refused.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $parent) 'Relay launcher parent missing; task stop refused.'
  $supervisor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $supervisor) 'Supervisor parent missing; task stop refused.'
  $expectedLauncher=Get-OriginalAction -Xml $script:BaselineXml
  $m=[regex]::Match($expectedLauncher.Arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Handover ($m.Success) 'Original runner path unavailable for verified task stop.'
  $runner=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value) |
    Where-Object {$_} | Select-Object -First 1
  Assert-Handover (
    (Test-SupervisorParentChain -Node $node -Parent $parent -Supervisor $supervisor -OriginalLauncherPath ([string]$runner) -InstalledSupervisorPath $script:InstalledSupervisor)
  ) 'Relay listener process is not proven task-supervisor-owned; task stop refused.'
}
function Test-TaskIsOriginal {
  $task=Get-Task
  $before=Get-OriginalAction -Xml $script:BaselineXml
  return (@($task.Actions).Count -eq 1 -and
    [string]$task.Actions[0].Execute -ieq $before.Executable -and
    [string]$task.Actions[0].Arguments -ceq $before.Arguments -and
    [string]$task.Actions[0].WorkingDirectory -ceq $before.WorkingDirectory)
}
function Test-TaskIsSupervisor {
  $t=Get-Task
  $original=Get-OriginalAction -Xml $script:BaselineXml
  return (@($t.Actions).Count -eq 1 -and
    [string]$t.Actions[0].Execute -ieq $original.Executable -and
    [string]$t.Actions[0].Arguments -ceq
      ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:InstalledSupervisor+'" -Serve') -and
    [string]$t.Actions[0].WorkingDirectory -ceq $original.WorkingDirectory)
}
function Set-OnlyRelayAction([switch]$ToSupervisor){
  $original=Get-OriginalAction -Xml $script:BaselineXml
  $args=if($ToSupervisor){
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:InstalledSupervisor+'" -Serve'
  }else{$original.Arguments}
  $new=New-ExactAction -Executable $original.Executable -Arguments $args -WorkingDirectory $original.WorkingDirectory
  Set-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -Action $new -ErrorAction Stop | Out-Null
  Assert-Handover (Test-OnlyTaskActionChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Handover altered task XML outside its action.'
  $null=Assert-RegisteredTask
}
function Wait-Healthy([switch]$Supervised){
  $deadline=[DateTime]::UtcNow.AddSeconds(90)
  while([DateTime]::UtcNow -lt $deadline){
    try{
      $task=Get-Task
      if($task.State -eq 'Running'){
        Assert-HealthyListener -Supervised:$Supervised
        return
      }
    }catch{}
    Start-Sleep -Seconds 2
  }
  throw 'Relay did not reach independently healthy original/owned supervised state.'
}
function Restore-OriginalSafely {
  # Called only after baseline proof. Never terminate a non-task-owned listener.
  if(Test-TaskIsSupervisor){
    $current=Get-Task
    if($current.State -eq 'Running'){
      # After handover, the only permitted running instance is verified
      # via the exact grandparent supervisor chain.
      Assert-SupervisorProcessOwnedWithoutHealth
      Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
      Wait-TaskReadyVacant
    }else{
      Assert-Handover ($current.State -eq 'Ready') 'Unexpected task state; rollback cannot safely stop it.'
      Assert-Handover (@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Ambiguous live listener during rollback.'
    }
    Set-OnlyRelayAction
  }elseif(-not(Test-TaskIsOriginal)){
    throw 'Task action differs from both known supervised and original actions; rollback refused.'
  }
}
function Start-OriginalSafely {
  $t=Get-Task
  Assert-Handover (Test-TaskIsOriginal) 'Original task action not restored.'
  if($t.State -eq 'Running'){
    Assert-HealthyListener
    return
  }
  Assert-Handover ($t.State -eq 'Ready') 'Original task unavailable for restart.'
  Assert-Handover (@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Original task restart refused due to occupied port.'
  Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
}

Assert-PrivateBaseline
$task=Get-Task
if(-not $Stage -and -not $Apply -and -not $Rollback){
  Assert-Handover ($task.State -eq 'Running') 'Current relay task not running.'
  $script:BaselineXml=Get-TaskXml
  Assert-ProtectedOriginalAction
  Assert-Handover (Test-TaskIsOriginal) 'Read-only preflight expects original registered launcher.'
  Assert-HealthyListener
  Write-Output 'RELAY SUPERVISOR HANDOVER PREFLIGHT PASS: original Auth0 task running, listener ownership verified.'
  Write-Output ('Current task LastTaskResult='+[string](Read-TaskResultSafely)+' (not recovery proof).')
  Write-Output 'NO CHANGES MADE. -Stage, -Apply or -Rollback require explicit separate execution.'
  return
}
if($Stage){
  Assert-Handover ($task.State -eq 'Running' -and (Test-Path -LiteralPath $script:SourceSupervisor -PathType Leaf)) 'Source or running original relay unavailable.'
  Assert-Handover (-not(Test-Path -LiteralPath $script:StageDir)) 'Supervisor stage exists already; do not overwrite the backup.'
  Assert-Handover (-not [string]::IsNullOrWhiteSpace($ExpectedSupervisorSha256)) 'Pinned supervisor source hash required.'
  Assert-Handover ((Get-FileHash -LiteralPath $script:SourceSupervisor -Algorithm SHA256).Hash -ceq
    $ExpectedSupervisorSha256.ToUpperInvariant()) 'Source supervisor digest differs from reviewed revision.'
  $script:BaselineXml=Get-TaskXml
  Assert-ProtectedOriginalAction
  Assert-Handover (Test-TaskIsOriginal) 'Original task action does not match private baseline.'
  Assert-HealthyListener
  New-Item -ItemType Directory -Path $script:StageDir -ErrorAction Stop | Out-Null
  $acl=Get-Acl -LiteralPath $script:StageDir -ErrorAction Stop
  $acl.SetAccessRuleProtection($true,$true)
  Set-Acl -LiteralPath $script:StageDir -AclObject $acl -ErrorAction Stop
  Assert-Handover ((Get-Acl -LiteralPath $script:StageDir).AreAccessRulesProtected) 'Protected supervisor staging ACL could not be applied.'
  Copy-Item -LiteralPath $script:SourceSupervisor -Destination $script:InstalledSupervisor -ErrorAction Stop
  [IO.File]::WriteAllText($script:BeforeTaskXml,$script:BaselineXml,[Text.UTF8Encoding]::new($false))
  $manifest=[pscustomobject]@{
    SourceSha256=$ExpectedSupervisorSha256.ToUpperInvariant()
    TaskSha256=(Get-FileHash -LiteralPath $script:BeforeTaskXml -Algorithm SHA256).Hash
  }|ConvertTo-Json -Compress
  [IO.File]::WriteAllText($script:ManifestPath,$manifest,[Text.UTF8Encoding]::new($false))
  $null=Assert-StagedFiles
  Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Task changed during staging.'
  Assert-HealthyListener
  Write-Output 'RELAY SUPERVISOR PROTECTED STAGING VERIFIED: original task untouched, source and rollback hashes persisted.'
  return
}

$script:BaselineXml=Assert-StagedFiles
Assert-ProtectedOriginalAction
Assert-Handover (Test-OnlyTaskActionChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Unexpected task settings, principal or triggers drift.'
if($Apply){
  Assert-Handover ($task.State -eq 'Running' -and (Test-TaskIsOriginal) -and
    (Get-TaskXml) -ceq $script:BaselineXml) 'Apply requires identical original task snapshot.'
  Assert-HealthyListener
  $ops=@{
    VerifyBefore={
      Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml -and
        (Test-TaskIsOriginal)) 'Concurrent registration modification; handover refused.'
      Assert-HealthyListener
    }
    StopOriginal={
      Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    }
    VerifyVacant={Wait-TaskReadyVacant}
    ApplyAction={Set-OnlyRelayAction -ToSupervisor}
    StartSupervisor={
      Assert-Handover (Test-TaskIsSupervisor) 'Supervisor task action not registered.'
      Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    }
    VerifySupervisor={
      Assert-Handover (Test-TaskIsSupervisor) 'Unexpected relay task action after activation.'
      Wait-Healthy -Supervised
    }
    RestoreOriginal={Restore-OriginalSafely}
    StartOriginal={Start-OriginalSafely}
    VerifyOriginal={
      Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Original task XML not restored.'
      Wait-Healthy
    }
  }
  $result=Invoke-GuardedSupervisorHandover -Operations $ops
  Assert-Handover ($result -ceq 'activated') 'Unexpected handover result.'
  Write-Output 'RELAY SUPERVISOR ACTIVATED: original Auth0 relay task, protected supervisor parent and public/local health verified.'
  Write-Output 'AUTOMATIC RECOVERY STILL UNVERIFIED until a separately approved logged fault rehearsal.'
  return
}

if($Rollback){
  Assert-Handover (Test-TaskIsSupervisor -or (Test-TaskIsOriginal)) 'Registered action does not match either reviewed configuration.'
  Restore-OriginalSafely
  Start-OriginalSafely
  Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Original task registration not restored exactly.'
  Wait-Healthy
  Write-Output 'RELAY SUPERVISOR ROLLBACK VERIFIED: original task restored, unchanged Auth0 health.'
  return
}
throw 'Unknown relay supervisor handover mode.'

  }).Count -gt 0) 'Expected Interactive relay task logon trigger missing.'
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  Assert-Handover (
    (Test-TaskPrincipalIsCurrentUser -TaskUserId ([string]$t.Principal.UserId) -CurrentSid $identity.User)
  ) 'Interactive relay task owner differs from operator and protected-state owner.'
  return $t
}
function Read-TaskResultSafely {
  $info=Get-ScheduledTaskInfo -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
  # LastTaskResult describes the latest instance, not successful recovery.
  return ('0x{0:X8}' -f ([uint32]([long]$info.LastTaskResult -band 4294967295)))
}
function Assert-PrivateBaseline {
  Assert-Handover ($env:COMPUTERNAME -ieq 'Vaulter' -and $env:OS -eq 'Windows_NT') 'Vaulter-only handover.'
  foreach($p in @($script:StateDir,$script:ProtectedBackupDir)){
    Assert-Handover (Test-Path -LiteralPath $p -PathType Container) 'Protected state or baseline checkpoint missing.'
    Assert-Handover ((Get-Acl -LiteralPath $p).AreAccessRulesProtected) 'Protected state ACL no longer isolated.'
  }
  $copy=Join-Path $script:ProtectedBackupDir 'launcher.ps1'
  Assert-Handover ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Protected rollback launcher digest mismatch.'
  $null=Assert-RegisteredTask
}
function Get-OriginalAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Xml)
  [xml]$x=$Xml
  $items=@($x.SelectNodes("//*[local-name()='Actions']/*"))
  Assert-Handover ($items.Count -eq 1 -and $items[0].LocalName -ceq 'Exec') 'Original action shape changed.'
  $cmd=$items[0].SelectSingleNode("*[local-name()='Command']")
  $args=$items[0].SelectSingleNode("*[local-name()='Arguments']")
  $cwd=$items[0].SelectSingleNode("*[local-name()='WorkingDirectory']")
  Assert-Handover ($null -ne $cmd -and $null -ne $args) 'Original action command or arguments missing.'
  $exe=[string]$cmd.InnerText
  $arguments=[string]$args.InnerText
  Assert-Handover ([IO.Path]::IsPathRooted($exe) -and
    [IO.Path]::GetFileName($exe) -ieq 'powershell.exe' -and
    $arguments -match '(?i)(?:^|\s)-File(?=\s)') 'Original task must execute a trusted PowerShell launcher.'
  return [pscustomobject]@{
    Executable=$exe
    Arguments=$arguments
    WorkingDirectory=if($null -ne $cwd){[string]$cwd.InnerText}else{''}
  }
}
function New-ExactAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$Arguments,
    [string]$WorkingDirectory='')
  if(-not [string]::IsNullOrWhiteSpace($WorkingDirectory)){
    return (New-ScheduledTaskAction -Execute $Executable -Argument $Arguments -WorkingDirectory $WorkingDirectory)
  }
  return (New-ScheduledTaskAction -Execute $Executable -Argument $Arguments)
}
function Assert-Auth0Baseline {
  $relay=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 10 -ErrorAction Stop
  $auth=Invoke-RestMethod -Uri 'http://127.0.0.1:8790/healthz' -TimeoutSec 10 -ErrorAction Stop
  $metadata=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/.well-known/oauth-protected-resource/mcp' -TimeoutSec 15 -ErrorAction Stop
  $public=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/healthz' -TimeoutSec 15 -ErrorAction Stop
  Assert-Handover ($relay.status -ceq 'ok' -and $auth.status -ceq 'ok' -and
    $public.status -ceq 'ok' -and
    @($metadata.authorization_servers).Count -eq 1 -and
    @($metadata.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Original Auth0 and public relay health not verified.'
  $authConnections=@(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)
  Assert-Handover ($authConnections.Count -eq 1 -and
    $authConnections[0].LocalAddress -ceq '127.0.0.1') 'Protected auth loopback listener changed.'
  if($script:AuthPid -gt 0){
    Assert-Handover ([int]$authConnections[0].OwningProcess -eq $script:AuthPid) 'Self-hosted auth server identity changed.'
  }else{$script:AuthPid=[int]$authConnections[0].OwningProcess}
}
function Assert-HealthyListener([switch]$Supervised){
  $listeners=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
  Assert-Handover ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') 'No exclusive loopback relay.'
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop
  Assert-Handover ($null -ne $node -and $node.Name -ieq 'node.exe') 'Relay listener is not Node.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $parent -and $parent.Name -ieq 'powershell.exe') 'Node parent is not PowerShell.'
  $original=Get-OriginalAction -Xml $script:BaselineXml
  $fileMatch=[regex]::Match($original.Arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Handover ($fileMatch.Success) 'Original launcher path unknown.'
  $runner=@($fileMatch.Groups[1].Value,$fileMatch.Groups[2].Value,$fileMatch.Groups[3].Value) |
    Where-Object {$_} | Select-Object -First 1
  Assert-Handover ((Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Live original launcher hash changed.'
  Assert-Handover ([string]$parent.CommandLine -like ('*'+$runner+'*')) 'Relay Node not owned by original launch command.'
  if($Supervised){
    $grandparent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId) -ErrorAction Stop
    Assert-Handover ($null -ne $grandparent -and
      (Test-SupervisorParentChain -Node $node -Parent $parent -Supervisor $grandparent -OriginalLauncherPath ([string]$runner) -InstalledSupervisorPath $script:InstalledSupervisor)) 'Active relay process not descended from registered protected supervisor.'
  }
  Assert-Auth0Baseline
}
function Wait-TaskReadyVacant {
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  while([DateTime]::UtcNow -lt $deadline){
    $task=Get-Task
    $listen=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
    if($task.State -eq 'Ready' -and $listen.Count -eq 0){return}
    Start-Sleep -Milliseconds 400
  }
  throw 'Relay task not Ready with empty port; ambiguous process ownership; no action replacement.'
}
function Assert-StagedFiles {
  Assert-Handover (Test-Path -LiteralPath $script:StageDir -PathType Container) 'Supervisor staging not present.'
  Assert-Handover ((Get-Acl -LiteralPath $script:StageDir).AreAccessRulesProtected) 'Supervisor staging ACL not protected.'
  foreach($p in @($script:InstalledSupervisor,$script:BeforeTaskXml,$script:ManifestPath)){
    Assert-Handover (Test-Path -LiteralPath $p -PathType Leaf) 'Supervisor staged file missing.'
    Assert-Handover (-not ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Supervisor staged reparse point refused.'
  }
  $manifest=Get-Content -LiteralPath $script:ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  Assert-Handover ([string]$manifest.SourceSha256 -match '^[0-9A-F]{64}$' -and
    (Get-FileHash -LiteralPath $script:InstalledSupervisor -Algorithm SHA256).Hash -ceq [string]$manifest.SourceSha256 -and
    (Get-FileHash -LiteralPath $script:BeforeTaskXml -Algorithm SHA256).Hash -ceq [string]$manifest.TaskSha256) 'Supervisor installation or private task backup hash mismatch.'
  return [IO.File]::ReadAllText($script:BeforeTaskXml)
}
function Assert-ProtectedOriginalAction {
  $protected=Join-Path $script:ProtectedBackupDir 'relay-task.xml'
  Assert-Handover (Test-Path -LiteralPath $protected -PathType Leaf) 'Protected pre-bridge original task snapshot missing.'
  Assert-Handover (-not ((Get-Item -LiteralPath $protected -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Protected original task XML reparse point refused.'
  Assert-Handover (
    (Test-ProtectedOriginalAction -SnapshotXml $script:BaselineXml -ProtectedBackupXml ([IO.File]::ReadAllText($protected)))
  ) 'Original action differs from protected pre-bridge checkpoint.'
}
function Assert-SupervisorProcessOwnedWithoutHealth {
  $listeners=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
  if($listeners.Count -eq 0){return}
  Assert-Handover ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') 'Unrecognized port binding; task stop refused.'
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop
  Assert-Handover ($null -ne $node -and $node.Name -ieq 'node.exe') 'Unrecognized relay listener process; task stop refused.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $parent) 'Relay launcher parent missing; task stop refused.'
  $supervisor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $supervisor) 'Supervisor parent missing; task stop refused.'
  $expectedLauncher=Get-OriginalAction -Xml $script:BaselineXml
  $m=[regex]::Match($expectedLauncher.Arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Handover ($m.Success) 'Original runner path unavailable for verified task stop.'
  $runner=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value) |
    Where-Object {$_} | Select-Object -First 1
  Assert-Handover (
    (Test-SupervisorParentChain -Node $node -Parent $parent -Supervisor $supervisor -OriginalLauncherPath ([string]$runner) -InstalledSupervisorPath $script:InstalledSupervisor)
  ) 'Relay listener process is not proven task-supervisor-owned; task stop refused.'
}
function Test-TaskIsOriginal {
  $task=Get-Task
  $before=Get-OriginalAction -Xml $script:BaselineXml
  return (@($task.Actions).Count -eq 1 -and
    [string]$task.Actions[0].Execute -ieq $before.Executable -and
    [string]$task.Actions[0].Arguments -ceq $before.Arguments -and
    [string]$task.Actions[0].WorkingDirectory -ceq $before.WorkingDirectory)
}
function Test-TaskIsSupervisor {
  $t=Get-Task
  $original=Get-OriginalAction -Xml $script:BaselineXml
  return (@($t.Actions).Count -eq 1 -and
    [string]$t.Actions[0].Execute -ieq $original.Executable -and
    [string]$t.Actions[0].Arguments -ceq
      ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:InstalledSupervisor+'" -Serve') -and
    [string]$t.Actions[0].WorkingDirectory -ceq $original.WorkingDirectory)
}
function Set-OnlyRelayAction([switch]$ToSupervisor){
  $original=Get-OriginalAction -Xml $script:BaselineXml
  $args=if($ToSupervisor){
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:InstalledSupervisor+'" -Serve'
  }else{$original.Arguments}
  $new=New-ExactAction -Executable $original.Executable -Arguments $args -WorkingDirectory $original.WorkingDirectory
  Set-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -Action $new -ErrorAction Stop | Out-Null
  Assert-Handover (Test-OnlyTaskActionChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Handover altered task XML outside its action.'
  $null=Assert-RegisteredTask
}
function Wait-Healthy([switch]$Supervised){
  $deadline=[DateTime]::UtcNow.AddSeconds(90)
  while([DateTime]::UtcNow -lt $deadline){
    try{
      $task=Get-Task
      if($task.State -eq 'Running'){
        Assert-HealthyListener -Supervised:$Supervised
        return
      }
    }catch{}
    Start-Sleep -Seconds 2
  }
  throw 'Relay did not reach independently healthy original/owned supervised state.'
}
function Restore-OriginalSafely {
  # Called only after baseline proof. Never terminate a non-task-owned listener.
  if(Test-TaskIsSupervisor){
    $current=Get-Task
    if($current.State -eq 'Running'){
      # After handover, the only permitted running instance is verified
      # via the exact grandparent supervisor chain.
      Assert-SupervisorProcessOwnedWithoutHealth
      Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
      Wait-TaskReadyVacant
    }else{
      Assert-Handover ($current.State -eq 'Ready') 'Unexpected task state; rollback cannot safely stop it.'
      Assert-Handover (@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Ambiguous live listener during rollback.'
    }
    Set-OnlyRelayAction
  }elseif(-not(Test-TaskIsOriginal)){
    throw 'Task action differs from both known supervised and original actions; rollback refused.'
  }
}
function Start-OriginalSafely {
  $t=Get-Task
  Assert-Handover (Test-TaskIsOriginal) 'Original task action not restored.'
  if($t.State -eq 'Running'){
    Assert-HealthyListener
    return
  }
  Assert-Handover ($t.State -eq 'Ready') 'Original task unavailable for restart.'
  Assert-Handover (@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Original task restart refused due to occupied port.'
  Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
}

Assert-PrivateBaseline
$task=Get-Task
if(-not $Stage -and -not $Apply -and -not $Rollback){
  Assert-Handover ($task.State -eq 'Running') 'Current relay task not running.'
  $script:BaselineXml=Get-TaskXml
  Assert-ProtectedOriginalAction
  Assert-Handover (Test-TaskIsOriginal) 'Read-only preflight expects original registered launcher.'
  Assert-HealthyListener
  Write-Output 'RELAY SUPERVISOR HANDOVER PREFLIGHT PASS: original Auth0 task running, listener ownership verified.'
  Write-Output ('Current task LastTaskResult='+[string](Read-TaskResultSafely)+' (not recovery proof).')
  Write-Output 'NO CHANGES MADE. -Stage, -Apply or -Rollback require explicit separate execution.'
  return
}
if($Stage){
  Assert-Handover ($task.State -eq 'Running' -and (Test-Path -LiteralPath $script:SourceSupervisor -PathType Leaf)) 'Source or running original relay unavailable.'
  Assert-Handover (-not(Test-Path -LiteralPath $script:StageDir)) 'Supervisor stage exists already; do not overwrite the backup.'
  Assert-Handover (-not [string]::IsNullOrWhiteSpace($ExpectedSupervisorSha256)) 'Pinned supervisor source hash required.'
  Assert-Handover ((Get-FileHash -LiteralPath $script:SourceSupervisor -Algorithm SHA256).Hash -ceq
    $ExpectedSupervisorSha256.ToUpperInvariant()) 'Source supervisor digest differs from reviewed revision.'
  $script:BaselineXml=Get-TaskXml
  Assert-ProtectedOriginalAction
  Assert-Handover (Test-TaskIsOriginal) 'Original task action does not match private baseline.'
  Assert-HealthyListener
  New-Item -ItemType Directory -Path $script:StageDir -ErrorAction Stop | Out-Null
  $acl=Get-Acl -LiteralPath $script:StageDir -ErrorAction Stop
  $acl.SetAccessRuleProtection($true,$true)
  Set-Acl -LiteralPath $script:StageDir -AclObject $acl -ErrorAction Stop
  Assert-Handover ((Get-Acl -LiteralPath $script:StageDir).AreAccessRulesProtected) 'Protected supervisor staging ACL could not be applied.'
  Copy-Item -LiteralPath $script:SourceSupervisor -Destination $script:InstalledSupervisor -ErrorAction Stop
  [IO.File]::WriteAllText($script:BeforeTaskXml,$script:BaselineXml,[Text.UTF8Encoding]::new($false))
  $manifest=[pscustomobject]@{
    SourceSha256=$ExpectedSupervisorSha256.ToUpperInvariant()
    TaskSha256=(Get-FileHash -LiteralPath $script:BeforeTaskXml -Algorithm SHA256).Hash
  }|ConvertTo-Json -Compress
  [IO.File]::WriteAllText($script:ManifestPath,$manifest,[Text.UTF8Encoding]::new($false))
  $null=Assert-StagedFiles
  Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Task changed during staging.'
  Assert-HealthyListener
  Write-Output 'RELAY SUPERVISOR PROTECTED STAGING VERIFIED: original task untouched, source and rollback hashes persisted.'
  return
}

$script:BaselineXml=Assert-StagedFiles
Assert-ProtectedOriginalAction
Assert-Handover (Test-OnlyTaskActionChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Unexpected task settings, principal or triggers drift.'
if($Apply){
  Assert-Handover ($task.State -eq 'Running' -and (Test-TaskIsOriginal) -and
    (Get-TaskXml) -ceq $script:BaselineXml) 'Apply requires identical original task snapshot.'
  Assert-HealthyListener
  $ops=@{
    VerifyBefore={
      Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml -and
        (Test-TaskIsOriginal)) 'Concurrent registration modification; handover refused.'
      Assert-HealthyListener
    }
    StopOriginal={
      Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    }
    VerifyVacant={Wait-TaskReadyVacant}
    ApplyAction={Set-OnlyRelayAction -ToSupervisor}
    StartSupervisor={
      Assert-Handover (Test-TaskIsSupervisor) 'Supervisor task action not registered.'
      Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    }
    VerifySupervisor={
      Assert-Handover (Test-TaskIsSupervisor) 'Unexpected relay task action after activation.'
      Wait-Healthy -Supervised
    }
    RestoreOriginal={Restore-OriginalSafely}
    StartOriginal={Start-OriginalSafely}
    VerifyOriginal={
      Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Original task XML not restored.'
      Wait-Healthy
    }
  }
  $result=Invoke-GuardedSupervisorHandover -Operations $ops
  Assert-Handover ($result -ceq 'activated') 'Unexpected handover result.'
  Write-Output 'RELAY SUPERVISOR ACTIVATED: original Auth0 relay task, protected supervisor parent and public/local health verified.'
  Write-Output 'AUTOMATIC RECOVERY STILL UNVERIFIED until a separately approved logged fault rehearsal.'
  return
}

if($Rollback){
  Assert-Handover (Test-TaskIsSupervisor -or (Test-TaskIsOriginal)) 'Registered action does not match either reviewed configuration.'
  Restore-OriginalSafely
  Start-OriginalSafely
  Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Original task registration not restored exactly.'
  Wait-Healthy
  Write-Output 'RELAY SUPERVISOR ROLLBACK VERIFIED: original task restored, unchanged Auth0 health.'
  return
}
throw 'Unknown relay supervisor handover mode.'
){
      $resolved=[Security.Principal.SecurityIdentifier]::new($TaskUserId)
    }else{
      $name=[Security.Principal.NTAccount]::new($TaskUserId)
      $resolved=$name.Translate([Security.Principal.SecurityIdentifier])
    }
    return ([string]$resolved.Value -ceq [string]$CurrentSid.Value)
  }catch{return $false}
}
function Test-OnlyTaskActionChanged {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$BeforeXml,
    [Parameter(Mandatory=$true)][string]$AfterXml)
  try {
    [xml]$before=$BeforeXml
    [xml]$after=$AfterXml
    $b=$before.SelectSingleNode("//*[local-name()='Actions']")
    $a=$after.SelectSingleNode("//*[local-name()='Actions']")
    if($null -eq $b -or $null -eq $a){return $false}
    $replacement=$after.ImportNode($b,$true)
    $null=$a.ParentNode.ReplaceChild($replacement,$a)
    return ($before.DocumentElement.OuterXml -ceq $after.DocumentElement.OuterXml)
  }catch{return $false}
}
function Test-ProtectedOriginalAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$SnapshotXml,
    [Parameter(Mandatory=$true)][string]$ProtectedBackupXml)
  try{
    [xml]$snapshot=$SnapshotXml
    [xml]$protected=$ProtectedBackupXml
    $current=$snapshot.SelectSingleNode("//*[local-name()='Actions']")
    $original=$protected.SelectSingleNode("//*[local-name()='Actions']")
    return ($null -ne $current -and $null -ne $original -and
      $current.OuterXml -ceq $original.OuterXml)
  }catch{return $false}
}
function Test-SupervisorParentChain {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)]$Node,
    [Parameter(Mandatory=$true)]$Parent,
    [Parameter(Mandatory=$true)]$Supervisor,
    [Parameter(Mandatory=$true)][string]$OriginalLauncherPath,
    [Parameter(Mandatory=$true)][string]$InstalledSupervisorPath
  )
  try{
    return (
      [string]$Node.Name -ieq 'node.exe' -and
      [string]$Parent.Name -ieq 'powershell.exe' -and
      [string]$Supervisor.Name -ieq 'powershell.exe' -and
      [int]$Node.ParentProcessId -eq [int]$Parent.ProcessId -and
      [int]$Parent.ParentProcessId -eq [int]$Supervisor.ProcessId -and
      ([string]$Parent.CommandLine).IndexOf($OriginalLauncherPath,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      ([string]$Supervisor.CommandLine).IndexOf($InstalledSupervisorPath,[StringComparison]::OrdinalIgnoreCase) -ge 0
    )
  }catch{return $false}
}
function Invoke-GuardedSupervisorHandover {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][hashtable]$Operations)
  foreach($step in @('VerifyBefore','StopOriginal','VerifyVacant','ApplyAction',
    'StartSupervisor','VerifySupervisor','RestoreOriginal','StartOriginal','VerifyOriginal')){
    if(-not $Operations.ContainsKey($step) -or $Operations[$step] -isnot [scriptblock]){
      throw 'Missing supervisor handover transaction operation.'
    }
  }
  & $Operations['VerifyBefore']
  try{
    & $Operations['StopOriginal']
    & $Operations['VerifyVacant']
    & $Operations['ApplyAction']
    & $Operations['StartSupervisor']
    & $Operations['VerifySupervisor']
    return 'activated'
  }catch{
    # Never report activation after an unsuccessful health or action-only gate.
    try{
      & $Operations['RestoreOriginal']
      & $Operations['StartOriginal']
      & $Operations['VerifyOriginal']
    }catch{
      throw 'SUPERVISOR HANDOVER ROLLBACK UNVERIFIED. Do not repeat, reboot, or alter other tasks. Inspect private backup and current listener.'
    }
    throw 'SUPERVISOR HANDOVER FAILED; ORIGINAL AUTH0 RELAY ROLLED BACK AND VERIFIED.'
  }
}
function Get-Task {
  Get-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
}
function Get-TaskXml {
  [string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop)
}
function Assert-RegisteredTask {
  $t=Get-Task
  Assert-Handover ([bool]$t.Settings.Enabled -and
    [string]$t.Principal.LogonType -ceq 'Interactive' -and
    [string]$t.Settings.MultipleInstances -ceq 'IgnoreNew' -and
    [int]$t.Settings.RestartCount -eq 10 -and
    [string]$t.Settings.RestartInterval -ceq 'PT1M' -and
    @($t.Actions).Count -eq 1) 'Relay task registration differs from approved baseline.'
  Assert-Handover (@($t.Triggers|Where-Object{
    $_.CimClass.CimClassName -match 'LogonTrigger$'
  }).Count -gt 0) 'Expected Interactive relay task logon trigger missing.'
  return $t
}
function Read-TaskResultSafely {
  $info=Get-ScheduledTaskInfo -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
  # LastTaskResult describes the latest instance, not successful recovery.
  return ('0x{0:X8}' -f ([uint32]([long]$info.LastTaskResult -band 4294967295)))
}
function Assert-PrivateBaseline {
  Assert-Handover ($env:COMPUTERNAME -ieq 'Vaulter' -and $env:OS -eq 'Windows_NT') 'Vaulter-only handover.'
  foreach($p in @($script:StateDir,$script:ProtectedBackupDir)){
    Assert-Handover (Test-Path -LiteralPath $p -PathType Container) 'Protected state or baseline checkpoint missing.'
    Assert-Handover ((Get-Acl -LiteralPath $p).AreAccessRulesProtected) 'Protected state ACL no longer isolated.'
  }
  $copy=Join-Path $script:ProtectedBackupDir 'launcher.ps1'
  Assert-Handover ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Protected rollback launcher digest mismatch.'
  $null=Assert-RegisteredTask
}
function Get-OriginalAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Xml)
  [xml]$x=$Xml
  $items=@($x.SelectNodes("//*[local-name()='Actions']/*"))
  Assert-Handover ($items.Count -eq 1 -and $items[0].LocalName -ceq 'Exec') 'Original action shape changed.'
  $cmd=$items[0].SelectSingleNode("*[local-name()='Command']")
  $args=$items[0].SelectSingleNode("*[local-name()='Arguments']")
  $cwd=$items[0].SelectSingleNode("*[local-name()='WorkingDirectory']")
  Assert-Handover ($null -ne $cmd -and $null -ne $args) 'Original action command or arguments missing.'
  $exe=[string]$cmd.InnerText
  $arguments=[string]$args.InnerText
  Assert-Handover ([IO.Path]::IsPathRooted($exe) -and
    [IO.Path]::GetFileName($exe) -ieq 'powershell.exe' -and
    $arguments -match '(?i)(?:^|\s)-File(?=\s)') 'Original task must execute a trusted PowerShell launcher.'
  return [pscustomobject]@{
    Executable=$exe
    Arguments=$arguments
    WorkingDirectory=if($null -ne $cwd){[string]$cwd.InnerText}else{''}
  }
}
function New-ExactAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$Arguments,
    [string]$WorkingDirectory='')
  if(-not [string]::IsNullOrWhiteSpace($WorkingDirectory)){
    return (New-ScheduledTaskAction -Execute $Executable -Argument $Arguments -WorkingDirectory $WorkingDirectory)
  }
  return (New-ScheduledTaskAction -Execute $Executable -Argument $Arguments)
}
function Assert-Auth0Baseline {
  $relay=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 10 -ErrorAction Stop
  $auth=Invoke-RestMethod -Uri 'http://127.0.0.1:8790/healthz' -TimeoutSec 10 -ErrorAction Stop
  $metadata=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/.well-known/oauth-protected-resource/mcp' -TimeoutSec 15 -ErrorAction Stop
  $public=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/healthz' -TimeoutSec 15 -ErrorAction Stop
  Assert-Handover ($relay.status -ceq 'ok' -and $auth.status -ceq 'ok' -and
    $public.status -ceq 'ok' -and
    @($metadata.authorization_servers).Count -eq 1 -and
    @($metadata.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Original Auth0 and public relay health not verified.'
  $authConnections=@(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)
  Assert-Handover ($authConnections.Count -eq 1 -and
    $authConnections[0].LocalAddress -ceq '127.0.0.1') 'Protected auth loopback listener changed.'
  if($script:AuthPid -gt 0){
    Assert-Handover ([int]$authConnections[0].OwningProcess -eq $script:AuthPid) 'Self-hosted auth server identity changed.'
  }else{$script:AuthPid=[int]$authConnections[0].OwningProcess}
}
function Assert-HealthyListener([switch]$Supervised){
  $listeners=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
  Assert-Handover ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') 'No exclusive loopback relay.'
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop
  Assert-Handover ($null -ne $node -and $node.Name -ieq 'node.exe') 'Relay listener is not Node.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $parent -and $parent.Name -ieq 'powershell.exe') 'Node parent is not PowerShell.'
  $original=Get-OriginalAction -Xml $script:BaselineXml
  $fileMatch=[regex]::Match($original.Arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Handover ($fileMatch.Success) 'Original launcher path unknown.'
  $runner=@($fileMatch.Groups[1].Value,$fileMatch.Groups[2].Value,$fileMatch.Groups[3].Value) |
    Where-Object {$_} | Select-Object -First 1
  Assert-Handover ((Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Live original launcher hash changed.'
  Assert-Handover ([string]$parent.CommandLine -like ('*'+$runner+'*')) 'Relay Node not owned by original launch command.'
  if($Supervised){
    $grandparent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId) -ErrorAction Stop
    Assert-Handover ($null -ne $grandparent -and
      (Test-SupervisorParentChain -Node $node -Parent $parent -Supervisor $grandparent -OriginalLauncherPath ([string]$runner) -InstalledSupervisorPath $script:InstalledSupervisor)) 'Active relay process not descended from registered protected supervisor.'
  }
  Assert-Auth0Baseline
}
function Wait-TaskReadyVacant {
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  while([DateTime]::UtcNow -lt $deadline){
    $task=Get-Task
    $listen=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
    if($task.State -eq 'Ready' -and $listen.Count -eq 0){return}
    Start-Sleep -Milliseconds 400
  }
  throw 'Relay task not Ready with empty port; ambiguous process ownership; no action replacement.'
}
function Assert-StagedFiles {
  Assert-Handover (Test-Path -LiteralPath $script:StageDir -PathType Container) 'Supervisor staging not present.'
  Assert-Handover ((Get-Acl -LiteralPath $script:StageDir).AreAccessRulesProtected) 'Supervisor staging ACL not protected.'
  foreach($p in @($script:InstalledSupervisor,$script:BeforeTaskXml,$script:ManifestPath)){
    Assert-Handover (Test-Path -LiteralPath $p -PathType Leaf) 'Supervisor staged file missing.'
    Assert-Handover (-not ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Supervisor staged reparse point refused.'
  }
  $manifest=Get-Content -LiteralPath $script:ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  Assert-Handover ([string]$manifest.SourceSha256 -match '^[0-9A-F]{64}$' -and
    (Get-FileHash -LiteralPath $script:InstalledSupervisor -Algorithm SHA256).Hash -ceq [string]$manifest.SourceSha256 -and
    (Get-FileHash -LiteralPath $script:BeforeTaskXml -Algorithm SHA256).Hash -ceq [string]$manifest.TaskSha256) 'Supervisor installation or private task backup hash mismatch.'
  return [IO.File]::ReadAllText($script:BeforeTaskXml)
}
function Assert-ProtectedOriginalAction {
  $protected=Join-Path $script:ProtectedBackupDir 'relay-task.xml'
  Assert-Handover (Test-Path -LiteralPath $protected -PathType Leaf) 'Protected pre-bridge original task snapshot missing.'
  Assert-Handover (-not ((Get-Item -LiteralPath $protected -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Protected original task XML reparse point refused.'
  Assert-Handover (
    (Test-ProtectedOriginalAction -SnapshotXml $script:BaselineXml -ProtectedBackupXml ([IO.File]::ReadAllText($protected)))
  ) 'Original action differs from protected pre-bridge checkpoint.'
}
function Assert-SupervisorProcessOwnedWithoutHealth {
  $listeners=@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
  if($listeners.Count -eq 0){return}
  Assert-Handover ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') 'Unrecognized port binding; task stop refused.'
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop
  Assert-Handover ($null -ne $node -and $node.Name -ieq 'node.exe') 'Unrecognized relay listener process; task stop refused.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $parent) 'Relay launcher parent missing; task stop refused.'
  $supervisor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId) -ErrorAction Stop
  Assert-Handover ($null -ne $supervisor) 'Supervisor parent missing; task stop refused.'
  $expectedLauncher=Get-OriginalAction -Xml $script:BaselineXml
  $m=[regex]::Match($expectedLauncher.Arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Handover ($m.Success) 'Original runner path unavailable for verified task stop.'
  $runner=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value) |
    Where-Object {$_} | Select-Object -First 1
  Assert-Handover (
    (Test-SupervisorParentChain -Node $node -Parent $parent -Supervisor $supervisor -OriginalLauncherPath ([string]$runner) -InstalledSupervisorPath $script:InstalledSupervisor)
  ) 'Relay listener process is not proven task-supervisor-owned; task stop refused.'
}
function Test-TaskIsOriginal {
  $task=Get-Task
  $before=Get-OriginalAction -Xml $script:BaselineXml
  return (@($task.Actions).Count -eq 1 -and
    [string]$task.Actions[0].Execute -ieq $before.Executable -and
    [string]$task.Actions[0].Arguments -ceq $before.Arguments -and
    [string]$task.Actions[0].WorkingDirectory -ceq $before.WorkingDirectory)
}
function Test-TaskIsSupervisor {
  $t=Get-Task
  $original=Get-OriginalAction -Xml $script:BaselineXml
  return (@($t.Actions).Count -eq 1 -and
    [string]$t.Actions[0].Execute -ieq $original.Executable -and
    [string]$t.Actions[0].Arguments -ceq
      ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:InstalledSupervisor+'" -Serve') -and
    [string]$t.Actions[0].WorkingDirectory -ceq $original.WorkingDirectory)
}
function Set-OnlyRelayAction([switch]$ToSupervisor){
  $original=Get-OriginalAction -Xml $script:BaselineXml
  $args=if($ToSupervisor){
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:InstalledSupervisor+'" -Serve'
  }else{$original.Arguments}
  $new=New-ExactAction -Executable $original.Executable -Arguments $args -WorkingDirectory $original.WorkingDirectory
  Set-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -Action $new -ErrorAction Stop | Out-Null
  Assert-Handover (Test-OnlyTaskActionChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Handover altered task XML outside its action.'
  $null=Assert-RegisteredTask
}
function Wait-Healthy([switch]$Supervised){
  $deadline=[DateTime]::UtcNow.AddSeconds(90)
  while([DateTime]::UtcNow -lt $deadline){
    try{
      $task=Get-Task
      if($task.State -eq 'Running'){
        Assert-HealthyListener -Supervised:$Supervised
        return
      }
    }catch{}
    Start-Sleep -Seconds 2
  }
  throw 'Relay did not reach independently healthy original/owned supervised state.'
}
function Restore-OriginalSafely {
  # Called only after baseline proof. Never terminate a non-task-owned listener.
  if(Test-TaskIsSupervisor){
    $current=Get-Task
    if($current.State -eq 'Running'){
      # After handover, the only permitted running instance is verified
      # via the exact grandparent supervisor chain.
      Assert-SupervisorProcessOwnedWithoutHealth
      Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
      Wait-TaskReadyVacant
    }else{
      Assert-Handover ($current.State -eq 'Ready') 'Unexpected task state; rollback cannot safely stop it.'
      Assert-Handover (@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Ambiguous live listener during rollback.'
    }
    Set-OnlyRelayAction
  }elseif(-not(Test-TaskIsOriginal)){
    throw 'Task action differs from both known supervised and original actions; rollback refused.'
  }
}
function Start-OriginalSafely {
  $t=Get-Task
  Assert-Handover (Test-TaskIsOriginal) 'Original task action not restored.'
  if($t.State -eq 'Running'){
    Assert-HealthyListener
    return
  }
  Assert-Handover ($t.State -eq 'Ready') 'Original task unavailable for restart.'
  Assert-Handover (@(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Original task restart refused due to occupied port.'
  Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
}

Assert-PrivateBaseline
$task=Get-Task
if(-not $Stage -and -not $Apply -and -not $Rollback){
  Assert-Handover ($task.State -eq 'Running') 'Current relay task not running.'
  $script:BaselineXml=Get-TaskXml
  Assert-ProtectedOriginalAction
  Assert-Handover (Test-TaskIsOriginal) 'Read-only preflight expects original registered launcher.'
  Assert-HealthyListener
  Write-Output 'RELAY SUPERVISOR HANDOVER PREFLIGHT PASS: original Auth0 task running, listener ownership verified.'
  Write-Output ('Current task LastTaskResult='+[string](Read-TaskResultSafely)+' (not recovery proof).')
  Write-Output 'NO CHANGES MADE. -Stage, -Apply or -Rollback require explicit separate execution.'
  return
}
if($Stage){
  Assert-Handover ($task.State -eq 'Running' -and (Test-Path -LiteralPath $script:SourceSupervisor -PathType Leaf)) 'Source or running original relay unavailable.'
  Assert-Handover (-not(Test-Path -LiteralPath $script:StageDir)) 'Supervisor stage exists already; do not overwrite the backup.'
  Assert-Handover (-not [string]::IsNullOrWhiteSpace($ExpectedSupervisorSha256)) 'Pinned supervisor source hash required.'
  Assert-Handover ((Get-FileHash -LiteralPath $script:SourceSupervisor -Algorithm SHA256).Hash -ceq
    $ExpectedSupervisorSha256.ToUpperInvariant()) 'Source supervisor digest differs from reviewed revision.'
  $script:BaselineXml=Get-TaskXml
  Assert-ProtectedOriginalAction
  Assert-Handover (Test-TaskIsOriginal) 'Original task action does not match private baseline.'
  Assert-HealthyListener
  New-Item -ItemType Directory -Path $script:StageDir -ErrorAction Stop | Out-Null
  $acl=Get-Acl -LiteralPath $script:StageDir -ErrorAction Stop
  $acl.SetAccessRuleProtection($true,$true)
  Set-Acl -LiteralPath $script:StageDir -AclObject $acl -ErrorAction Stop
  Assert-Handover ((Get-Acl -LiteralPath $script:StageDir).AreAccessRulesProtected) 'Protected supervisor staging ACL could not be applied.'
  Copy-Item -LiteralPath $script:SourceSupervisor -Destination $script:InstalledSupervisor -ErrorAction Stop
  [IO.File]::WriteAllText($script:BeforeTaskXml,$script:BaselineXml,[Text.UTF8Encoding]::new($false))
  $manifest=[pscustomobject]@{
    SourceSha256=$ExpectedSupervisorSha256.ToUpperInvariant()
    TaskSha256=(Get-FileHash -LiteralPath $script:BeforeTaskXml -Algorithm SHA256).Hash
  }|ConvertTo-Json -Compress
  [IO.File]::WriteAllText($script:ManifestPath,$manifest,[Text.UTF8Encoding]::new($false))
  $null=Assert-StagedFiles
  Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Task changed during staging.'
  Assert-HealthyListener
  Write-Output 'RELAY SUPERVISOR PROTECTED STAGING VERIFIED: original task untouched, source and rollback hashes persisted.'
  return
}

$script:BaselineXml=Assert-StagedFiles
Assert-ProtectedOriginalAction
Assert-Handover (Test-OnlyTaskActionChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Unexpected task settings, principal or triggers drift.'
if($Apply){
  Assert-Handover ($task.State -eq 'Running' -and (Test-TaskIsOriginal) -and
    (Get-TaskXml) -ceq $script:BaselineXml) 'Apply requires identical original task snapshot.'
  Assert-HealthyListener
  $ops=@{
    VerifyBefore={
      Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml -and
        (Test-TaskIsOriginal)) 'Concurrent registration modification; handover refused.'
      Assert-HealthyListener
    }
    StopOriginal={
      Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    }
    VerifyVacant={Wait-TaskReadyVacant}
    ApplyAction={Set-OnlyRelayAction -ToSupervisor}
    StartSupervisor={
      Assert-Handover (Test-TaskIsSupervisor) 'Supervisor task action not registered.'
      Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
    }
    VerifySupervisor={
      Assert-Handover (Test-TaskIsSupervisor) 'Unexpected relay task action after activation.'
      Wait-Healthy -Supervised
    }
    RestoreOriginal={Restore-OriginalSafely}
    StartOriginal={Start-OriginalSafely}
    VerifyOriginal={
      Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Original task XML not restored.'
      Wait-Healthy
    }
  }
  $result=Invoke-GuardedSupervisorHandover -Operations $ops
  Assert-Handover ($result -ceq 'activated') 'Unexpected handover result.'
  Write-Output 'RELAY SUPERVISOR ACTIVATED: original Auth0 relay task, protected supervisor parent and public/local health verified.'
  Write-Output 'AUTOMATIC RECOVERY STILL UNVERIFIED until a separately approved logged fault rehearsal.'
  return
}

if($Rollback){
  Assert-Handover (Test-TaskIsSupervisor -or (Test-TaskIsOriginal)) 'Registered action does not match either reviewed configuration.'
  Restore-OriginalSafely
  Start-OriginalSafely
  Assert-Handover ((Get-TaskXml) -ceq $script:BaselineXml) 'Original task registration not restored exactly.'
  Wait-Healthy
  Write-Output 'RELAY SUPERVISOR ROLLBACK VERIFIED: original task restored, unchanged Auth0 health.'
  return
}
throw 'Unknown relay supervisor handover mode.'
