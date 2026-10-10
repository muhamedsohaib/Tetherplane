# Vaulter relay bridge: guarded native Node launcher, read-only by default.
# The existing PowerShell launcher is never executed: it may reference the
# original Auth0 config and therefore ignore a staged bridge-enabled config.
# Live activation requires a separately reviewed Scheduled Task handover.
[CmdletBinding()]
param(
  [switch]$Serve,
  [switch]$Supervised,
  [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'),
  [Parameter(Mandatory=$true)][string]$NodeExecutablePath,
  [Parameter(Mandatory=$true)][string]$RelayEntrypointPath,
  [Parameter(Mandatory=$true)][string]$ExpectedEntrypointSha256,
  [Parameter(Mandatory=$true)][string]$AuthConfigPath,
  [Parameter(Mandatory=$true)][string]$BaselineAuthConfigPath,
  [Parameter(Mandatory=$true)][string]$StateFilePath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Explicit native child launch; the bridge secret alone cannot cause the old
# launcher to load a staged auth config. Bind the Node CLI arguments directly.
function Invoke-VerifiedNativeRelayProcess {
  [CmdletBinding()]
  param(
    [switch]$Serve,
    [Parameter(Mandatory=$true)][string]$StateDirectory,
    [Parameter(Mandatory=$true)][string]$NodeExecutablePath,
    [Parameter(Mandatory=$true)][string]$RelayEntrypointPath,
    [Parameter(Mandatory=$true)][string]$ExpectedEntrypointSha256,
    [Parameter(Mandatory=$true)][string]$AuthConfigPath,
    [Parameter(Mandatory=$true)][string]$BaselineAuthConfigPath,
    [Parameter(Mandatory=$true)][string]$StateFilePath
  )
  $envName = 'TETHERPLANE_AUTH_BRIDGE_TOKEN'
  if (-not (Test-Path -LiteralPath $StateDirectory -PathType Container) -or
      -not (Get-Acl -LiteralPath $StateDirectory -ErrorAction Stop).AreAccessRulesProtected) {
    throw 'Protected authorization state is unavailable.'
  }
  foreach ($file in @($NodeExecutablePath,$RelayEntrypointPath,$AuthConfigPath,$BaselineAuthConfigPath,$StateFilePath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw 'Required native relay runtime, configuration or registry is missing.'
    }
    if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'Native relay execution refused a reparse-point file.'
    }
  }
  if ([IO.Path]::GetFileName($NodeExecutablePath) -ine 'node.exe') {
    throw 'Relay native runtime must be node.exe.'
  }
  if ($ExpectedEntrypointSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      (Get-FileHash -LiteralPath $RelayEntrypointPath -Algorithm SHA256).Hash -cne
        $ExpectedEntrypointSha256.ToUpperInvariant()) {
    throw 'Native relay entrypoint differs from the pinned build.'
  }
  try {
    $cfg = Get-Content -LiteralPath $AuthConfigPath -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    $metadata = Get-Content -LiteralPath (Join-Path $StateDirectory 'tether-auth-config.json') -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    $baseline = Get-Content -LiteralPath $BaselineAuthConfigPath -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'Bridge deployment or candidate configuration could not be parsed.'
  }
  if ($null -eq $baseline.PSObject.Properties['oidc'] -or
      $null -eq $cfg.PSObject.Properties['oidc'] -or
      (($cfg.oidc | ConvertTo-Json -Depth 32 -Compress) -cne
       ($baseline.oidc | ConvertTo-Json -Depth 32 -Compress)) -or
      [string]$cfg.oidc.issuer -cne 'https://tetherplane-dev.eu.auth0.com/' -or
      [string]$cfg.oidc.audience -cne 'https://vaulter.tailf65eba.ts.net/mcp' -or
      $null -eq $cfg.oidc.PSObject.Properties['bindings'] -or
      @($cfg.oidc.bindings).Count -lt 1 -or
      @($cfg.oidc.scopes) -notcontains 'tetherplane:access' -or
      $null -eq $cfg.PSObject.Properties['deviceLoginBridge'] -or
      [string]$cfg.deviceLoginBridge.tokenEnv -cne $envName -or
      [string]$metadata.relay.bridgeTokenEnv -cne $envName) {
    throw 'Native relay candidate must preserve Auth0 bindings and declare the bridge.'
  }
  $secretFile = Join-Path $StateDirectory 'bridge-token.secret'
  if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf) -or
      (Get-Item -LiteralPath $secretFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Protected bridge credential is unavailable.'
  }
  if (-not $Serve) {
    Write-Output 'NATIVE RELAY BRIDGE PREFLIGHT PASS; NO SERVICE STARTED'
    return
  }
  $prior = [Environment]::GetEnvironmentVariable($envName,'Process')
  $secretValue = $null
  try {
    $secretValue = ([IO.File]::ReadAllText($secretFile)).Trim()
    if ($secretValue -notmatch '^[A-Za-z0-9_-]{64,}$') {
      throw 'Protected relay bridge credential is malformed.'
    }
    [Environment]::SetEnvironmentVariable($envName,$secretValue,'Process')
    $secretValue = $null
    $global:LASTEXITCODE = 0
    $arguments = @($RelayEntrypointPath,'--auth-config',$AuthConfigPath,'--state-file',
      $StateFilePath,'--host','127.0.0.1','--port','8788','--allow-insecure-localhost')
    & $NodeExecutablePath @arguments 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Native relay child exited unsuccessfully.' }
    Write-Output 'NATIVE RELAY CHILD EXIT PASS'
  } finally {
    $secretValue = $null
    if ($null -eq $prior) {
      Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($envName,$prior,'Process')
    }
  }
}


