# Vaulter relay bridge: guarded native Node launcher, read-only by default.
# The existing PowerShell launcher is never executed: it may reference the
# original Auth0 config and therefore ignore a staged bridge-enabled config.
# Live activation requires a separately reviewed Scheduled Task handover.
[CmdletBinding()]
param(
  [switch]$Serve,
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

if ($env:COMPUTERNAME -ine 'VAULTER') { throw 'Vaulter only' }
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
