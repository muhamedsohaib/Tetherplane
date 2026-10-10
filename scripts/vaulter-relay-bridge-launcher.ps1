# Guarded, read-only by default. Never changes live configurations.
[CmdletBinding()]
param(
  [switch]$Serve,
  [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'),
  [Parameter(Mandatory=$true)][string]$LauncherPath,
  [Parameter(Mandatory=$true)][string]$AuthConfigPath,
  [Parameter(Mandatory=$true)][string]$ExpectedLauncherSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-VerifiedRelayBridgeLauncher {
  [CmdletBinding()]
  param(
    [switch]$Serve,
    [Parameter(Mandatory=$true)][string]$StateDirectory,
    [Parameter(Mandatory=$true)][string]$LauncherPath,
    [Parameter(Mandatory=$true)][string]$AuthConfigPath,
    [Parameter(Mandatory=$true)][string]$ExpectedLauncherSha256
  )
  $envName = 'TETHERPLANE_AUTH_BRIDGE_TOKEN'
  if (-not(Test-Path -LiteralPath $StateDirectory -PathType Container) -or -not (Get-Acl -LiteralPath $StateDirectory).AreAccessRulesProtected) {
    throw 'Protected bridge state directory missing or unsafe.'
  }
  foreach ($path in @($LauncherPath,$AuthConfigPath)) {
    if (-not(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Launcher or relay config missing.' }
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Launcher/config may not be a reparse point.' }
  }
  if ($ExpectedLauncherSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      (Get-FileHash -LiteralPath $LauncherPath -Algorithm SHA256).Hash -cne $ExpectedLauncherSha256.ToUpperInvariant()) {
    throw 'Original launcher hash mismatch.'
  }
  $cfg = Get-Content -LiteralPath $AuthConfigPath -Raw | ConvertFrom-Json
  if ($null -eq $cfg.PSObject.Properties['oidc'] -or
      [string]$cfg.oidc.issuer -cne 'https://tetherplane-dev.eu.auth0.com/' -or
      [string]$cfg.oidc.audience -cne 'https://vaulter.tailf65eba.ts.net/mcp' -or
      $null -eq $cfg.oidc.PSObject.Properties['bindings'] -or
      $null -eq $cfg.PSObject.Properties['deviceLoginBridge'] -or
      [string]$cfg.deviceLoginBridge.tokenEnv -cne $envName) {
    throw 'Unexpected relay OIDC bridge configuration.'
  }
  $bridgeConfig = Join-Path $StateDirectory 'tether-auth-config.json'
  $secretFile = Join-Path $StateDirectory 'bridge-token.secret'
  foreach ($path in @($bridgeConfig,$secretFile)) {
    if (-not(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Protected bridge material missing.' }
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bridge material may not be a reparse point.' }
  }
  $auth = Get-Content -LiteralPath $bridgeConfig -Raw | ConvertFrom-Json
  if ([string]$auth.relay.bridgeTokenEnv -cne $envName) { throw 'Auth service bridge declaration mismatch.' }
  if (-not $Serve) {
    Write-Output 'RELAY BRIDGE LAUNCHER PREFLIGHT PASS; NO SERVICE STARTED'
    return
  }
  $oldValue = [Environment]::GetEnvironmentVariable($envName,'Process')
  $secretValue = $null
  try {
    $secretValue = ([IO.File]::ReadAllText($secretFile)).Trim()
    if ($secretValue -notmatch '^[A-Za-z0-9_-]{64,}$') { throw 'Bridge credential malformed.' }
    [Environment]::SetEnvironmentVariable($envName,$secretValue,'Process')
    $secretValue = $null
    # Keep the child attached. Suppress any child output that might reveal secrets.
    & $LauncherPath 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Relay launcher child exited unsuccessfully.' }
    Write-Output 'RELAY BRIDGE CHILD EXIT PASS'
  } finally {
    $secretValue = $null
    [Environment]::SetEnvironmentVariable($envName,$oldValue,'Process')
  }
}

if ($env:COMPUTERNAME -ine 'VAULTER') { throw 'Vaulter only' }
Invoke-VerifiedRelayBridgeLauncher -Serve:$Serve -StateDirectory $StateDirectory -LauncherPath $LauncherPath -AuthConfigPath $AuthConfigPath -ExpectedLauncherSha256 $ExpectedLauncherSha256
