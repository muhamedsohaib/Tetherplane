<#
.SYNOPSIS
  Inspect prerequisites for the Auth0 -> tether-auth relay cutover (read-only).
.DESCRIPTION
  Runs only on Vaulter. Checks live ports, relay process launch metadata,
  auth/registry file presence, paired-device records and restart supervision.
  Never prints command lines, bearer values, registry hashes, account IDs,
  private key files, environment variables or protected config contents.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Readiness([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-FlagPath([string]$CommandLine, [string]$Flag) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
    $pattern = '(?i)(?:^|\s)' + [regex]::Escape($Flag) + '\s+(?:"([^"]+)"|(\S+))'
    $found = [regex]::Match($CommandLine, $pattern)
    if (-not $found.Success) { return $null }
    $raw = if ($found.Groups[1].Success) { $found.Groups[1].Value }
           else { $found.Groups[2].Value }
    # Windows PowerShell 5.1 (.NET Framework) has no IsPathFullyQualified.
    # IsPathRooted is insufficient: it also accepts drive-relative C:file paths.
    # Accept only drive-rooted paths or complete UNC server/share paths.
    if ($raw -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
        return $null
    }
    try {
        return [IO.Path]::GetFullPath($raw)
    } catch {
        return $null
    }
}

function Get-LoopbackProcess([int]$Port) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    Assert-Readiness (
        $listeners.Count -eq 1 -and
        $listeners[0].LocalAddress -ceq '127.0.0.1'
    ) "Port $Port must be bound only to 127.0.0.1."
    $id = [int]$listeners[0].OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop
    Assert-Readiness ($null -ne $process) "Cannot inspect listener at port $Port."
    return $process
}

Assert-Readiness (
    $env:OS -eq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'vaulter'
) 'Readiness inspection is restricted to Vaulter on Windows.'

$relay = Get-LoopbackProcess 8788
$auth = Get-LoopbackProcess 8790
Assert-Readiness ($relay.Name -ieq 'node.exe' -and $auth.Name -ieq 'node.exe') 'Expected Node.js relay and auth processes.'

$relayHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 10
$authHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/readyz' -TimeoutSec 10
Assert-Readiness ($relayHealth.status -ceq 'ok' -and $authHealth.status -ceq 'ready') 'Services are not ready.'
Write-Output "Relay and auth: healthy on 127.0.0.1:8788 / 127.0.0.1:8790"

$ts = Get-Command tailscale.exe -ErrorAction Stop
$funnel = @(& $ts.Source funnel status)
Assert-Readiness ($LASTEXITCODE -eq 0) 'Could not inspect Funnel routing.'
$text = $funnel -join [Environment]::NewLine
Assert-Readiness (
    $text.Contains('https://vaulter.tailf65eba.ts.net (Funnel on)') -and
    $text.Contains('|-- / proxy http://127.0.0.1:8788') -and
    $text.Contains('/jwks proxy http://127.0.0.1:8790/jwks')
) 'Funnel root/JWKS baseline has changed.'
Write-Output 'Public Funnel root and JWKS canary: unchanged'

# Read the minimal file paths from the relay process in memory, never output
# the raw command line or any other launcher arguments.
$authConfigPath = Get-FlagPath ([string]$relay.CommandLine) '--auth-config'
$stateFilePath = Get-FlagPath ([string]$relay.CommandLine) '--state-file'
Write-Output ("Relay --auth-config path: {0}" -f $(if ($authConfigPath) { 'located' } else { 'not located' }))
Write-Output ("Relay --state-file path: {0}" -f $(if ($stateFilePath) { 'located' } else { 'not explicit / not located' }))

if ($authConfigPath) {
    Assert-Readiness (Test-Path -LiteralPath $authConfigPath -PathType Leaf) 'Relay auth config file no longer exists.'
    $config = Get-Content -LiteralPath $authConfigPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $oidc = $config.PSObject.Properties['oidc']
    Assert-Readiness ($null -ne $oidc) 'Existing relay is not configured for OIDC.'
    Write-Output ("Relay current OIDC issuer is Auth0: {0}" -f
        ([string]$oidc.Value.issuer -ceq 'https://tetherplane-dev.eu.auth0.com/'))
    Write-Output ("Relay resource matches public MCP: {0}" -f
        ([string]$oidc.Value.audience -ceq 'https://vaulter.tailf65eba.ts.net/mcp'))
    # No client credentials, names, subjects, or principal mappings are printed.
}

$nonRevoked = -1
$accountMappingOverlap = 'not evaluated'
if ($stateFilePath) {
    Assert-Readiness (Test-Path -LiteralPath $stateFilePath -PathType Leaf) 'Device-registry state file no longer exists.'
    $registry = Get-Content -LiteralPath $stateFilePath -Raw | ConvertFrom-Json -ErrorAction Stop
    Assert-Readiness ($registry.version -eq 1 -and $null -ne $registry.devices) 'Invalid device registry schema.'
    $valid = @($registry.devices | Where-Object {
        $_.PSObject.Properties['credentialHash'] -and
        $_.PSObject.Properties['accountId'] -and
        $_.PSObject.Properties['revokedAt']
    })
    Assert-Readiness ($valid.Count -eq @($registry.devices).Count) 'Incomplete device registry records.'
    $active = @($valid | Where-Object { $null -eq $_.revokedAt })
    $nonRevoked = $active.Count
    Write-Output "Paired, non-revoked registry records: $nonRevoked"
    if ($authConfigPath -and $null -ne $oidc) {
        $bindings = $oidc.Value.PSObject.Properties['bindings']
        if ($null -ne $bindings) {
            $ids = @($bindings.Value | ForEach-Object { $_.accountId })
            $accountMappingOverlap = (@($active | Where-Object { $ids -ccontains $_.accountId }).Count -gt 0).ToString()
        } else {
            $accountMappingOverlap = 'binding mode not in use'
        }
    }
    Write-Output "Paired device account compatible with current OIDC binding: $accountMappingOverlap"
} else {
    Write-Output 'Device registry: unable to verify without an explicit launch state-file path'
}
Write-Output 'Paired records are not a live online-device proof; authenticated approval must be tested before cutover.'
Write-Output 'Device online status: offline/unverified by this read-only inspection'

# A process listening right now is not evidence of persistence across reboot.
foreach ($entry in @(@('relay', $relay), @('tether-auth', $auth))) {
    $name = [string]$entry[0]
    $listeningProcessId = [int]$entry[1].ProcessId
    $services = @(Get-CimInstance Win32_Service -Filter "ProcessId=$listeningProcessId" -ErrorAction SilentlyContinue)
    $serviceLabel = if ($services.Count -gt 0) {
        'direct Windows service'
    } else {
        'no direct service association'
    }
    Write-Output ("{0} PID {1} supervisor: {2}" -f $name, $listeningProcessId, $serviceLabel)
}
$scheduledCmd = Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue
if ($scheduledCmd) {
    $candidates = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        $_.TaskName -match '(?i)tetherplane|tether-auth|tether-relay'
    })
    Write-Output "Named Tetherplane scheduled-task candidates: $($candidates.Count) (not proof of process supervision)"
} else {
    Write-Output 'Scheduled Task inventory: unavailable'
}

Write-Output 'Readiness summary: inspect process supervision and confirm online paired-device approval before relay identity switch.'
Write-Output 'No changes made. Do not paste launch command lines or private state contents.'
