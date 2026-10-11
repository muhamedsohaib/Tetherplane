<#
.SYNOPSIS
  Read-only, bounded Vaulter relay task and process ancestry snapshot.
.DESCRIPTION
  Reports whether the existing Auth0 relay is owned by the ORIGINAL protected
  bounded supervisor. A healthy HTTP response alone never proves supervision.
  Never prints process arguments, task XML, secret paths, credentials or tokens.
  Does not repair, restart, register or otherwise change any resources.
#>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

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

function Test-RelayProcessAncestry {
  [CmdletBinding()]
  param(
    $Node,$Launcher,$Supervisor,
    [int]$ListenerOwnerPid,
    [string]$ExpectedLauncherPath,
    [string]$ExpectedSupervisorPath
  )
  try{
    if($null -eq $Node -or $null -eq $Launcher -or $null -eq $Supervisor -or
       $ListenerOwnerPid -le 0 -or
       -not[IO.Path]::IsPathRooted($ExpectedLauncherPath) -or
       -not[IO.Path]::IsPathRooted($ExpectedSupervisorPath)){return $false}
    if([string]$Node.Name -ine 'node.exe' -or
       [string]$Launcher.Name -ine 'powershell.exe' -or
       [string]$Supervisor.Name -ine 'powershell.exe' -or
       [int]$Node.ProcessId -ne $ListenerOwnerPid -or
       [int]$Node.ParentProcessId -ne [int]$Launcher.ProcessId -or
       [int]$Launcher.ParentProcessId -ne [int]$Supervisor.ProcessId){return $false}
    if([datetime]$Supervisor.CreationDate -gt [datetime]$Launcher.CreationDate -or
       [datetime]$Launcher.CreationDate -gt [datetime]$Node.CreationDate){
      return $false
    }
    $launcherPath=Get-ProcessFileArgument -CommandLine ([string]$Launcher.CommandLine)
    $supervisorPath=Get-ProcessFileArgument -CommandLine ([string]$Supervisor.CommandLine)
    if([string]::IsNullOrWhiteSpace($launcherPath) -or
       [string]::IsNullOrWhiteSpace($supervisorPath) -or
       -not[IO.Path]::IsPathRooted($launcherPath) -or
       -not[IO.Path]::IsPathRooted($supervisorPath)){return $false}
    if(-not [string]::Equals([IO.Path]::GetFullPath($launcherPath),
         [IO.Path]::GetFullPath($ExpectedLauncherPath),
         [StringComparison]::OrdinalIgnoreCase) -or
       -not [string]::Equals([IO.Path]::GetFullPath($supervisorPath),
         [IO.Path]::GetFullPath($ExpectedSupervisorPath),
         [StringComparison]::OrdinalIgnoreCase)){return $false}
    if(([string]$Supervisor.CommandLine) -notmatch '(?i)\s-Serve\s*$' -or
       ([string]$Supervisor.CommandLine) -match
         '(?i)(?:^|\s)-(?:Bridge|EncodedCommand|EncodedArguments|Command)(?=\s|$)'){
      return $false
    }
    return $true
  }catch{return $false}
}

function Get-SupervisionVerdict {
  [CmdletBinding()]
  param(
    [string]$TaskState,
    [bool]$ActionVerified,
    [bool]$StageVerified,
    [bool]$LoopbackVerified,
    [bool]$AncestryVerified,
    [bool]$RelayHealthy,
    [bool]$AuthHealthy,
    [bool]$IssuerVerified
  )
  if($TaskState -cne 'Running'){
    if($LoopbackVerified){return 'TASK_INACTIVE_LISTENER_PRESENT'}
    return 'OWNERSHIP_UNVERIFIED'
  }
  if(-not $RelayHealthy -or -not $AuthHealthy -or -not $IssuerVerified){
    return 'HEALTH_NOT_VERIFIED'
  }
  if(-not($ActionVerified -and $StageVerified -and $LoopbackVerified -and
     $AncestryVerified)){
    return 'OWNERSHIP_UNVERIFIED'
  }
  return 'SUPERVISED_AUTH0_VERIFIED'
}

function Test-OrdinaryFile([string]$Path,[switch]$Directory){
  try{
    if(-not [IO.Path]::IsPathRooted($Path)){return $false}
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){return $false}
    if($Directory){return [bool]$item.PSIsContainer}
    return [bool](-not $item.PSIsContainer)
  }catch{return $false}
}

