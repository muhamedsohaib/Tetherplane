<#
.SYNOPSIS
  Controlled automatic-recovery acceptance test for a previously installed
  Vaulter task-owned bounded relay supervisor.
.DESCRIPTION
  Read-only by default. -Exercise deliberately terminates only the verified
  relay Node child and requires a healthy NEW Node+original-launcher process
  beneath the SAME supervisor, with the auth listener and task unchanged.
  Failure invokes the independently verified original-action rollback.
  Never use this before a completed source/CI and maintenance gate.
#>
[CmdletBinding()]
param([switch]$Exercise)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$script:TaskName='Tetherplane Relay'
$script:StateDir=Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:StageDir=Join-Path $script:StateDir 'relay-supervisor'
$script:SupervisorPath=Join-Path $script:StageDir 'vaulter-relay-bounded-supervisor.ps1'
$script:ProtectedBaseline=Join-Path $script:StageDir 'pre-supervisor-task.xml'
$script:OriginalLauncherHash='5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8'
$script:BaselineXml=''
$script:BaselineChain=$null
$script:AuthPid=0
$script:Postcheck=Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1'
$script:Handover=Join-Path $PSScriptRoot 'vaulter-relay-supervisor-handover.ps1'

function Assert-Rehearsal([bool]$condition,[string]$reason){
  if(-not $condition){throw $reason}
}
function Get-Task {
  Get-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
}
function Get-TaskXml {
  [string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop)
}
function Get-AuthPid {
  $listen=@(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)
  Assert-Rehearsal ($listen.Count -eq 1 -and $listen[0].LocalAddress -ceq '127.0.0.1') 'Private authorization service listener changed.'
  return [int]$listen[0].OwningProcess
}
function Assert-SupervisedTask {
  $task=Get-Task
  Assert-Rehearsal ($task.State -eq 'Running' -and [bool]$task.Settings.Enabled -and
    [string]$task.Principal.LogonType -ceq 'Interactive' -and
    [int]$task.Settings.RestartCount -eq 10 -and
    [string]$task.Settings.RestartInterval -ceq 'PT1M' -and
    [string]$task.Settings.MultipleInstances -ceq 'IgnoreNew' -and
    @($task.Actions).Count -eq 1) 'Supervised relay task not running as registered.'
  [xml]$prior=[IO.File]::ReadAllText($script:ProtectedBaseline)
  $exe=$prior.SelectSingleNode("//*[local-name()='Actions']/*[local-name()='Exec']/*[local-name()='Command']")
  Assert-Rehearsal ($null -ne $exe -and [string]$task.Actions[0].Execute -ieq [string]$exe.InnerText) 'Original PowerShell executable changed.'
  $expected='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:SupervisorPath+'" -Serve'
  Assert-Rehearsal ([string]$task.Actions[0].Arguments -ceq $expected) 'Task action no longer invokes protected bounded supervisor.'
  Assert-Rehearsal ((Get-TaskXml) -ceq $script:BaselineXml) 'Supervised task registration changed during recovery test.'
}
function Read-VerifiedChain {
  $listen=@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
  Assert-Rehearsal ($listen.Count -eq 1 -and $listen[0].LocalAddress -ceq '127.0.0.1') 'Relay listener unavailable or not loopback-only.'
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listen[0].OwningProcess) -ErrorAction Stop
  Assert-Rehearsal ($null -ne $node -and $node.Name -ieq 'node.exe') 'Relay listener owner is not Node.'
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
  Assert-Rehearsal ($null -ne $parent -and $parent.Name -ieq 'powershell.exe') 'Relay node parent mismatch.'
  $supervisor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId) -ErrorAction Stop
  Assert-Rehearsal ($null -ne $supervisor -and $supervisor.Name -ieq 'powershell.exe' -and
    [string]$supervisor.CommandLine -like ('*'+$script:SupervisorPath+'*')) 'Node does not descend from protected supervisor.'
  [xml]$originalXml=[IO.File]::ReadAllText($script:ProtectedBaseline)
  $arguments=[string]$originalXml.SelectSingleNode(
    "//*[local-name()='Actions']/*[local-name()='Exec']/*[local-name()='Arguments']").InnerText
  $m=[regex]::Match($arguments,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
  Assert-Rehearsal ($m.Success) 'Original runner path missing.'
  $runner=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value) |
    Where-Object {$_} | Select-Object -First 1
  Assert-Rehearsal ([string]$parent.CommandLine -like ('*'+$runner+'*') -and
    (Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash -ceq $script:OriginalLauncherHash) 'Original trusted launcher no longer owns relay.'
  return [pscustomobject]@{
    NodePid=[int]$node.ProcessId
    NodeCreated=[string]$node.CreationDate
    ParentPid=[int]$parent.ProcessId
    ParentCreated=[string]$parent.CreationDate
    SupervisorPid=[int]$supervisor.ProcessId
    SupervisorCreated=[string]$supervisor.CreationDate
  }
}
function Test-Health {
  try {
    $relay=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 7 -ErrorAction Stop
    $auth=Invoke-RestMethod -Uri 'http://127.0.0.1:8790/healthz' -TimeoutSec 7 -ErrorAction Stop
    $public=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/healthz' -TimeoutSec 10 -ErrorAction Stop
    $resource=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/.well-known/oauth-protected-resource/mcp' -TimeoutSec 10 -ErrorAction Stop
    return ($relay.status -ceq 'ok' -and $auth.status -ceq 'ok' -and $public.status -ceq 'ok' -and
      @($resource.authorization_servers).Count -eq 1 -and
      @($resource.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/')
  }catch{return $false}
}
function Assert-Baseline {
  Assert-Rehearsal ($env:OS -eq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'Vaulter') 'Vaulter-only test.'
  foreach($dir in @($script:StateDir,$script:StageDir)){
    Assert-Rehearsal (Test-Path -LiteralPath $dir -PathType Container) 'Protected supervisor installation absent.'
    Assert-Rehearsal ((Get-Acl -LiteralPath $dir).AreAccessRulesProtected) 'Protected supervisor state ACL modified.'
  }
  foreach($path in @($script:SupervisorPath,$script:ProtectedBaseline,$script:Postcheck,$script:Handover)){
    Assert-Rehearsal (Test-Path -LiteralPath $path -PathType Leaf) 'Verified runtime or recovery script unavailable.'
  }
  $manifestFile=Join-Path $script:StageDir 'manifest.json'
  $manifest=Get-Content -LiteralPath $manifestFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  Assert-Rehearsal (
    (Get-FileHash -LiteralPath $script:SupervisorPath -Algorithm SHA256).Hash -ceq [string]$manifest.SourceSha256 -and
    (Get-FileHash -LiteralPath $script:ProtectedBaseline -Algorithm SHA256).Hash -ceq [string]$manifest.TaskSha256
  ) 'Protected installed supervisor or original task hash mismatch.'
  $script:BaselineXml=Get-TaskXml
  Assert-SupervisedTask
  $script:BaselineChain=Read-VerifiedChain
  $script:AuthPid=Get-AuthPid
  Assert-Rehearsal (Test-Health) 'Supervised relay/Auth0 baseline unhealthy.'
  & $script:Postcheck | Out-Null
}
function Assert-TargetUnchanged {
  Assert-SupervisedTask
  $current=Read-VerifiedChain
  Assert-Rehearsal (
    $current.NodePid -eq $script:BaselineChain.NodePid -and
    $current.NodeCreated -ceq $script:BaselineChain.NodeCreated -and
    $current.ParentPid -eq $script:BaselineChain.ParentPid -and
    $current.ParentCreated -ceq $script:BaselineChain.ParentCreated -and
    $current.SupervisorPid -eq $script:BaselineChain.SupervisorPid -and
    $current.SupervisorCreated -ceq $script:BaselineChain.SupervisorCreated -and
    (Get-AuthPid) -eq $script:AuthPid -and
    (Test-Health)
  ) 'Relay task process or auth baseline changed; fault injection refused.'
}
function Test-NewNodeUnderSameSupervisor {
  try {
    Assert-SupervisedTask
    $current=Read-VerifiedChain
    if($current.NodePid -eq $script:BaselineChain.NodePid -or
      $current.NodeCreated -ceq $script:BaselineChain.NodeCreated -or
      $current.ParentPid -eq $script:BaselineChain.ParentPid -or
      $current.ParentCreated -ceq $script:BaselineChain.ParentCreated -or
      $current.SupervisorPid -ne $script:BaselineChain.SupervisorPid -or
      $current.SupervisorCreated -cne $script:BaselineChain.SupervisorCreated){
      return $false
    }
    return ((Get-AuthPid) -eq $script:AuthPid -and (Test-Health))
  }catch{return $false}
}
function Wait-Recovered {
  $deadline=[DateTime]::UtcNow.AddSeconds(120)
  while([DateTime]::UtcNow -lt $deadline){
    if(Test-NewNodeUnderSameSupervisor){return}
    Start-Sleep -Seconds 2
  }
  throw 'Supervised replacement was not healthy under the same supervisor within 120 seconds.'
}
function Invoke-VerifiedSupervisedRecovery {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][hashtable]$Operations)
  foreach($name in @('VerifyBefore','VerifyTarget','InjectCrash','WaitAutomatic','Rollback','VerifyOriginal')){
    if(-not $Operations.ContainsKey($name) -or $Operations[$name] -isnot [scriptblock]){
      throw 'Missing controlled supervised recovery operation.'
    }
  }
  & $Operations['VerifyBefore']
  & $Operations['VerifyTarget']
  & $Operations['InjectCrash']
  try{
    & $Operations['WaitAutomatic']
    return 'automatic'
  }catch{
    try{
      & $Operations['Rollback']
      & $Operations['VerifyOriginal']
    }catch{
      throw 'SUPERVISED RELAY ROLLBACK UNVERIFIED. Do not inject another fault, reboot, or change routes.'
    }
    throw 'SUPERVISED RELAY AUTOMATIC RECOVERY UNVERIFIED. ORIGINAL AUTH0 TASK ROLLED BACK AND VERIFIED.'
  }
}