# Native child ownership is an independent gate: a matching argument string
# is insufficient without the registered task, real PID chain and task XML.
function Assert-SupervisedBridgeOwnership {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)]$SelfProcess,
    [Parameter(Mandatory=$true)]$ParentProcess,
    [Parameter(Mandatory=$true)]$Task,
    [Parameter(Mandatory=$true)][string]$OriginalTaskXml,
    [Parameter(Mandatory=$true)][string]$CurrentTaskXml,
    [Parameter(Mandatory=$true)][string]$SupervisorPath,
    [Parameter(Mandatory=$true)][string]$LauncherPath
  )
  $trusted=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if([string]$SelfProcess.Name -ine 'powershell.exe' -or
     [string]$ParentProcess.Name -ine 'powershell.exe' -or
     [int]$SelfProcess.ProcessId -le 0 -or
     [int]$ParentProcess.ProcessId -le 0 -or
     [int]$SelfProcess.ParentProcessId -ne [int]$ParentProcess.ProcessId -or
     [string]$SelfProcess.ExecutablePath -ine $trusted -or
     [string]$ParentProcess.ExecutablePath -ine $trusted -or
     $null -eq $SelfProcess.CreationDate -or
     $null -eq $ParentProcess.CreationDate -or
     [datetime]$ParentProcess.CreationDate -gt [datetime]$SelfProcess.CreationDate){
    throw 'Bridge native process is not a trusted PowerShell child of the supervisor.'
  }
  $expectedArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$SupervisorPath+'" -Serve -Bridge'
  $executablePattern='(?:"'+[regex]::Escape($trusted)+'"|'+[regex]::Escape($trusted)+'|powershell\.exe)'
  $parentPattern='(?i)^\s*'+$executablePattern+'\s+'+[regex]::Escape($expectedArgs)+'\s*