function Get-ProtectedSupervisorEvidence([string]$StateDirectory){
  $absent=[pscustomobject]@{Valid=$false;SupervisorPath='';LauncherPath='';
    OriginalExecutable='';OriginalWorkingDirectory='';ExpectedAction=''}
  try{
    $stage=Join-Path $StateDirectory 'relay-supervisor'
    $exe=Join-Path $stage 'vaulter-relay-bounded-supervisor.ps1'
    $snapshot=Join-Path $stage 'pre-supervisor-task.xml'
    $manifestPath=Join-Path $stage 'manifest.json'
    $oldCopy=Join-Path $StateDirectory 'relay-pre-bridge-b8afcfe768964e8786a5c229b866ea8d\launcher.ps1'
    foreach($folder in @($StateDirectory,$stage)){
      if(-not(Test-OrdinaryFile -Path $folder -Directory) -or
         -not(Get-Acl -LiteralPath $folder -ErrorAction Stop).AreAccessRulesProtected){
        return $absent
      }
    }
    foreach($file in @($exe,$snapshot,$manifestPath,$oldCopy)){
      if(-not(Test-OrdinaryFile -Path $file)){return $absent}
    }
    $manifest=Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop|
      ConvertFrom-Json -ErrorAction Stop
    foreach($hash in @([string]$manifest.SourceSha256,[string]$manifest.TaskSha256)){
      if($hash -notmatch '^[A-Fa-f0-9]{64}$'){return $absent}
    }
    if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ine
       [string]$manifest.SourceSha256 -or
       (Get-FileHash -LiteralPath $snapshot -Algorithm SHA256).Hash -ine
       [string]$manifest.TaskSha256){return $absent}
    $trustedOriginalHash='5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8'
    if((Get-FileHash -LiteralPath $oldCopy -Algorithm SHA256).Hash -cne
       $trustedOriginalHash){return $absent}
    [xml]$xml=Get-Content -LiteralPath $snapshot -Raw -ErrorAction Stop
    $action=@($xml.SelectNodes("//*[local-name()='Actions']/*"))
    if($action.Count -ne 1 -or $action[0].LocalName -cne 'Exec'){return $absent}
    $cmd=$action[0].SelectSingleNode("*[local-name()='Command']")
    $args=$action[0].SelectSingleNode("*[local-name()='Arguments']")
    if($null -eq $cmd -or $null -eq $args){return $absent}
    $originalExe=[string]$cmd.InnerText
    $trustedPs=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if($originalExe -ine 'powershell.exe' -and $originalExe -ine $trustedPs){
      return $absent
    }
    $launcher=Get-ProcessFileArgument -CommandLine ([string]$args.InnerText)
    if(-not(Test-OrdinaryFile -Path $launcher) -or
       (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -cne
         $trustedOriginalHash){return $absent}
    $working=$action[0].SelectSingleNode("*[local-name()='WorkingDirectory']")
    return [pscustomobject]@{
      Valid=$true
      SupervisorPath=$exe
      LauncherPath=$launcher
      OriginalExecutable=$originalExe
      OriginalWorkingDirectory=if($null -eq $working){''}else{[string]$working.InnerText}
      ExpectedAction='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$exe+'" -Serve'
    }
  }catch{return $absent}
}

function Test-JsonHealth([string]$Url,[string]$Expected='ok'){
  try{
    $body=Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 6 -ErrorAction Stop
    return [bool]([string]$body.status -ceq $Expected)
  }catch{return $false}
}
function Test-UnchangedIssuer {
  try{
    $resource=Invoke-RestMethod -Method Get -Uri 'https://vaulter.tailf65eba.ts.net/.well-known/oauth-protected-resource/mcp' -TimeoutSec 8 -ErrorAction Stop
    return [bool](@($resource.authorization_servers).Count -eq 1 -and
      [string]@($resource.authorization_servers)[0] -ceq
      'https://tetherplane-dev.eu.auth0.com/')
  }catch{return $false}
}

