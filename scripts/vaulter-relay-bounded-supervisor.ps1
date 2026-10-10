<#
.SYNOPSIS
  Fail-closed, bounded Windows relay supervisor for Vaulter.
.DESCRIPTION
  Inspection is read-only by default. -Serve is permitted only when the
  registered Tetherplane Relay task explicitly owns this protected script.
  It executes the exact ORIGINAL PowerShell task action preserved in the
  private pre-bridge checkpoint; neither native arguments nor credentials
  are reconstructed or printed. Unexpected exits (including exit 0) restart
  with bounded exponential backoff. A registered intentional task stop
  prevents further launches. This does not activate the device-login bridge.
#>
[CmdletBinding()]
param([switch]$Serve)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$script:TaskName='Tetherplane Relay'
$script:StateDir=Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:BackupDir=Join-Path $script:StateDir 'relay-pre-bridge-b8afcfe768964e8786a5c229b866ea8d'
$script:SupervisorDir=Join-Path $script:StateDir 'relay-supervisor'
$script:TrustedLauncherSha256='5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8'
$script:OriginalAction=$null
$script:ExpectedRegisteredTaskXml=''

function Assert-Supervisor([bool]$Condition,[string]$Reason){
  if(-not $Condition){throw $Reason}
}

function Get-SupervisorOriginalAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Xml)
  [xml]$doc=$Xml
  $actions=@($doc.SelectNodes("//*[local-name()='Actions']/*"))
  Assert-Supervisor ($actions.Count -eq 1 -and $actions[0].LocalName -ceq 'Exec') 'Original task has an unexpected action structure.'
  $cmd=$actions[0].SelectSingleNode("*[local-name()='Command']")
  $args=$actions[0].SelectSingleNode("*[local-name()='Arguments']")
  Assert-Supervisor ($null -ne $cmd -and $null -ne $args) 'Original task action command or arguments missing.'
  $exe=[string]$cmd.InnerText
  $rawArgs=[string]$args.InnerText
  Assert-Supervisor ([IO.Path]::IsPathRooted($exe) -and
    [IO.Path]::GetFileName($exe) -ieq 'powershell.exe') 'Original action executable is not absolute Windows PowerShell.'
  Assert-Supervisor (@([regex]::Matches($rawArgs,'(?i)(?:^|\s)-File(?=\s)')).Count -eq 1 -and
    $rawArgs -notmatch '(?i)(?:^|\s)-(?:EncodedCommand|EncodedArguments|Command)(?=\s|$)') 'Original command contains an unsafe or ambiguous command mode.'
  $m=[regex]::Match($rawArgs,
    '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))(?=\s|$)')
  Assert-Supervisor ($m.Success) 'Original launcher -File path is missing.'
  $runner=(@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value) |
    Where-Object {-not [string]::IsNullOrWhiteSpace($_)} | Select-Object -First 1)
  Assert-Supervisor ([IO.Path]::IsPathRooted([string]$runner) -and
    [IO.Path]::GetExtension([string]$runner) -ieq '.ps1' -and
    [string]::IsNullOrWhiteSpace($rawArgs.Substring($m.Index+$m.Length))) 'Original launcher path or trailing task arguments unexpected.'
  return [pscustomobject]@{
    Executable=$exe
    Arguments=$rawArgs
    LauncherPath=[string]$runner
  }
}

function Start-VerifiedOriginalRelayChild {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)]$Action)
  # No shell interpolation, no copied secrets, no reconstructed CLI flags.
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=[string]$Action.Executable
  $psi.Arguments=[string]$Action.Arguments
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $child=New-Object System.Diagnostics.Process
  $child.StartInfo=$psi
  $started=[DateTime]::UtcNow
  try {
    if(-not $child.Start()){throw 'Original task action did not start.'}
    # Only the exactly spawned child is waited upon. No human process killed.
    $child.WaitForExit()
    return [pscustomobject]@{
      ExitCode=[int]$child.ExitCode
      DurationSeconds=[double]([DateTime]::UtcNow-$started).TotalSeconds
    }
  } finally {
    $child.Dispose()
  }
}

