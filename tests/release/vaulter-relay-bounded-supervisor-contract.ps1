# Synthetic Windows relay supervision contract. No registered task or service touched.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-bounded-supervisor.ps1'
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'RED: bounded relay supervisor source absent.'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'Supervisor PowerShell parse errors.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($required in @(
  '[switch]$Serve','COMPUTERNAME','Vaulter','Tetherplane Relay',
  'Get-ScheduledTask','Export-ScheduledTask','MultipleInstances',
  'relay-pre-bridge-b8afcfe768964e8786a5c229b866ea8d',
  '5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8',
  'AreAccessRulesProtected','Get-FileHash','Get-NetTCPConnection',
  'Get-SupervisorOriginalAction','Start-VerifiedOriginalRelayChild',
  'Invoke-BoundedRelaySupervisor','ProcessStartInfo','WaitForExit',
  'Mutex','MaxRestarts','ResetAfterSeconds','Sleep','ShouldStop',
  'NO CHANGES MADE','RELAY SUPERVISOR PREFLIGHT PASS'
)){
  if(-not $source.Contains($required)){throw "Supervisor missing safety/behavior guard: $required"}
}
if($source -match '(?i)\b(?:Stop-Process|Stop-ScheduledTask|Start-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask|Set-Clipboard)\b'){
  throw 'Supervisor cannot kill a process, mutate a task, or alter clipboard.'
}
if($source -match '(?i)(?:gh auth token|TETHERPLANE_AUTH_BRIDGE_TOKEN|bridge-token.secret|tailscale\s+(?:funnel|serve)\s+(?:off|reset|--set-path))'){
  throw 'Auth bridge secrets and Funnel mutations not allowed in original Auth0 supervisor.'
}
foreach($helper in @('Assert-Supervisor','Get-SupervisorOriginalAction','Start-VerifiedOriginalRelayChild','Invoke-BoundedRelaySupervisor')){
  $node=$ast.Find({
    param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $helper
  }.GetNewClosure(),$true)
  if($null -eq $node){throw "RED: missing supervisor function $helper"}
  Invoke-Expression $node.Extent.Text
}
$psExe=(Get-Command powershell.exe -ErrorAction Stop).Source
$xml='<Task><Actions><Exec><Command>'+[Security.SecurityElement]::Escape($psExe)+
  '</Command><Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;C:\staged\relay.ps1&quot;</Arguments></Exec></Actions></Task>'
