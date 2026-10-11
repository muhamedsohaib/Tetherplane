<#
.SYNOPSIS
  Guarded source-managed staging, action-only activation and rollback to the
  ALREADY SUPERVISED Auth0 relay on Vaulter. Default inspection changes nothing.
.DESCRIPTION
  -Stage never interrupts services. -Apply and -Rollback are separate explicit
  maintenance actions. The previous unsupervised relay action is NOT a rollback
  target. Never print task arguments, tokens, private config or keys.
#>
[CmdletBinding(DefaultParameterSetName='Inspect')]
param(
  [Parameter(ParameterSetName='Stage')][switch]$Stage,
  [Parameter(ParameterSetName='Stage')][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedSourceCommit,
  [Parameter(ParameterSetName='Stage')][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSupervisorSha256,
  [Parameter(ParameterSetName='Stage')][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedBridgeLauncherSha256,
  [Parameter(ParameterSetName='Stage')][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedBridgeHelperSha256,
  [Parameter(ParameterSetName='Stage')][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedHandoverSha256,
  [Parameter(ParameterSetName='Stage')][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedNodeSha256,
  [Parameter(ParameterSetName='Stage')][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedEntrypointSha256,
  [Parameter(ParameterSetName='Stage')][string]$NodeExecutablePath,
  [Parameter(ParameterSetName='Stage')][string]$RelayEntrypointPath,
  [Parameter(ParameterSetName='Stage')][string]$AuthConfigPath,
  [Parameter(ParameterSetName='Stage')][string]$BaselineAuthConfigPath,
  [Parameter(ParameterSetName='Stage')][string]$StateFilePath,
  [Parameter(ParameterSetName='Apply')][switch]$Apply,
  [Parameter(ParameterSetName='Rollback')][switch]$Rollback
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$script:TaskName='Tetherplane Relay'
$script:StateDir=Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:StageDir=Join-Path $script:StateDir 'relay-supervisor-bridge'
$script:OriginalSupervisorDir=Join-Path $script:StateDir 'relay-supervisor'
$script:OriginalSupervisor=Join-Path $script:OriginalSupervisorDir 'vaulter-relay-bounded-supervisor.ps1'
$script:Snapshot=Join-Path $script:StageDir 'pre-supervisor-task.xml'
$script:Manifest=Join-Path $script:StageDir 'manifest.json'
$script:Supervisor=Join-Path $script:StageDir 'vaulter-relay-bounded-supervisor.ps1'
$script:Launcher=Join-Path $script:StageDir 'vaulter-relay-bridge-launcher.ps1'
$script:Helper=Join-Path $script:StageDir 'vaulter-relay-supervised-bridge-child.ps1'
$script:InstalledHandover=Join-Path $script:StageDir 'vaulter-relay-supervised-bridge-handover.ps1'
$script:BridgeConfig=Join-Path $script:StageDir 'bridge-child.json'
$script:OriginalSupervisorHash='439954167F3D3C68F5323D2EB2F97BAE7E2F6CD7C812B2CF4EF052C9DE78BA1D'
$script:TrustedLauncherHash='5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8'
$script:BaselineXml=''
$script:AuthPID=0
$script:RelayPID=0
$script:RepoPath=''
$script:Postcheck=''
function Require([bool]$ok,[string]$reason){if(-not $ok){throw $reason}}
function Get-Task {Get-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop}
function Get-TaskXml {[string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop)}
function Test-BridgeActionOnlyChanged {
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
function Invoke-GuardedBridgeHandover {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][hashtable]$Operations)
  foreach($step in @('VerifyBefore','StopAuth0','VerifyVacant','RegisterBridge',
    'StartBridge','VerifyBridge','RestoreAuth0','StartAuth0','VerifyAuth0')){
    if(-not $Operations.ContainsKey($step) -or $Operations[$step] -isnot [scriptblock]){
      throw 'Missing guarded bridge handover step.'
    }
  }
  & $Operations['VerifyBefore']
  try{
    & $Operations['StopAuth0']
    & $Operations['VerifyVacant']
    & $Operations['RegisterBridge']
    & $Operations['StartBridge']
    & $Operations['VerifyBridge']
    return 'activated'
  }catch{
    try{
      & $Operations['RestoreAuth0']
      & $Operations['StartAuth0']
      & $Operations['VerifyAuth0']
    }catch{
      throw 'BRIDGE HANDOVER ROLLBACK UNVERIFIED. Stop; inspect protected task and listener.'
    }
    throw 'BRIDGE HANDOVER FAILED; ORIGINAL SUPERVISED AUTH0 RELAY ROLLED BACK AND VERIFIED.'
  }
}
function Assert-FileHash([string]$path,[string]$sha){
  Require (Test-Path -LiteralPath $path -PathType Leaf) 'Protected source or runtime file missing.'
  Require (-not ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'File reparse point rejected.'
  Require ($sha -match '^[A-Fa-f0-9]{64}$') 'Expected SHA256 is invalid or absent.'
  Require ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ceq $sha.ToUpperInvariant()) 'Protected source or runtime digest mismatch.'
}
function Test-ApprovedBridgeAcl {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)]$Acl,
    [Parameter(Mandatory=$true)][Security.Principal.SecurityIdentifier]$CurrentSid
  )
  try{
    if(-not [bool]$Acl.AreAccessRulesProtected){return $false}
    $allowed=@($CurrentSid.Value,'S-1-5-18','S-1-5-32-544','S-1-3-0')
    $owner=[string]$Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($allowed -cnotcontains $owner){return $false}
    $rules=@($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    foreach($ace in $rules){
      if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow){
        $sid=[string]$ace.IdentityReference.Value
        if($allowed -cnotcontains $sid){return $false}
      }
    }
    return $true
  }catch{return $false}
}
function Assert-Directory([string]$path){
  Require (Test-Path -LiteralPath $path -PathType Container) 'Required private directory missing.'
  Require (-not ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Directory reparse point rejected.'
  $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
  Require (Test-ApprovedBridgeAcl -Acl $acl -CurrentSid $current) 'Protected stage owner or allowed ACL principal differs from reviewed private baseline.'
}
function Get-ListenerPID([int]$port){
  $listeners=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  Require ($listeners.Count -eq 1 -and [string]$listeners[0].LocalAddress -ceq '127.0.0.1') 'Expected single loopback listener missing.'
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop
  Require ($null -ne $p -and $p.Name -ieq 'node.exe') 'Loopback listener not owned by Node.'
  return [int]$p.ProcessId
}
function Assert-TaskSettings {
  $task=Get-Task
  Require ([bool]$task.Settings.Enabled -and
    [string]$task.Principal.LogonType -ceq 'Interactive' -and
    [string]$task.Settings.MultipleInstances -ceq 'IgnoreNew' -and
    [int]$task.Settings.RestartCount -eq 10 -and
    [string]$task.Settings.RestartInterval -ceq 'PT1M' -and
    @($task.Actions).Count -eq 1) 'Task settings no longer match verified supervised baseline.'
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try{
    $owner=[Security.Principal.NTAccount]::new([string]$task.Principal.UserId)
    if([string]$task.Principal.UserId -match '^S-\d-\d+(?:-\d+)+$'){
      $sid=[Security.Principal.SecurityIdentifier]::new([string]$task.Principal.UserId)
    }else{$sid=$owner.Translate([Security.Principal.SecurityIdentifier])}
    Require ($sid.Value -ceq $identity.User.Value) 'Task owner and protected-state owner differ.'
  }catch{throw 'Task principal cannot be independently resolved to current protected-state owner.'}
}
function Get-OriginalAction {
  [xml]$xml=$script:BaselineXml
  $exec=$xml.SelectSingleNode("//*[local-name()='Actions']/*[local-name()='Exec']")
  Require ($null -ne $exec) 'Protected supervisor task action missing.'
  $command=$exec.SelectSingleNode("*[local-name()='Command']")
  $args=$exec.SelectSingleNode("*[local-name()='Arguments']")
  $cwd=$exec.SelectSingleNode("*[local-name()='WorkingDirectory']")
  Require ($null -ne $command -and $null -ne $args) 'Protected task executable or flags missing.'
  $trustedPsExe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $execute=[string]$command.InnerText
  Require ($execute -ieq 'powershell.exe' -or $execute -ieq $trustedPsExe) 'Original supervised task executable is not trusted PowerShell.'
  $expected='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:OriginalSupervisor+'" -Serve'
  Require ([string]$args.InnerText -ceq $expected) 'Protected rollback is not the already-supervised Auth0 action.'
  return [pscustomobject]@{
    Execute=$execute
    Arguments=$expected
    WorkingDirectory=if($null -eq $cwd){''}else{[string]$cwd.InnerText}
  }
}
function Get-BridgeArgs {
  '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:Supervisor+'" -Serve -Bridge'
}
function Test-TaskIsAuth0 {
  $task=Get-Task
  $a=Get-OriginalAction
  return (@($task.Actions).Count -eq 1 -and
    [string]$task.Actions[0].Execute -ieq $a.Execute -and
    [string]$task.Actions[0].Arguments -ceq $a.Arguments -and
    [string]$task.Actions[0].WorkingDirectory -ceq $a.WorkingDirectory)
}
function Test-TaskIsBridge {
  $task=Get-Task
  $a=Get-OriginalAction
  return (@($task.Actions).Count -eq 1 -and
    [string]$task.Actions[0].Execute -ieq $a.Execute -and
    [string]$task.Actions[0].Arguments -ceq (Get-BridgeArgs) -and
    [string]$task.Actions[0].WorkingDirectory -ceq $a.WorkingDirectory)
}
function Set-OnlyBridgeAction([switch]$ToBridge){
  $a=Get-OriginalAction
  $args=if($ToBridge){Get-BridgeArgs}else{$a.Arguments}
  $new=if([string]::IsNullOrWhiteSpace($a.WorkingDirectory)){
    New-ScheduledTaskAction -Execute $a.Execute -Argument $args
  }else{
    New-ScheduledTaskAction -Execute $a.Execute -Argument $args -WorkingDirectory $a.WorkingDirectory
  }
  Set-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -Action $new -ErrorAction Stop | Out-Null
  Require (Test-BridgeActionOnlyChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Task principal, trigger or settings changed.'
  Assert-TaskSettings
}
function Assert-OriginalSupervisor {
  Assert-Directory $script:OriginalSupervisorDir
  Assert-FileHash $script:OriginalSupervisor $script:OriginalSupervisorHash
  Require ((Get-Task).State -eq 'Running') 'Original supervised Auth0 task not running.'
  Assert-TaskSettings
  Require ((Get-TaskXml) -ceq $script:BaselineXml) 'Current task XML does not match original supervised snapshot.'
  Require (Test-TaskIsAuth0) 'Registered task no longer owns original Auth0 supervisor.'
  Assert-Directory $script:StateDir
  $checkpoint=Join-Path $script:StateDir 'relay-pre-bridge-b8afcfe768964e8786a5c229b866ea8d'
  Assert-Directory $checkpoint
  Assert-FileHash (Join-Path $checkpoint 'launcher.ps1') $script:TrustedLauncherHash
  $relay=Get-ListenerPID 8788
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+$relay)
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId)
  Require ($null -ne $parent -and $parent.Name -ieq 'powershell.exe') 'Original relay child launcher ownership missing.'
  $grandparent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId)
  Require ($null -ne $grandparent -and $grandparent.Name -ieq 'powershell.exe' -and
    ([string]$grandparent.CommandLine).IndexOf($script:OriginalSupervisor,[StringComparison]::OrdinalIgnoreCase) -ge 0) 'Relay not owned by original bounded supervisor.'
}
function Assert-BridgeListener {
  $relay=Get-ListenerPID 8788
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+$relay)
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId)
  Require ($null -ne $parent -and $parent.Name -ieq 'powershell.exe' -and
    ([string]$parent.CommandLine).IndexOf($script:Launcher,[StringComparison]::OrdinalIgnoreCase) -ge 0) 'Bridge relay not descended from reviewed native launcher.'
  $grandparent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent.ParentProcessId)
  Require ($null -ne $grandparent -and $grandparent.Name -ieq 'powershell.exe' -and
    ([string]$grandparent.CommandLine).IndexOf($script:Supervisor,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    ([string]$grandparent.CommandLine).Contains(' -Serve -Bridge')) 'Bridge relay not task-owned by protected bounded supervisor.'
}
function Assert-PinnedPostcheck {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$RepoRoot,
    [Parameter(Mandatory=$true)][string]$ExpectedPostcheckSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedRunnerIntegritySha256
  )
  Require ([IO.Path]::IsPathRooted($RepoRoot) -and
    (Test-Path -LiteralPath $RepoRoot -PathType Container)) 'Reviewed source root for postcheck missing.'
  $folder=Join-Path $RepoRoot 'scripts'
  $postcheck=Join-Path $folder 'vaulter-tether-auth-supervised-postcheck.ps1'
  $validator=Join-Path $folder 'vaulter-tether-auth-runner-integrity.ps1'
  Assert-FileHash $postcheck $ExpectedPostcheckSha256
  Assert-FileHash $validator $ExpectedRunnerIntegritySha256
  return $postcheck
}
# Run an independently pinned postcheck under the same narrow process-only
# execution-policy override used by Vaulter's proven supervised staging.
# Never modify Process, CurrentUser, LocalMachine or GroupPolicy settings.
function Invoke-PinnedPostcheck {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Path)
  if(-not(Test-Path -LiteralPath $Path -PathType Leaf) -or
     (Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
    throw 'Pinned postcheck source unavailable or is a reparse point.'
  }
  $trustedExe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if(-not(Test-Path -LiteralPath $trustedExe -PathType Leaf) -or
     (Get-Item -LiteralPath $trustedExe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
    throw 'Trusted Windows PowerShell executable for postcheck unavailable.'
  }
  # Suppress postcheck script stdout/stderr; never disclose private metadata
  # or key contents through a deployment health check.
  & $trustedExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Path 1>$null 2>$null
  $code=[int]$LASTEXITCODE
  if($code -ne 0){
    throw ('Independent pinned postcheck failed with exit code '+$code+'.')
  }
}
function Assert-Postcheck {
  $meta=Get-Content -LiteralPath $script:Manifest -Raw -ErrorAction Stop |
    ConvertFrom-Json -ErrorAction Stop
  $script:Postcheck=Assert-PinnedPostcheck -RepoRoot ([string]$meta.SourceRepo) -ExpectedPostcheckSha256 ([string]$meta.PostcheckSha256) -ExpectedRunnerIntegritySha256 ([string]$meta.RunnerIntegritySha256)
  Invoke-PinnedPostcheck -Path $script:Postcheck
  Require ((Get-ListenerPID 8790) -eq $script:AuthPID) 'Authorization process identity changed.'
  $resource=Invoke-RestMethod 'https://vaulter.tailf65eba.ts.net/.well-known/oauth-protected-resource/mcp' -TimeoutSec 15
  Require (@($resource.authorization_servers).Count -eq 1 -and
    @($resource.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Auth0 issuer changed.'
}
function Assert-StagedFiles {
  Assert-Directory $script:StateDir
  Assert-Directory $script:StageDir
  $manifest=Get-Content -LiteralPath $script:Manifest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  foreach($item in @(
    @{Path=$script:Supervisor;Hash=[string]$manifest.SupervisorSha256},
    @{Path=$script:Launcher;Hash=[string]$manifest.BridgeLauncherSha256},
    @{Path=$script:Helper;Hash=[string]$manifest.BridgeHelperSha256},
    @{Path=$script:InstalledHandover;Hash=[string]$manifest.HandoverSha256},
    @{Path=$script:Snapshot;Hash=[string]$manifest.TaskSha256},
    @{Path=$script:BridgeConfig;Hash=[string]$manifest.BridgeConfigSha256}
  )){Assert-FileHash -path $item.Path -sha $item.Hash}
  $paths=Get-Content -LiteralPath $script:BridgeConfig -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  Assert-FileHash ([string]$paths.AuthConfigPath) ([string]$manifest.AuthConfigSha256)
  Assert-FileHash ([string]$paths.BaselineAuthConfigPath) ([string]$manifest.BaselineAuthConfigSha256)
  $null=Assert-PinnedPostcheck -RepoRoot ([string]$manifest.SourceRepo) -ExpectedPostcheckSha256 ([string]$manifest.PostcheckSha256) -ExpectedRunnerIntegritySha256 ([string]$manifest.RunnerIntegritySha256)
  [IO.File]::ReadAllText($script:Snapshot)
}
function Wait-ReadyVacant {
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while([DateTime]::UtcNow -lt $deadline){
    if((Get-Task).State -eq 'Ready' -and
      @(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue).Count -eq 0){return}
    Start-Sleep -Milliseconds 400
  }
  throw 'Relay task is not Ready with a proven vacant port 8788.'
}
function Wait-Healthy([switch]$Bridge){
  $deadline=[DateTime]::UtcNow.AddSeconds(90)
  while([DateTime]::UtcNow -lt $deadline){
    try{
      if((Get-Task).State -eq 'Running'){
        if($Bridge){Assert-BridgeListener}else{Assert-OriginalSupervisor}
        Assert-Postcheck
        return
      }
    }catch{}
    Start-Sleep -Seconds 2
  }
  throw 'Task-owned healthy relay was not independently verified within 90 seconds.'
}
function Restore-Auth0Safely {
  $task=Get-Task
  if(Test-TaskIsBridge){
    if($task.State -eq 'Running'){
      $live=@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
      if($live.Count -gt 0){Assert-BridgeListener}
      Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
      Wait-ReadyVacant
    }else{
      Require ($task.State -eq 'Ready') 'Unexpected task state during rollback.'
      Require (@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue).Count -eq 0) 'Rollback port conflict.'
    }
    Set-OnlyBridgeAction
  }elseif(-not (Test-TaskIsAuth0)){
    throw 'Rollback refused because registered action is unknown.'
  }
}
function Start-Auth0Safely {
  Require (Test-TaskIsAuth0) 'Original supervised Auth0 task action not restored.'
  $task=Get-Task
  if($task.State -eq 'Ready'){
    Require (@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue).Count -eq 0) 'Original restart refused due to port occupancy.'
    Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
  }else{
    Require ($task.State -eq 'Running') 'Restored original task is not startable.'
  }
}
function Assert-BridgeCandidate([string]$candidate,[string]$baseline){
  $a=Get-Content -LiteralPath $candidate -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  $b=Get-Content -LiteralPath $baseline -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  Require ($null -ne $a.PSObject.Properties['oidc'] -and $null -ne $b.PSObject.Properties['oidc'] -and
    ($a.oidc | ConvertTo-Json -Depth 32 -Compress) -ceq ($b.oidc | ConvertTo-Json -Depth 32 -Compress) -and
    [string]$a.oidc.issuer -ceq 'https://tetherplane-dev.eu.auth0.com/' -and
    $null -ne $a.PSObject.Properties['deviceLoginBridge'] -and
    [string]$a.deviceLoginBridge.tokenEnv -ceq 'TETHERPLANE_AUTH_BRIDGE_TOKEN') 'Bridge candidate Auth0 bindings or enabled bridge declaration changed.'
}
function Assert-StageInput([string]$path){Require ([IO.Path]::IsPathRooted($path) -and
  (Test-Path -LiteralPath $path -PathType Leaf) -and
  -not ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Untrusted staging runtime path.'}
Require ($env:COMPUTERNAME -ieq 'Vaulter' -and $env:OS -eq 'Windows_NT') 'Vaulter-only guarded bridge handover.'
Assert-Directory $script:StateDir
if($Stage){
  foreach($value in @($ExpectedSourceCommit,$ExpectedSupervisorSha256,$ExpectedBridgeLauncherSha256,
      $ExpectedBridgeHelperSha256,$ExpectedHandoverSha256,$ExpectedNodeSha256,$ExpectedEntrypointSha256,
      $NodeExecutablePath,$RelayEntrypointPath,$AuthConfigPath,$BaselineAuthConfigPath,$StateFilePath)){
    Require (-not [string]::IsNullOrWhiteSpace([string]$value)) 'Stage requires all reviewed source pins and actual runtime paths.'
  }
  Require (-not(Test-Path -LiteralPath $script:StageDir)) 'Bridge protected stage already exists; refuse overwrite.'
  $sourceRoot=Split-Path -Parent $PSScriptRoot
  $head=@(& git -C $sourceRoot rev-parse HEAD)
  Require ($LASTEXITCODE -eq 0 -and $head.Count -eq 1 -and
    $head[0] -ceq $ExpectedSourceCommit) 'Bridge staging requires exact reviewed source commit.'
  $dirty=@(& git -C $sourceRoot status --porcelain=v1 --untracked-files=all)
  Require ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'Bridge staging worktree is not clean.'
  $supervisorSource=Join-Path $PSScriptRoot 'vaulter-relay-bounded-supervisor.ps1'
  $launcherSource=Join-Path $PSScriptRoot 'vaulter-relay-bridge-launcher.ps1'
  $helperSource=Join-Path $PSScriptRoot 'vaulter-relay-supervised-bridge-child.ps1'
  Assert-FileHash $supervisorSource $ExpectedSupervisorSha256
  Assert-FileHash $launcherSource $ExpectedBridgeLauncherSha256
  Assert-FileHash $helperSource $ExpectedBridgeHelperSha256
  Assert-FileHash $PSCommandPath $ExpectedHandoverSha256
  foreach($path in @($NodeExecutablePath,$RelayEntrypointPath,$AuthConfigPath,$BaselineAuthConfigPath,$StateFilePath)){Assert-StageInput $path}
  Require ([IO.Path]::GetFileName($NodeExecutablePath) -ieq 'node.exe') 'Staging requires real Node executable.'
  Assert-FileHash $NodeExecutablePath $ExpectedNodeSha256
  Assert-FileHash $RelayEntrypointPath $ExpectedEntrypointSha256
  Assert-BridgeCandidate $AuthConfigPath $BaselineAuthConfigPath
  $script:BaselineXml=Get-TaskXml
  Assert-OriginalSupervisor
  $script:AuthPID=Get-ListenerPID 8790
  $script:RelayPID=Get-ListenerPID 8788
  $script:Postcheck=Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1'
  Invoke-PinnedPostcheck -Path $script:Postcheck
  New-Item -ItemType Directory -Path $script:StageDir -ErrorAction Stop | Out-Null
  $acl=Get-Acl -LiteralPath $script:StageDir
  $acl.SetAccessRuleProtection($true,$true)
  Set-Acl -LiteralPath $script:StageDir -AclObject $acl -ErrorAction Stop
  Assert-Directory $script:StageDir
  Copy-Item -LiteralPath $supervisorSource -Destination $script:Supervisor -ErrorAction Stop
  Copy-Item -LiteralPath $launcherSource -Destination $script:Launcher -ErrorAction Stop
  Copy-Item -LiteralPath $helperSource -Destination $script:Helper -ErrorAction Stop
  Copy-Item -LiteralPath $PSCommandPath -Destination $script:InstalledHandover -ErrorAction Stop
  [IO.File]::WriteAllText($script:Snapshot,$script:BaselineXml,[Text.UTF8Encoding]::new($false))
  $config=[ordered]@{
    NodeExecutablePath=$NodeExecutablePath
    NodeExecutableSha256=$ExpectedNodeSha256.ToUpperInvariant()
    RelayEntrypointPath=$RelayEntrypointPath
    ExpectedEntrypointSha256=$ExpectedEntrypointSha256.ToUpperInvariant()
    AuthConfigPath=$AuthConfigPath
    BaselineAuthConfigPath=$BaselineAuthConfigPath
    StateFilePath=$StateFilePath
  }|ConvertTo-Json -Compress
  [IO.File]::WriteAllText($script:BridgeConfig,[string]$config,[Text.UTF8Encoding]::new($false))
  $manifest=[ordered]@{
    ReviewedCommit=$ExpectedSourceCommit
    SourceRepo=$sourceRoot
    PostcheckSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1') -Algorithm SHA256).Hash
    RunnerIntegritySha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'vaulter-tether-auth-runner-integrity.ps1') -Algorithm SHA256).Hash
    SupervisorSha256=$ExpectedSupervisorSha256.ToUpperInvariant()
    BridgeLauncherSha256=$ExpectedBridgeLauncherSha256.ToUpperInvariant()
    BridgeHelperSha256=$ExpectedBridgeHelperSha256.ToUpperInvariant()
    HandoverSha256=$ExpectedHandoverSha256.ToUpperInvariant()
    BridgeConfigSha256=(Get-FileHash -LiteralPath $script:BridgeConfig -Algorithm SHA256).Hash
    AuthConfigSha256=(Get-FileHash -LiteralPath $AuthConfigPath -Algorithm SHA256).Hash
    BaselineAuthConfigSha256=(Get-FileHash -LiteralPath $BaselineAuthConfigPath -Algorithm SHA256).Hash
    TaskSha256=(Get-FileHash -LiteralPath $script:Snapshot -Algorithm SHA256).Hash
  }|ConvertTo-Json -Compress
  [IO.File]::WriteAllText($script:Manifest,[string]$manifest,[Text.UTF8Encoding]::new($false))
  $null=Assert-StagedFiles
  Require ((Get-TaskXml) -ceq $script:BaselineXml) 'Original supervised task changed during bridge staging.'
  Require ((Get-ListenerPID 8790) -eq $script:AuthPID -and
    (Get-ListenerPID 8788) -eq $script:RelayPID) 'Service process identity changed during stage.'
  Invoke-PinnedPostcheck -Path $script:Postcheck
  Write-Output 'BRIDGE PROTECTED STAGE VERIFIED: original task and Auth0 relay untouched; source and rollback protected.'
  return
}
if(-not $Stage -and -not $Apply -and -not $Rollback){
  Require ((Get-Task).State -eq 'Running') 'Read-only preflight expects a running task.'
  $task=Get-Task
  $script:BaselineXml=Get-TaskXml
  if(Test-Path -LiteralPath $script:StageDir){
    $script:BaselineXml=Assert-StagedFiles
    Require (Test-BridgeActionOnlyChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Task drifted beyond allowed action.'
    Write-Output 'BRIDGE HANDOVER READ-ONLY PREFLIGHT: protected stage present, task action-only baseline preserved.'
  }else{
    Assert-OriginalSupervisor
    Write-Output 'BRIDGE HANDOVER READ-ONLY PREFLIGHT: verified original Auth0 supervisor; bridge stage absent.'
  }
  Write-Output 'NO CHANGES MADE. -Stage, -Apply and -Rollback require separate explicit invocation.'
  return
}
$script:BaselineXml=Assert-StagedFiles
$manifest=Get-Content -LiteralPath $script:Manifest -Raw | ConvertFrom-Json
Require ([IO.Path]::GetFullPath($PSCommandPath) -ieq [IO.Path]::GetFullPath($script:InstalledHandover)) 'Only protected installed bridge handover may activate or roll back.'
$script:RepoPath=[string]$manifest.SourceRepo
$script:Postcheck=Join-Path $script:RepoPath 'scripts\vaulter-tether-auth-supervised-postcheck.ps1'
Require (Test-Path -LiteralPath $script:Postcheck -PathType Leaf) 'Independent postcheck missing; no action change.'
Require (Test-BridgeActionOnlyChanged -BeforeXml $script:BaselineXml -AfterXml (Get-TaskXml)) 'Task settings, triggers or principal changed from protected stage.'
$script:AuthPID=Get-ListenerPID 8790
Assert-TaskSettings
if($Apply){
  Require ((Get-Task).State -eq 'Running' -and
    (Get-TaskXml) -ceq $script:BaselineXml -and (Test-TaskIsAuth0)) 'Apply requires exact original supervised Auth0 task.'
  Assert-OriginalSupervisor
  Assert-Postcheck
  $ops=@{
    VerifyBefore={Require ((Get-TaskXml) -ceq $script:BaselineXml -and (Test-TaskIsAuth0)) 'Concurrent task mutation; bridge activation refused.';Assert-OriginalSupervisor}
    StopAuth0={Stop-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop}
    VerifyVacant={Wait-ReadyVacant}
    RegisterBridge={Set-OnlyBridgeAction -ToBridge}
    StartBridge={Require (Test-TaskIsBridge) 'Bridge task action was not registered.';Start-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop}
    VerifyBridge={Require (Test-TaskIsBridge) 'Unrecognized task action after bridge activation.';Wait-Healthy -Bridge}
    RestoreAuth0={Restore-Auth0Safely}
    StartAuth0={Start-Auth0Safely}
    VerifyAuth0={Require ((Get-TaskXml) -ceq $script:BaselineXml) 'Original supervised task XML not restored.';Wait-Healthy}
  }
  $result=Invoke-GuardedBridgeHandover -Operations $ops
  Require ($result -ceq 'activated') 'Bridge handover returned an unexpected state.'
  Write-Output 'BRIDGE SUPERVISED ACTIVATION VERIFIED: bounded supervisor remains task-owned; Auth0 issuer preserved.'
  Write-Output 'DEVICE ROUTING AND AUTOMATIC BRIDGE RECOVERY REMAIN UNVERIFIED.'
  return
}
if($Rollback){
  Require (Test-TaskIsBridge -or (Test-TaskIsAuth0)) 'Unknown relay task action; guarded rollback refused.'
  Restore-Auth0Safely
  Start-Auth0Safely
  Require ((Get-TaskXml) -ceq $script:BaselineXml) 'Rollback did not restore exact original supervised XML.'
  Wait-Healthy
  Write-Output 'BRIDGE ROLLBACK VERIFIED: restored original BOUNDED Auth0 supervisor, not unsupervised launcher.'
  return
}
throw 'Unknown protected bridge handover mode.'