function Invoke-BoundedRelaySupervisor {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][hashtable]$Operations,
    [ValidateRange(1,12)][int]$MaxRestarts=6,
    [ValidateRange(1,30)][int]$BaseDelaySeconds=2,
    [ValidateRange(1,120)][int]$MaxDelaySeconds=30,
    [ValidateRange(30,86400)][int]$ResetAfterSeconds=300
  )
  foreach($name in @('ShouldStop','AssertOwnership','AssertPortVacant','StartAndWaitChild','Sleep')){
    Assert-Supervisor ($Operations.ContainsKey($name) -and
      $Operations[$name] -is [scriptblock]) 'Incomplete bounded supervisor operation set.'
  }
  $consecutiveFailures=0
  while($true){
    if([bool](& $Operations['ShouldStop'])){return 'stopped'}
    & $Operations['AssertOwnership']
    & $Operations['AssertPortVacant']
    $result=& $Operations['StartAndWaitChild']
    Assert-Supervisor ($null -ne $result -and
      $null -ne $result.PSObject.Properties['ExitCode'] -and
      $null -ne $result.PSObject.Properties['DurationSeconds'] -and
      [double]$result.DurationSeconds -ge 0) 'Original launcher returned an invalid result.'
    if([bool](& $Operations['ShouldStop'])){return 'stopped'}
    # Even exit code 0 is unexpected for an always-on relay unless stopped.
    if([double]$result.DurationSeconds -ge $ResetAfterSeconds){$consecutiveFailures=0}
    $consecutiveFailures++
    if($consecutiveFailures -gt $MaxRestarts){
      throw 'RELAY SUPERVISOR RESTART BUDGET EXHAUSTED; no more child launches. Check task and health.'
    }
    $backoff=[int][Math]::Min([double]$MaxDelaySeconds,
      [double]$BaseDelaySeconds*[Math]::Pow(2,$consecutiveFailures-1))
    & $Operations['Sleep'] $backoff
  }
}