function Get-VaulterSupervisionSnapshot {
  if($env:OS -ne 'Windows_NT' -or $env:COMPUTERNAME -ine 'Vaulter'){
    throw 'Read-only supervision snapshot must execute on Vaulter.'
  }
  $state=Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
  $trusted=Get-ProtectedSupervisorEvidence -StateDirectory $state
  $taskState='UNKNOWN'
  $actionValid=$false
  try{
    $task=Get-ScheduledTask -TaskName 'Tetherplane Relay' -TaskPath '\' -ErrorAction Stop
    $taskState=[string]$task.State
    if($trusted.Valid){
      $trigger=@($task.Triggers|Where-Object{
        $_.CimClass.CimClassName -match 'LogonTrigger$'
      })
      $actionValid=[bool](
        @($task.Actions).Count -eq 1 -and
        [string]$task.Actions[0].Execute -ieq $trusted.OriginalExecutable -and
        [string]$task.Actions[0].Arguments -ceq $trusted.ExpectedAction -and
        [string]$task.Actions[0].WorkingDirectory -ceq $trusted.OriginalWorkingDirectory -and
        [bool]$task.Settings.Enabled -and
        [string]$task.Principal.LogonType -ceq 'Interactive' -and
        [string]$task.Settings.MultipleInstances -ceq 'IgnoreNew' -and
        [int]$task.Settings.RestartCount -eq 10 -and
        [string]$task.Settings.RestartInterval -ceq 'PT1M' -and
        $trigger.Count -gt 0)
    }
  }catch{}
  $loopback=$false
  $ancestry=$false
  try{
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction Stop)
    if($listeners.Count -eq 1 -and
       [string]$listeners[0].LocalAddress -ceq '127.0.0.1' -and
       [int]$listeners[0].OwningProcess -gt 0){
      $loopback=$true
      if($trusted.Valid){
        $pidValue=[int]$listeners[0].OwningProcess
        $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue) -ErrorAction Stop
        $launcher=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$node.ParentProcessId) -ErrorAction Stop
        $supervisor=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$launcher.ParentProcessId) -ErrorAction Stop
        $ancestry=Test-RelayProcessAncestry -Node $node -Launcher $launcher -Supervisor $supervisor -ListenerOwnerPid $pidValue -ExpectedLauncherPath $trusted.LauncherPath -ExpectedSupervisorPath $trusted.SupervisorPath
      }
    }
  }catch{}
  $localRelay=Test-JsonHealth -Url 'http://127.0.0.1:8788/healthz'
  $publicRelay=Test-JsonHealth -Url 'https://vaulter.tailf65eba.ts.net/healthz'
  $publicReady=Test-JsonHealth -Url 'https://vaulter.tailf65eba.ts.net/readyz' -Expected 'ready'
  $relayHealthy=[bool]($localRelay -and $publicRelay -and $publicReady)
  $authHealthy=Test-JsonHealth -Url 'http://127.0.0.1:8790/healthz'
  $issuer=Test-UnchangedIssuer
  $verdict=Get-SupervisionVerdict -TaskState $taskState -ActionVerified $actionValid -StageVerified ([bool]$trusted.Valid) -LoopbackVerified $loopback -AncestryVerified $ancestry -RelayHealthy $relayHealthy -AuthHealthy $authHealthy -IssuerVerified $issuer
  return [ordered]@{
    probe='VAULTER_RELAY_SUPERVISION_PREFLIGHT_V1'
    machine='Vaulter'
    task_state=$taskState
    protected_supervisor_stage_verified=[bool]$trusted.Valid
    exact_supervisor_task_action_verified=$actionValid
    relay_listener_loopback_only=$loopback
    task_owned_process_chain_verified=$ancestry
    local_and_public_relay_healthy=$relayHealthy
    auth_healthy=$authHealthy
    auth0_issuer_unchanged=$issuer
    supervisor_verdict=$verdict
    no_changes_made=$true
    recovery_authorized=$false
    guidance='Healthy endpoints cannot replace verified supervision. Do not restart, terminate or activate before approved recovery preflight.'
  }
}

if($MyInvocation.InvocationName -ne '.'){
  try{
    $report=Get-VaulterSupervisionSnapshot
    $report|ConvertTo-Json -Depth 5
  }catch{
    Write-Error 'VAULTER SUPERVISION PREFLIGHT UNAVAILABLE: run read-only inspection only on an authorized Vaulter session.'
    exit 1
  }
}