$action=Get-SupervisorOriginalAction -Xml $xml
if([string]$action.Executable -cne $psExe -or [string]$action.LauncherPath -cne 'C:\staged\relay.ps1'){
  throw 'Original launcher action was not preserved exactly.'
}
$xmlWithCwd=$xml.Replace('</Arguments>','</Arguments><WorkingDirectory>C:\trusted-working-directory</WorkingDirectory>')
$withCwd=Get-SupervisorOriginalAction -Xml $xmlWithCwd
if($withCwd.WorkingDirectory -cne 'C:\trusted-working-directory'){
  throw 'RED: original Scheduled Task working-directory semantics were dropped.'
}
if($action.WorkingDirectory -cne ''){
  throw 'Original action without explicit working directory should inherit the task working directory.'
}
foreach($broken in @(
  $xml.Replace('powershell.exe','cmd.exe'),
  $xml.Replace('-File &quot;C:\staged\relay.ps1&quot;','-Command evil'),
  $xml.Replace('-File &quot;C:\staged\relay.ps1&quot;','-File &quot;C:\staged\relay.ps1&quot; -File evil.ps1'),
  $xml.Replace('relay.ps1','relay.txt'),
  '<Task><Actions/></Task>'
)){
  $rejected=$false
  try{Get-SupervisorOriginalAction -Xml $broken | Out-Null}catch{$rejected=$true}
  if(-not $rejected){throw 'Unsafe or ambiguous original task action accepted.'}
}
function New-Ops([int[]]$Durations,[int]$StopAt=0){
  $launches=New-Object 'System.Collections.Generic.List[int]'
  $sleeps=New-Object 'System.Collections.Generic.List[int]'
  $checks=New-Object 'System.Collections.Generic.List[string]'
  $ops=@{
    ShouldStop={return ($StopAt -gt 0 -and $launches.Count -ge $StopAt)}.GetNewClosure()
    AssertOwnership={$checks.Add('owned')}.GetNewClosure()
    AssertPortVacant={$checks.Add('vacant')}.GetNewClosure()
    StartAndWaitChild={
      $index=$launches.Count
      $launches.Add($index)
      $time=if($index -lt $Durations.Count){$Durations[$index]}else{0}
      return [pscustomobject]@{ExitCode=-1;DurationSeconds=$time}
    }.GetNewClosure()
    Sleep={param([int]$seconds)$sleeps.Add($seconds)}.GetNewClosure()
  }
  return @{Ops=$ops;Launches=$launches;Sleeps=$sleeps;Checks=$checks}
}
$f=New-Ops @(2,3,4,5)
$err=''
try{Invoke-BoundedRelaySupervisor -Operations $f.Ops -MaxRestarts 3 -BaseDelaySeconds 1 -MaxDelaySeconds 4 -ResetAfterSeconds 300 | Out-Null}catch{$err=$_.Exception.Message}
if($err -notmatch 'BUDGET EXHAUSTED' -or $f.Launches.Count -ne 4 -or
  ($f.Sleeps -join ',') -cne '1,2,4' -or $f.Checks.Count -ne 8){
  throw 'Supervisor must retry exactly three times with bounded exponential backoff.'
}
$f=New-Ops @(1,1,301,1,1) 5
$r=Invoke-BoundedRelaySupervisor -Operations $f.Ops -MaxRestarts 3 -BaseDelaySeconds 1 -MaxDelaySeconds 8 -ResetAfterSeconds 300
if($r -cne 'stopped' -or $f.Launches.Count -ne 5 -or ($f.Sleeps -join ',') -cne '1,2,1,2'){
  throw 'Stable runtime must reset crash budget; intentional stop must cease launches.'
}
$f=New-Ops @(1) 0
$f.Ops['AssertPortVacant']={throw 'another listener occupies port'}
$rejected=$false
try{Invoke-BoundedRelaySupervisor -Operations $f.Ops -MaxRestarts 2 | Out-Null}catch{$rejected=$true}
if(-not $rejected -or $f.Launches.Count -ne 0){throw 'Port conflict must prevent any child process.'}
$f=New-Ops @(10) 0
$f.Ops['AssertOwnership']={throw 'task ownership changed'}
$rejected=$false
try{Invoke-BoundedRelaySupervisor -Operations $f.Ops | Out-Null}catch{$rejected=$true}
if(-not $rejected -or $f.Launches.Count -ne 0){throw 'Owner mismatch must prevent launch.'}
$f=New-Ops @(1,1) 2
$f.Ops['StartAndWaitChild']={
  throw 'child spawn failed'
}
$rejected=$false
try{Invoke-BoundedRelaySupervisor -Operations $f.Ops | Out-Null}catch{$rejected=$true}
if(-not $rejected){throw 'Child spawn failure must fail closed.'}
# Real isolated child execution and exit-code propagation: never touches the actual relay.
$tmpDir=Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-supervisor-contract-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir -ErrorAction Stop | Out-Null
try {
  $fake=Join-Path $tmpDir 'fake-relay.ps1'
  [IO.File]::WriteAllText($fake,"exit 37")
  $result=Start-VerifiedOriginalRelayChild -Action ([pscustomobject]@{
    Executable=$psExe
    Arguments=('-NoProfile -NonInteractive -File "'+$fake+'"')
  })
  if([int]$result.ExitCode -ne 37 -or [double]$result.DurationSeconds -lt 0){
    throw 'Native child exit code was lost or elapsed time invalid.'
  }
  # Two genuine Windows PowerShell child processes exit with code 37;
  # the synthetic task owner stays running and verifies exactly one relaunch.
  $childLaunches=0
  $observedCodes=New-Object 'System.Collections.Generic.List[int]'
  $observedBackoff=New-Object 'System.Collections.Generic.List[int]'
  $childAction=[pscustomobject]@{
    Executable=$psExe
    Arguments=('-NoProfile -NonInteractive -File "'+$fake+'"')
  }
  # GetNewClosure uses a dynamic module; capture the tested helper explicitly.
  $spawnNative=${function:Start-VerifiedOriginalRelayChild}
  $realOps=@{
    ShouldStop={return ($childLaunches -ge 2)}.GetNewClosure()
    AssertOwnership={}
    AssertPortVacant={}
    StartAndWaitChild={
      $childLaunches++
      $run=& $spawnNative -Action $childAction
      $observedCodes.Add([int]$run.ExitCode)
      return $run
    }.GetNewClosure()
    Sleep={param([int]$seconds)$observedBackoff.Add($seconds)}.GetNewClosure()
  }
  $realOutcome=Invoke-BoundedRelaySupervisor -Operations $realOps -MaxRestarts 2 -BaseDelaySeconds 1 -MaxDelaySeconds 3
  if($realOutcome -cne 'stopped' -or $childLaunches -ne 2 -or
    ($observedCodes -join ',') -cne '37,37' -or
    ($observedBackoff -join ',') -cne '1'){
    throw 'Real child failures did not produce exactly one bounded automatic relaunch.'
  }
}finally{Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue}
Write-Output 'VAULTER BOUNDED RELAY SUPERVISOR CONTRACT PASS'