function Get-Task {
  Get-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop
}
function Assert-TaskBaseline {
  $task=Get-Task
  Assert-Supervisor ($task.State -eq 'Running' -and [bool]$task.Settings.Enabled -and
    [string]$task.Principal.LogonType -ceq 'Interactive' -and
    [string]$task.Settings.MultipleInstances -ceq 'IgnoreNew' -and
    [int]$task.Settings.RestartCount -eq 10 -and
    [string]$task.Settings.RestartInterval -ceq 'PT1M' -and
    @($task.Actions).Count -eq 1) 'Running interactive relay task settings differ from baseline.'
  Assert-Supervisor (@($task.Triggers | Where-Object {
    $_.CimClass.CimClassName -match 'LogonTrigger$'
  }).Count -ge 1) 'Relay task logon trigger missing.'
  return $task
}
function Assert-PrivateCheckpoint {
  foreach($folder in @($script:StateDir,$script:BackupDir)){
    Assert-Supervisor (Test-Path -LiteralPath $folder -PathType Container) 'Protected original relay checkpoint missing.'
    Assert-Supervisor ((Get-Acl -LiteralPath $folder -ErrorAction Stop).AreAccessRulesProtected) 'Original relay checkpoint ACL not protected.'
  }
  $launcherCopy=Join-Path $script:BackupDir 'launcher.ps1'
  $taskBackup=Join-Path $script:BackupDir 'relay-task.xml'
  foreach($file in @($launcherCopy,$taskBackup)){
    Assert-Supervisor (Test-Path -LiteralPath $file -PathType Leaf) 'Original relay backup file missing.'
    Assert-Supervisor (-not ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Protected backup must not be a reparse point.'
  }
  Assert-Supervisor ((Get-FileHash -LiteralPath $launcherCopy -Algorithm SHA256).Hash -ceq $script:TrustedLauncherSha256) 'Original rollback launcher copy hash changed.'
  $original=Get-SupervisorOriginalAction -Xml ([IO.File]::ReadAllText($taskBackup))
  Assert-Supervisor (Test-Path -LiteralPath $original.Executable -PathType Leaf) 'Original PowerShell executable not found.'
  Assert-Supervisor (Test-Path -LiteralPath $original.LauncherPath -PathType Leaf) 'Original live launcher missing.'
  Assert-Supervisor (-not ((Get-Item -LiteralPath $original.LauncherPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Original launcher reparse point refused.'
  Assert-Supervisor ((Get-FileHash -LiteralPath $original.LauncherPath -Algorithm SHA256).Hash -ceq $script:TrustedLauncherSha256) 'Original registered launcher hash changed.'
  return $original
}
function Assert-TaskAction {
  $task=Assert-TaskBaseline
  $execute=[string]$task.Actions[0].Execute
  $arguments=[string]$task.Actions[0].Arguments
  if(-not $Serve){
    Assert-Supervisor ($execute -ieq $script:OriginalAction.Executable -and
      $arguments -ceq $script:OriginalAction.Arguments) 'Original registered task action does not match trusted checkpoint.'
  }else{
    $installed=Join-Path $script:SupervisorDir 'vaulter-relay-bounded-supervisor.ps1'
    Assert-Supervisor (Test-Path -LiteralPath $installed -PathType Leaf) 'Protected installed supervisor unavailable.'
    Assert-Supervisor (-not ((Get-Item -LiteralPath $installed -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Protected supervisor reparse point refused.'
    Assert-Supervisor ((Get-Acl -LiteralPath $script:SupervisorDir).AreAccessRulesProtected) 'Supervisor install directory ACL not protected.'
    Assert-Supervisor ([IO.Path]::GetFullPath($PSCommandPath) -ieq [IO.Path]::GetFullPath($installed)) 'Only protected installed supervisor may run as task.'
    Assert-Supervisor ($execute -ieq $script:OriginalAction.Executable -and
      $arguments.IndexOf($installed,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $arguments -match '(?i)(?:^|\s)-Serve(?:\s|$)') 'Task action does not point to the installed supervisor in Serve mode.'
  }
}
function Assert-RegistrationUnchanged {
  Assert-Supervisor (([string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop)) -ceq
    $script:ExpectedRegisteredTaskXml) 'Registered relay task XML changed while supervised.'
  Assert-TaskAction
}
function Assert-PortVacant {
  Assert-Supervisor (@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue).Count -eq 0) 'Relay port 8788 occupied; a second relay is forbidden.'
}

Assert-Supervisor ($env:OS -eq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'Vaulter') 'Vaulter-only supervised operation.'
$script:OriginalAction=Assert-PrivateCheckpoint
Assert-TaskAction
if(-not $Serve){
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
  Assert-Supervisor ($listeners.Count -eq 1 -and
    [string]$listeners[0].LocalAddress -ceq '127.0.0.1') 'Original relay listener not exclusively loopback.'
  $health=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 10 -ErrorAction Stop
  Assert-Supervisor ($health.status -ceq 'ok') 'Original Auth0 relay baseline unhealthy.'
  Write-Output 'RELAY SUPERVISOR PREFLIGHT PASS: original task action, launcher hash, protected checkpoint, registered settings, loopback service.'
  Write-Output 'NO CHANGES MADE. Installing or activating the supervisor requires a separate guarded handover.'
  return
}

# Only a registered task-owned instance may enter this branch.
$script:ExpectedRegisteredTaskXml=[string](Export-ScheduledTask -TaskPath '\' -TaskName $script:TaskName -ErrorAction Stop)
Assert-PortVacant
$mutex=New-Object System.Threading.Mutex($false,'Local\TetherplaneVaulterRelaySupervisor')
$ownsMutex=$false
try {
  try {
    $ownsMutex=$mutex.WaitOne(0)
  }catch [System.Threading.AbandonedMutexException] {
    $ownsMutex=$true
  }
  Assert-Supervisor $ownsMutex 'Another relay supervisor already owns the single-instance lease.'
  $operations=@{
    ShouldStop={
      $t=Get-Task
      return ($t.State -ne 'Running' -or -not [bool]$t.Settings.Enabled)
    }
    AssertOwnership={Assert-RegistrationUnchanged}
    AssertPortVacant={Assert-PortVacant}
    StartAndWaitChild={Start-VerifiedOriginalRelayChild -Action $script:OriginalAction}
    Sleep={param([int]$seconds) Start-Sleep -Seconds $seconds}
  }
  Write-Output 'RELAY SUPERVISOR STARTED: bounded original Auth0 launcher supervision; no bridge or issuer changes.'
  $outcome=Invoke-BoundedRelaySupervisor -Operations $operations
  if($outcome -cne 'stopped'){throw 'Unrecognized supervisor exit state.'}
  Write-Output 'RELAY SUPERVISOR STOPPED: no further child launches.'
}finally{
  if($ownsMutex){$mutex.ReleaseMutex()}
  $mutex.Dispose()
}