Assert-Baseline
if(-not $Exercise){
  Write-Output 'SUPERVISED RELAY RECOVERY PREFLIGHT PASS: same supervisor ownership, protected source and backup, Auth0 and public/private health verified.'
  Write-Output 'NO CHANGES MADE. -Exercise requires separately verified live maintenance approval.'
  return
}
$operations=@{
  VerifyBefore={Assert-SupervisedTask;Assert-TargetUnchanged}
  VerifyTarget={Assert-TargetUnchanged}
  InjectCrash={
    Assert-TargetUnchanged
    # Terminate ONLY the exact observed, revalidated task-owned Node process.
    Stop-Process -Id $script:BaselineChain.NodePid -Force -ErrorAction Stop
  }
  WaitAutomatic={Wait-Recovered}
  Rollback={
    & $script:Handover -Rollback
    if($LASTEXITCODE -ne 0){throw 'Independent rollback script reported failure.'}
  }
  VerifyOriginal={
    & $script:Postcheck | Out-Null
  }
}
$result=Invoke-VerifiedSupervisedRecovery -Operations $operations
Assert-Rehearsal ($result -ceq 'automatic' -and
  (Test-NewNodeUnderSameSupervisor)) 'Posttransaction automatic replacement not verified.'
& $script:Postcheck | Out-Null
Write-Output 'SUPERVISED RELAY AUTOMATIC RECOVERY VERIFIED: replacement Node and launcher under unchanged supervisor; original Auth0, JWKS, Funnel and private ports preserved.'
