# Local owner-only cutover from CDP to combined CDP + explicitly shared Edge tabs.
# Preflight and SelfTest are read-only; Apply/Accept/Rollback require local owner.
# Do not execute task-changing modes through remote Tetherplane tools.
[CmdletBinding()]
param(
  [ValidateSet('SelfTest','Preflight','Apply','Accept','Rollback','AutoRollback')]
  [string]$Mode='Preflight'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$App=Join-Path $env:LOCALAPPDATA 'Tetherplane'
$Root=Join-Path $App 'release-candidates\BrowserCombined20261106'
$OwnerTask='Tetherplane Private Agent NoConsole 20261101'
$ManagedTask='Tetherplane Browser Bridge'
$HostTask='Tetherplane Authenticated Browser Host 20261106'
$UnifiedTask='Tetherplane Combined Browser Bridge 20261106'
$WatchdogTask='Tetherplane Combined Browser Rollback 20261106'
$AgentExe=Join-Path $env:LOCALAPPDATA 'Programs\TetherplaneBrowserAgent-20261106\bin\tetherd-agentw.exe'
$OriginalArgs=Join-Path $env:LOCALAPPDATA 'Programs\TetherplaneBrowserAgent-20261106\config\agent-args.json'
$CandidateArgs=Join-Path $Root 'agent-args.combined.json'
$Unified=Join-Path $Root 'browser-unified-rpc-host.mjs'
$Probe=Join-Path $Root 'Probe-Combined-Browser-20261106.mjs'
$HostScript=Join-Path $env:LOCALAPPDATA 'Programs\TetherplaneBrowserCanary20261101\browser\host.mjs'
$IdentityFile=Join-Path $App 'browser-extension.id'
$OldTaskXml=Join-Path $Root 'original-agent-task.xml'
$StatePath=Join-Path $Root 'handover-state.json'
$Receipt=Join-Path $Root 'owner-accepted.txt'
$RollbackScript=Join-Path $Root 'combined-owner-rollback-snapshot.ps1'
$Audit=Join-Path $Root 'handover-events.log'
$OriginalActionArgs='--arguments-file "'+$OriginalArgs+'"'
$CandidateActionArgs='--arguments-file "'+$CandidateArgs+'"'
$OldArgsSha='83957990C6EC2E0EE7F5B2DB077B5D875EC23F48B9093F4D320BA2C91381248D'
$NewArgsSha='D9037F65A1130354F3CEEFF6A21D0BBD7626A2231034BEF905707B1D08A66E66'
$AgentSha='A9CCF5180C164883272DF5C3308D842C2EFE36FC861821E7C3CD55239D1F08DC'
$UnifiedSha='1A415EBED89DB9D6CBF5DC75797387DD2D598120262303C98C63138E805D3490'
$ProbeSha='80EE5D782BF2371F6920E8004FBD6AB7A1650A248737504A5C3031B0A0391A32'
$HostSha='B60CD0C5584FFFAADBFBDD2E1182BE9133F863D2FAA3C70D49B0D0B8365A83B7'
$Node=Join-Path $env:ProgramFiles 'nodejs\node.exe'

function Assert([bool]$Ok,[string]$Reason){if(-not $Ok){throw ('HALT_'+$Reason)}}
function Sha([string]$Path){if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){return ''};return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()}
function AssertHash([string]$Path,[string]$Expected,[string]$Key){Assert ((Sha $Path) -ceq $Expected) ($Key+'_HASH_MISMATCH')}
function Log([string]$Entry){Add-Content -LiteralPath $Audit -Value ((Get-Date).ToUniversalTime().ToString('o')+' '+$Entry) -ErrorAction Stop}
function AssertLeno {Assert ($env:COMPUTERNAME -ieq 'LENO') 'WRONG_DEVICE'}
function OwnerTaskObj {return Get-ScheduledTask -TaskName $OwnerTask -ErrorAction Stop}
function AssertOwner {
  AssertLeno
  Assert ([Environment]::UserInteractive) 'LOCAL_OWNER_CONSOLE_REQUIRED'
  $task=OwnerTaskObj
  $id=[string]$task.Principal.UserId
  $qualified=$env:USERDOMAIN+'\'+$env:USERNAME
  Assert (($id -ieq $env:USERNAME) -or ($id -ieq $qualified)) 'TASK_OWNER_ACCOUNT_MISMATCH'
  Assert ([string]$task.Principal.LogonType -eq 'Interactive') 'TASK_LOGON_POLICY_DRIFT'
  Assert ([string]$task.Principal.RunLevel -eq 'Highest') 'TASK_RUNLEVEL_DRIFT'
}
function AgentProcesses {return @(Get-CimInstance Win32_Process -Filter "Name='tetherd-agentw.exe' OR Name='tetherd.exe'" -ErrorAction Stop)}
function PortListening([int]$Port){
  return (@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -eq 1)
}
function CheckArguments {
  $before=ConvertFrom-Json -InputObject (Get-Content -LiteralPath $OriginalArgs -Raw -ErrorAction Stop)
  $after=ConvertFrom-Json -InputObject (Get-Content -LiteralPath $CandidateArgs -Raw -ErrorAction Stop)
  Assert (($before -is [array]) -and ($after -is [array]) -and $before.Count -eq 16 -and $after.Count -eq 16) 'ARGS_ARRAY_SHAPE'
  $diff=0
  for($i=0;$i -lt 16;$i++){
    if([string]$before[$i] -cne [string]$after[$i]){
      $diff++
      Assert (([string]$before[$i] -ceq '127.0.0.1:17655') -and
        ([string]$after[$i] -ceq '127.0.0.1:17660') -and
        ($i -gt 0) -and ([string]$before[$i-1] -ceq '--browser-bridge')) 'UNEXPECTED_CONFIG_DIFFERENCE'
    }
  }
  Assert ($diff -eq 1) 'CANDIDATE_MUST_ONLY_CHANGE_BRIDGE_ADDRESS'
}
function CheckPins {
  AssertLeno
  AssertHash $AgentExe $AgentSha 'AGENT'
  AssertHash $OriginalArgs $OldArgsSha 'ORIGINAL_AGENT_ARGS'
  AssertHash $CandidateArgs $NewArgsSha 'COMBINED_AGENT_ARGS'
  AssertHash $Unified $UnifiedSha 'REVIEWED_COMBINED_ROUTER'
  AssertHash $Probe $ProbeSha 'READ_ONLY_PROBE'
  AssertHash $HostScript $HostSha 'AUTHENTICATED_HOST'
  Assert (Test-Path -LiteralPath $Node -PathType Leaf) 'NODE_NOT_AVAILABLE'
  Assert (Test-Path -LiteralPath (Join-Path $App 'browser-bridge.token') -PathType Leaf) 'BROWSER_TOKEN_MISSING'
  Assert (Test-Path -LiteralPath (Join-Path $App 'browser-extension-launch.token') -PathType Leaf) 'EXTENSION_TOKEN_MISSING'
  Assert (Test-Path -LiteralPath $IdentityFile -PathType Leaf) 'OWNER_EXTENSION_ID_MISSING'
  Assert ((Get-Content -LiteralPath $IdentityFile -Raw).Trim() -cmatch '^[a-p]{32}$') 'OWNER_PIN_MALFORMED'
  CheckArguments
}
function TestApprovedTab {
  if(-not (PortListening 17657)){return $false}
  $result=& $Node $Probe --owner-only --require-approved 2>$null
  if($LASTEXITCODE -ne 0 -or -not $result){return $false}
  try {
    $value=ConvertFrom-Json -InputObject ($result -join '')
    return ($value.verdict -ceq 'PROBE_OK' -and $value.approved_tab_count -ge 1)
  } catch {return $false}
}
function TestCombined {
  if(-not (PortListening 17660)){return $false}
  $result=& $Node $Probe --require-approved 2>$null
  if($LASTEXITCODE -ne 0 -or -not $result){return $false}
  try{
    $value=ConvertFrom-Json -InputObject ($result -join '')
    return ($value.verdict -ceq 'PROBE_OK' -and
      $value.backend -ceq 'cdp_plus_owner_authorized_extension' -and
      $value.approved_tab_count -ge 1)
  }catch{return $false}
}
function CheckOriginalTask {
  $t=OwnerTaskObj
  Assert (@($t.Actions).Count -eq 1) 'OWNER_TASK_ACTIONS_DRIFT'
  Assert (([string]$t.Actions[0].Execute -ieq $AgentExe) -and
    ([string]$t.Actions[0].Arguments -ceq $OriginalActionArgs)) 'CURRENT_AGENT_TASK_ACTION_DRIFT'
  Assert ([string]$t.State -eq 'Running') 'CURRENT_AGENT_NOT_RUNNING'
  Assert ([bool]$t.Settings.Enabled) 'CURRENT_AGENT_DISABLED'
  $all=@(AgentProcesses)
  $own=@($all|Where-Object{$_.ExecutablePath -ieq $AgentExe})
  Assert ($all.Count -eq 1 -and $own.Count -eq 1) 'UNEXPECTED_OTHER_AGENT_PROCESS'
  $managed=Get-ScheduledTask -TaskName $ManagedTask -ErrorAction Stop
  Assert ([string]$managed.State -eq 'Running') 'MANAGED_BROWSER_TASK_UNAVAILABLE'
  Assert (PortListening 17655) 'MANAGED_CDP_PORT_UNAVAILABLE'
}
function Preflight {
  CheckPins
  CheckOriginalTask
  Assert (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) 'HANDOVER_ALREADY_STARTED'
  Assert (-not (Test-Path -LiteralPath $Receipt -PathType Leaf)) 'OLD_ACCEPTANCE_RECEIPT_PRESENT'
  Assert (-not (Test-Path -LiteralPath $OldTaskXml -PathType Leaf)) 'UNEXPECTED_TASK_BACKUP_PRESENT'
  Assert (-not (Get-ScheduledTask -TaskName $HostTask -ErrorAction SilentlyContinue)) 'HOST_TASK_ALREADY_REGISTERED'
  Assert (-not (Get-ScheduledTask -TaskName $UnifiedTask -ErrorAction SilentlyContinue)) 'UNIFIED_TASK_ALREADY_REGISTERED'
  Assert (-not (Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction SilentlyContinue)) 'WATCHDOG_ALREADY_REGISTERED'
  Assert (-not (PortListening 17660)) 'UNIFIED_PORT_ALREADY_IN_USE'
  $pending=Join-Path $App 'state\idempotency'
  if(Test-Path -LiteralPath $pending -PathType Container){
    Assert (@(Get-ChildItem -LiteralPath $pending -Filter '*.pending.json' -File).Count -eq 0) 'PENDING_MUTATIONS'
  }
  return [ordered]@{
    verdict=if(TestApprovedTab){'READY_LOCAL_OWNER_APPLY_REQUIRED'}else{'PAIR_AND_SHARE_AN_EDGE_TAB_FIRST'}
    old_provider='127.0.0.1:17655'
    combined_provider='127.0.0.1:17660'
    current_agent_unchanged=$true
    owner_tab_grant_visible=TestApprovedTab
    persistent_tasks_pending_owner_approval=$true
    scheduled_rollback_minutes=6
  }
}
function SelfTest {
  Assert ($AgentSha.Length -eq 64 -and $UnifiedSha.Length -eq 64 -and $NewArgsSha.Length -eq 64) 'PIN_LENGTH'
  Assert ($OriginalActionArgs -ne $CandidateActionArgs) 'TASK_ARG_SEPARATION'
  Assert ($OwnerTask -ne $UnifiedTask -and $UnifiedTask -ne $HostTask) 'TASK_ID_UNIQUE'
  CheckPins
  Write-Output 'COMBINED_BROWSER_OWNER_SELFTEST_PASS'
}
function RegisterUserTask([string]$Name,[string]$JsPath) {
  $owner=(OwnerTaskObj).Principal.UserId
  $action=New-ScheduledTaskAction -Execute $Node -Argument ('"'+$JsPath+'"')
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $owner
  $principal=New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 -StartWhenAvailable
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Owner-approved Tetherplane local browser bridge, no additional privileges' -ErrorAction Stop|Out-Null
  $task=Get-ScheduledTask -TaskName $Name -ErrorAction Stop
  Assert (([string]$task.Principal.LogonType -eq 'Interactive') -and
    ([string]$task.Principal.RunLevel -eq 'Limited')) 'NEW_TASK_PRIVILEGE_DRIFT'
}
function RegisterWatchdog {
  $owner=(OwnerTaskObj).Principal.UserId
  $action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -File "'+$RollbackScript+'" -Mode AutoRollback')
  $principal=New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Highest
  $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(6)
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -StartWhenAvailable
  Register-ScheduledTask -TaskName $WatchdogTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Owner-preauthorized six-minute browser-router rollback' -ErrorAction Stop|Out-Null
  Assert ([string](Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction Stop).State -ne 'Disabled') 'WATCHDOG_NOT_ARMED'
}
function WaitNoAgents([int]$Seconds){
  $deadline=(Get-Date).AddSeconds($Seconds)
  while((Get-Date) -lt $deadline){
    if(@(AgentProcesses).Count -eq 0){return $true}
    Start-Sleep -Milliseconds 500
  }
  return (@(AgentProcesses).Count -eq 0)
}
function WaitSingleAgent([int]$Seconds){
  $deadline=(Get-Date).AddSeconds($Seconds)
  while((Get-Date) -lt $deadline){
    $all=@(AgentProcesses)
    if($all.Count -eq 1 -and $all[0].ExecutablePath -ieq $AgentExe){return $true}
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function RestoreOriginal {
  AssertLeno
  Assert (Test-Path -LiteralPath $StatePath -PathType Leaf) 'STATE_NOT_PRESENT'
  AssertHash $AgentExe $AgentSha 'RESTORE_AGENT_BINARY'
  AssertHash $OriginalArgs $OldArgsSha 'RESTORE_ORIGINAL_ARGS'
  $t=OwnerTaskObj
  Assert (@($t.Actions).Count -eq 1) 'RESTORE_UNEXPECTED_TASK_ACTION'
  $current=[string]$t.Actions[0].Arguments
  Assert (($current -ceq $OriginalActionArgs) -or ($current -ceq $CandidateActionArgs)) 'RESTORE_UNKNOWN_TASK_ACTION'
  if($current -ceq $CandidateActionArgs){
    Disable-ScheduledTask -TaskName $OwnerTask -ErrorAction Stop|Out-Null
    Stop-ScheduledTask -TaskName $OwnerTask -ErrorAction SilentlyContinue
    Assert (WaitNoAgents 30) 'RESTORE_AGENT_FAILED_TO_STOP'
    Set-ScheduledTask -TaskName $OwnerTask -Action (New-ScheduledTaskAction -Execute $AgentExe -Argument $OriginalActionArgs) -ErrorAction Stop|Out-Null
  }
  Enable-ScheduledTask -TaskName $OwnerTask -ErrorAction Stop|Out-Null
  if(@(AgentProcesses).Count -eq 0){Start-ScheduledTask -TaskName $OwnerTask -ErrorAction Stop}
  Assert (WaitSingleAgent 45) 'RESTORE_ORIGINAL_AGENT_NOT_VERIFIED'
  Log 'ROLLBACK_ORIGINAL_TASK_RESTORED'
  Write-Output 'COMBINED_BROWSER_ROLLBACK_RESTORED_CDP_REMOTE_CHECK_REQUIRED'
}
function CleanupPreparedTasks {
  # Only remove the two task names created by this local owner handover.
  foreach($name in @($UnifiedTask,$HostTask)){
    $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if($task){
      Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
    }
  }
  Log 'COMBINED_BACKGROUND_TASKS_UNREGISTERED'
}
function AutoRollback {
  AssertLeno
  if(Test-Path -LiteralPath $Receipt -PathType Leaf){
    $accepted=(Get-Content -LiteralPath $Receipt -Raw).Trim()
    if($accepted -ceq ('ACCEPTED:'+$NewArgsSha)){
      Log 'WATCHDOG_ACCEPTED_NO_ROLLBACK'
      Write-Output 'COMBINED_BROWSER_ACCEPTED_NO_ROLLBACK'
      return
    }
    throw 'INVALID_ACCEPTANCE_MARKER'
  }
  RestoreOriginal
  CleanupPreparedTasks
}
function Apply {
  AssertOwner
  $state=Preflight
  Write-Output ($state|ConvertTo-Json -Depth 3)
  Assert ($state.owner_tab_grant_visible) 'RECONNECT_EDGE_AND_SHARE_TAB_FIRST'
  Write-Warning 'OWNER-APPROVED TRIAL: starts two same-user interactive logon tasks, switches the existing agent browser flag from 17655 to 17660, and arms a six-minute automatic rollback. Agent connection will interrupt. Stay logged in.'
  $answer=Read-Host 'Type exactly: AUTHORIZE COMBINED EDGE BROWSER CUTOVER'
  Assert ($answer -ceq 'AUTHORIZE COMBINED EDGE BROWSER CUTOVER') 'LOCAL_OWNER_APPROVAL_MISSING'
  Export-ScheduledTask -TaskName $OwnerTask -ErrorAction Stop | Set-Content -LiteralPath $OldTaskXml -Encoding UTF8 -ErrorAction Stop
  if($PSCommandPath -ine $RollbackScript){
    Copy-Item -LiteralPath $PSCommandPath -Destination $RollbackScript -ErrorAction Stop
  }
  $stateData=[ordered]@{
    created_utc=(Get-Date).ToUniversalTime().ToString('o')
    original_args_sha256=$OldArgsSha
    new_args_sha256=$NewArgsSha
    combined_router_sha256=$UnifiedSha
    original_task_action=$OriginalActionArgs
    new_task_action=$CandidateActionArgs
    authority='LOCAL_OWNER_INTERACTIVE_APPROVAL'
    remote_acceptance='PENDING'
  }
  $stateData|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $StatePath -Encoding UTF8 -ErrorAction Stop
  try {
    RegisterUserTask $HostTask $HostScript
    # The original host process is currently an owner-run ephemeral process.
    # Never kill/replace it: the new logon task will start after the next sign-in.
    if(-not (PortListening 17658)){Start-ScheduledTask -TaskName $HostTask -ErrorAction Stop}
    RegisterUserTask $UnifiedTask $Unified
    RegisterWatchdog
    Log 'NEW_TASKS_REGISTERED_WATCHDOG_ARMED'
    Start-ScheduledTask -TaskName $UnifiedTask -ErrorAction Stop
    $deadline=(Get-Date).AddSeconds(25)
    while(-not (PortListening 17660) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 300}
    Assert (PortListening 17660) 'COMBINED_ROUTER_DID_NOT_START'
    Assert (TestCombined) 'COMBINED_ROUTER_AUTH_GRANT_NOT_READY'
    Disable-ScheduledTask -TaskName $OwnerTask -ErrorAction Stop|Out-Null
    Stop-ScheduledTask -TaskName $OwnerTask -ErrorAction Stop
    Assert (WaitNoAgents 35) 'OLD_AGENT_STILL_RUNNING'
    Set-ScheduledTask -TaskName $OwnerTask -Action (New-ScheduledTaskAction -Execute $AgentExe -Argument $CandidateActionArgs) -ErrorAction Stop|Out-Null
    Enable-ScheduledTask -TaskName $OwnerTask -ErrorAction Stop|Out-Null
    Start-ScheduledTask -TaskName $OwnerTask -ErrorAction Stop
    Assert (WaitSingleAgent 45) 'NEW_AGENT_NOT_STARTED'
    Log 'COMBINED_TASK_RUNNING_REMOTE_ACCEPTANCE_REQUIRED'
    Write-Output 'COMBINED_BROWSER_CANDIDATE_RUNNING_VERIFY_REMOTE_THEN_ACCEPT_LOCALLY'
  }catch{
    $problem=$_.Exception.Message
    Log ('APPLY_FAIL_'+$problem)
    try{RestoreOriginal}catch{Log ('ROLLBACK_PROBLEM_'+$_.Exception.Message)}
    throw ('COMBINED_APPLY_FAILED_'+$problem)
  }
}
function Accept {
  AssertOwner
  Assert (Test-Path -LiteralPath $StatePath -PathType Leaf) 'NO_COMBINED_CUTOVER_STATE'
  Assert (-not (Test-Path -LiteralPath $Receipt -PathType Leaf)) 'ALREADY_ACCEPTED'
  CheckPins
  $task=OwnerTaskObj
  Assert (@($task.Actions).Count -eq 1 -and
    ([string]$task.Actions[0].Execute -ieq $AgentExe) -and
    ([string]$task.Actions[0].Arguments -ceq $CandidateActionArgs)) 'COMBINED_TASK_ACTION_MISMATCH'
  Assert ([string]$task.State -eq 'Running') 'COMBINED_TASK_NOT_RUNNING'
  Assert ([string](Get-ScheduledTask -TaskName $UnifiedTask -ErrorAction Stop).State -eq 'Running') 'UNIFIED_SUPERVISOR_NOT_RUNNING'
  Assert ((PortListening 17657) -and (PortListening 17660) -and (TestCombined)) 'OWNER_EDGE_GRANT_EXPIRED_RECONNECT_FIRST'
  $watchBefore=Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction SilentlyContinue
  Assert ($null -ne $watchBefore) 'WATCHDOG_NOT_REGISTERED'
  $deadline=(Get-ScheduledTaskInfo -TaskName $WatchdogTask -ErrorAction Stop).NextRunTime
  Assert ($deadline -gt (Get-Date).AddSeconds(15)) 'WATCHDOG_WINDOW_TOO_SHORT'
  $answer=Read-Host 'After independent Tetherplane browser.status/pages testing, type: ACCEPT COMBINED BROWSER VERIFIED'
  Assert ($answer -ceq 'ACCEPT COMBINED BROWSER VERIFIED') 'ACCEPTANCE_CONFIRMATION_REQUIRED'
  $latest=OwnerTaskObj
  Assert ([string]$latest.Actions[0].Arguments -ceq $CandidateActionArgs -and
    [string]$latest.State -eq 'Running') 'CUTOVER_CHANGED_DURING_OWNER_CONFIRMATION'
  Assert ((Get-ScheduledTaskInfo -TaskName $WatchdogTask -ErrorAction Stop).NextRunTime -gt (Get-Date).AddSeconds(5)) 'WATCHDOG_ALREADY_DUE'
  Assert (TestCombined) 'COMBINED_BROWSER_GRANT_EXPIRED_BEFORE_ACCEPT'
  [IO.File]::WriteAllText($Receipt,('ACCEPTED:'+$NewArgsSha),(New-Object Text.UTF8Encoding($false)))
  $watch=Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction SilentlyContinue
  if($watch){Unregister-ScheduledTask -TaskName $WatchdogTask -Confirm:$false -ErrorAction Stop}
  Log 'OWNER_ACCEPTED_WATCHDOG_REMOVED_REBOOT_TEST_PENDING'
  Write-Output 'COMBINED_BROWSER_ACCEPTED_REBOOT_RECOVERY_NOT_YET_VERIFIED'
}
function Rollback {
  AssertOwner
  $answer=Read-Host 'Type exactly: ROLLBACK COMBINED EDGE BROWSER'
  Assert ($answer -ceq 'ROLLBACK COMBINED EDGE BROWSER') 'OWNER_ROLLBACK_APPROVAL_MISSING'
  RestoreOriginal
  CleanupPreparedTasks
  if(Test-Path -LiteralPath $Receipt -PathType Leaf){
    Remove-Item -LiteralPath $Receipt -Force -ErrorAction Stop
  }
  $watch=Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction SilentlyContinue
  if($watch){Unregister-ScheduledTask -TaskName $WatchdogTask -Confirm:$false -ErrorAction Stop}
  Log 'MANUAL_ROLLBACK_AGENT_CDP_RESTORED'
}
try{
  switch($Mode){
    'SelfTest'{SelfTest;break}
    'Preflight'{Write-Output ((Preflight)|ConvertTo-Json -Depth 3);break}
    'Apply'{Apply;break}
    'Accept'{Accept;break}
    'Rollback'{Rollback;break}
    'AutoRollback'{AutoRollback;break}
  }
}catch{
  Write-Error ('OWNER_COMBINED_BROWSER_'+$_.Exception.Message)
  exit 1
}