if ($Serve) {
  # Do not launch a second relay or bypass the registered task supervisor.
  $task = Get-ScheduledTask -TaskName 'Tetherplane Relay' -ErrorAction Stop
  if ($task.State -ne 'Running' -or -not [bool]$task.Settings.Enabled -or
      @($task.Actions).Count -ne 1) {
    throw 'Relay scheduled-task ownership not established.'
  }
  if($Supervised){
    $canonical=Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
    if([IO.Path]::GetFullPath($StateDirectory) -ine [IO.Path]::GetFullPath($canonical)){
      throw 'Supervised native launcher requires canonical private authorization state.'
    }
    $bridgeDir=Join-Path $canonical 'relay-supervisor-bridge'
    $supervisor=Join-Path $bridgeDir 'vaulter-relay-bounded-supervisor.ps1'
    $native=Join-Path $bridgeDir 'vaulter-relay-bridge-launcher.ps1'
    $snapshot=Join-Path $bridgeDir 'pre-supervisor-task.xml'
    $manifestPath=Join-Path $bridgeDir 'manifest.json'
    if(-not(Test-Path -LiteralPath $bridgeDir -PathType Container) -or
      -not (Get-Acl -LiteralPath $bridgeDir).AreAccessRulesProtected -or
      [IO.Path]::GetFullPath($PSCommandPath) -ine [IO.Path]::GetFullPath($native)){
      throw 'Native bridge launcher is outside the protected installation.'
    }
    foreach($file in @($supervisor,$native,$snapshot,$manifestPath)){
      if(-not(Test-Path -LiteralPath $file -PathType Leaf) -or
        (Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
        throw 'Protected bridge launcher source or rollback snapshot missing.'
      }
    }
    $manifest=Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    foreach($pin in @(
      @{Path=$supervisor;Field='SupervisorSha256'},
      @{Path=$native;Field='BridgeLauncherSha256'},
      @{Path=$snapshot;Field='TaskSha256'}
    )){
      $hash=[string]$manifest.($pin.Field)
      if($hash -notmatch '^[A-Fa-f0-9]{64}
  $occupied = @(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
  if ($occupied.Count -ne 0) {
    throw 'Relay port 8788 already has a listener; refusing duplicate process.'
  }
}
Invoke-VerifiedNativeRelayProcess -Serve:$Serve -StateDirectory $StateDirectory -NodeExecutablePath $NodeExecutablePath -RelayEntrypointPath $RelayEntrypointPath -ExpectedEntrypointSha256 $ExpectedEntrypointSha256 -AuthConfigPath $AuthConfigPath -BaselineAuthConfigPath $BaselineAuthConfigPath -StateFilePath $StateFilePath

  if(-not ([regex]::IsMatch([string]$ParentProcess.CommandLine,$parentPattern))){
    throw 'Supervisor parent command is not the exact protected bridge task action.'
  }
  $childPattern='(?i)^\s*'+$executablePattern+
    '\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"'+
    [regex]::Escape($LauncherPath)+'"\s+-Serve\s+-Supervised(?:\s|$)'
  if(-not ([regex]::IsMatch([string]$SelfProcess.CommandLine,$childPattern))){
    throw 'Native bridge launcher is not the protected supervised child.'
  }
  if([string]$Task.State -cne 'Running' -or
     -not [bool]$Task.Settings.Enabled -or
     [string]$Task.Settings.MultipleInstances -cne 'IgnoreNew' -or
     @($Task.Actions).Count -ne 1){
    throw 'Registered relay task is not the expected running single-instance supervisor.'
  }
  [xml]$prior=$OriginalTaskXml
  [xml]$current=$CurrentTaskXml
  $oldActions=$prior.SelectSingleNode("//*[local-name()='Actions']")
  $newActions=$current.SelectSingleNode("//*[local-name()='Actions']")
  $oldExec=$prior.SelectSingleNode("//*[local-name()='Actions']/*[local-name()='Exec']")
  if($null -eq $oldActions -or $null -eq $newActions -or $null -eq $oldExec){
    throw 'Protected task XML is malformed.'
  }
  $exe=$oldExec.SelectSingleNode("*[local-name()='Command']")
  $cwd=$oldExec.SelectSingleNode("*[local-name()='WorkingDirectory']")
  if($null -eq $exe){throw 'Protected task action executable missing.'}
  $oldExe=[string]$exe.InnerText
  $oldCwd=if($null -eq $cwd){''}else{[string]$cwd.InnerText}
  if(($oldExe -ine 'powershell.exe' -and $oldExe -ine $trusted) -or
     [string]$Task.Actions[0].Execute -ine $oldExe -or
     [string]$Task.Actions[0].Arguments -cne $expectedArgs -or
     [string]$Task.Actions[0].WorkingDirectory -cne $oldCwd){
    throw 'Task action differs from trusted original executable or bridge supervisor.'
  }
  $saved=$current.ImportNode($oldActions,$true)
  $null=$newActions.ParentNode.ReplaceChild($saved,$newActions)
  if($current.DocumentElement.OuterXml -cne $prior.DocumentElement.OuterXml){
    throw 'Task settings, account, triggers or working directory changed outside the action.'
  }
}

if ($env:COMPUTERNAME -ine 'VAULTER') { throw 'Vaulter only' }
if($Supervised -and -not $Serve){throw 'Supervised bridge child requires explicit Serve mode.'}
if ($Serve) {
  # Do not launch a second relay or bypass the registered task supervisor.
  $task = Get-ScheduledTask -TaskName 'Tetherplane Relay' -ErrorAction Stop
  if ($task.State -ne 'Running' -or -not [bool]$task.Settings.Enabled -or
      @($task.Actions).Count -ne 1) {
    throw 'Relay scheduled-task ownership not established.'
  }
  $command = [string]$task.Actions[0].Arguments
  if ($command.IndexOf($PSCommandPath,[StringComparison]::OrdinalIgnoreCase) -lt 0 -or
      $command -notmatch '(?i)(?:^|\s)-Serve(?:\s|$)') {
    throw 'Registered relay task is not configured for the verified native launcher.'
  }
  $occupied = @(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
  if ($occupied.Count -ne 0) {
    throw 'Relay port 8788 already has a listener; refusing duplicate process.'
  }
}
Invoke-VerifiedNativeRelayProcess -Serve:$Serve -StateDirectory $StateDirectory -NodeExecutablePath $NodeExecutablePath -RelayEntrypointPath $RelayEntrypointPath -ExpectedEntrypointSha256 $ExpectedEntrypointSha256 -AuthConfigPath $AuthConfigPath -BaselineAuthConfigPath $BaselineAuthConfigPath -StateFilePath $StateFilePath
 -or
        (Get-FileHash -LiteralPath $pin.Path -Algorithm SHA256).Hash -cne $hash.ToUpperInvariant()){
        throw 'Protected bridge supervisor, native launcher or task snapshot hash changed.'
      }
    }
    $self=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$PID) -ErrorAction Stop
    if($null -eq $self){throw 'Native launcher process identity unavailable.'}
    $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$self.ParentProcessId) -ErrorAction Stop
    if($null -eq $parent){throw 'Registered bridge supervisor parent unavailable.'}
    $proof=@{
      SelfProcess=$self;ParentProcess=$parent;Task=$task
      OriginalTaskXml=[IO.File]::ReadAllText($snapshot)
      CurrentTaskXml=[string](Export-ScheduledTask -TaskPath '\' -TaskName 'Tetherplane Relay' -ErrorAction Stop)
      SupervisorPath=$supervisor;LauncherPath=$native
    }
    Assert-SupervisedBridgeOwnership @proof
  }else{
    $command = [string]$task.Actions[0].Arguments
    if ($command.IndexOf($PSCommandPath,[StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $command -notmatch '(?i)(?:^|\s)-Serve(?:\s|$)') {
      throw 'Registered relay task is not configured for the verified native launcher.'
    }
  }
  $occupied = @(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
  if ($occupied.Count -ne 0) {
    throw 'Relay port 8788 already has a listener; refusing duplicate process.'
  }
}
Invoke-VerifiedNativeRelayProcess -Serve:$Serve -StateDirectory $StateDirectory -NodeExecutablePath $NodeExecutablePath -RelayEntrypointPath $RelayEntrypointPath -ExpectedEntrypointSha256 $ExpectedEntrypointSha256 -AuthConfigPath $AuthConfigPath -BaselineAuthConfigPath $BaselineAuthConfigPath -StateFilePath $StateFilePath

  if(-not ([regex]::IsMatch([string]$ParentProcess.CommandLine,$parentPattern))){
    throw 'Supervisor parent command is not the exact protected bridge task action.'
  }
  $childPattern='(?i)^\s*'+$executablePattern+
    '\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"'+
    [regex]::Escape($LauncherPath)+'"\s+-Serve\s+-Supervised(?:\s|$)'
  if(-not ([regex]::IsMatch([string]$SelfProcess.CommandLine,$childPattern))){
    throw 'Native bridge launcher is not the protected supervised child.'
  }
  if([string]$Task.State -cne 'Running' -or
     -not [bool]$Task.Settings.Enabled -or
     [string]$Task.Settings.MultipleInstances -cne 'IgnoreNew' -or
     @($Task.Actions).Count -ne 1){
    throw 'Registered relay task is not the expected running single-instance supervisor.'
  }
  [xml]$prior=$OriginalTaskXml
  [xml]$current=$CurrentTaskXml
  $oldActions=$prior.SelectSingleNode("//*[local-name()='Actions']")
  $newActions=$current.SelectSingleNode("//*[local-name()='Actions']")
  $oldExec=$prior.SelectSingleNode("//*[local-name()='Actions']/*[local-name()='Exec']")
  if($null -eq $oldActions -or $null -eq $newActions -or $null -eq $oldExec){
    throw 'Protected task XML is malformed.'
  }
  $exe=$oldExec.SelectSingleNode("*[local-name()='Command']")
  $cwd=$oldExec.SelectSingleNode("*[local-name()='WorkingDirectory']")
  if($null -eq $exe){throw 'Protected task action executable missing.'}
  $oldExe=[string]$exe.InnerText
  $oldCwd=if($null -eq $cwd){''}else{[string]$cwd.InnerText}
  if(($oldExe -ine 'powershell.exe' -and $oldExe -ine $trusted) -or
     [string]$Task.Actions[0].Execute -ine $oldExe -or
     [string]$Task.Actions[0].Arguments -cne $expectedArgs -or
     [string]$Task.Actions[0].WorkingDirectory -cne $oldCwd){
    throw 'Task action differs from trusted original executable or bridge supervisor.'
  }
  $saved=$current.ImportNode($oldActions,$true)
  $null=$newActions.ParentNode.ReplaceChild($saved,$newActions)
  if($current.DocumentElement.OuterXml -cne $prior.DocumentElement.OuterXml){
    throw 'Task settings, account, triggers or working directory changed outside the action.'
  }
}

if ($env:COMPUTERNAME -ine 'VAULTER') { throw 'Vaulter only' }
if($Supervised -and -not $Serve){throw 'Supervised bridge child requires explicit Serve mode.'}
if ($Serve) {
  # Do not launch a second relay or bypass the registered task supervisor.
  $task = Get-ScheduledTask -TaskName 'Tetherplane Relay' -ErrorAction Stop
  if ($task.State -ne 'Running' -or -not [bool]$task.Settings.Enabled -or
      @($task.Actions).Count -ne 1) {
    throw 'Relay scheduled-task ownership not established.'
  }
  $command = [string]$task.Actions[0].Arguments
  if ($command.IndexOf($PSCommandPath,[StringComparison]::OrdinalIgnoreCase) -lt 0 -or
      $command -notmatch '(?i)(?:^|\s)-Serve(?:\s|$)') {
    throw 'Registered relay task is not configured for the verified native launcher.'
  }
  $occupied = @(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
  if ($occupied.Count -ne 0) {
    throw 'Relay port 8788 already has a listener; refusing duplicate process.'
  }
}
Invoke-VerifiedNativeRelayProcess -Serve:$Serve -StateDirectory $StateDirectory -NodeExecutablePath $NodeExecutablePath -RelayEntrypointPath $RelayEntrypointPath -ExpectedEntrypointSha256 $ExpectedEntrypointSha256 -AuthConfigPath $AuthConfigPath -BaselineAuthConfigPath $BaselineAuthConfigPath -StateFilePath $StateFilePath
