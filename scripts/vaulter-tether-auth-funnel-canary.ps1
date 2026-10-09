<#
.SYNOPSIS
  Reversible JWKS-only public Funnel canary on Vaulter.
.DESCRIPTION
  Default is read-only. -Apply saves the current Funnel state in the protected
  tether-auth directory, adds only /jwks to public HTTPS 443, verifies the
  public signing keys and baseline routes, and rolls back that mount on failure.
#>
[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$origin = 'https://vaulter.tailf65eba.ts.net'
$localAuth = 'http://127.0.0.1:8790'
$stateDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'

function Assert-Canary([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Get-FunnelStatus([string]$Cli) {
    $output = @(& $Cli funnel status)
    Assert-Canary ($LASTEXITCODE -eq 0) 'Tailscale Funnel status failed.'
    return ($output -join [Environment]::NewLine)
}
function Assert-FunnelBaseline([string]$Status, [switch]$RequireCanary) {
    Assert-Canary ($Status.Contains("$origin (Funnel on)")) 'Public 443 is no longer in Funnel mode.'
    Assert-Canary ($Status.Contains('|-- / proxy http://127.0.0.1:8788')) 'Existing public root-to-relay mount missing.'
    foreach ($port in @('10000', '8443', '9443', '9445')) {
        Assert-Canary ($Status.Contains("$($origin):$port (tailnet only)")) "Private port $port was modified."
    }
    if ($RequireCanary) {
        Assert-Canary ($Status.Contains('/jwks proxy http://127.0.0.1:8790/jwks')) 'Public JWKS path mount missing.'
    } else {
        Assert-Canary (-not $Status.Contains('/jwks proxy')) 'JWKS mount already exists; do not replace it.'
    }
}
function Get-PrivateSections([string]$Status) {
    $text = $Status.Replace([string][char]13, '')
    $blocks = @($text -split "\n\s*\n" | Where-Object {
        $_ -match '(?m)^https://vaulter\.tailf65eba\.ts\.net:(10000|8443|9443|9445) \(tailnet only\)$'
    })
    Assert-Canary ($blocks.Count -eq 4) 'Unable to compare all four tailnet-only port sections.'
    return (($blocks | Sort-Object) -join [Environment]::NewLine)
}
function Get-Json([string]$Url) {
    Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 15 -ErrorAction Stop
}
function Assert-HealthyRelay([string]$Issuer) {
    $health = Get-Json "$origin/healthz"
    $ready = Get-Json "$origin/readyz"
    $resource = Get-Json "$origin/.well-known/oauth-protected-resource/mcp"
    Assert-Canary ($health.status -eq 'ok' -and $ready.status -eq 'ready') 'Public relay health/readiness failed.'
    Assert-Canary ($resource.resource -ceq "$origin/mcp") 'Public MCP resource changed.'
    $servers = @($resource.authorization_servers)
    Assert-Canary ($servers.Count -eq 1 -and $servers[0] -ceq $Issuer) 'Existing Auth0 authorization server changed.'
}
function Assert-PublicJwks([object]$Local) {
    $remote = Get-Json "$origin/jwks"
    $localKeys = @($Local.keys)
    $remoteKeys = @($remote.keys)
    Assert-Canary ($localKeys.Count -gt 0 -and $remoteKeys.Count -eq $localKeys.Count) 'JWKS key counts differ.'
    foreach ($key in $remoteKeys) {
        $names = @($key.PSObject.Properties.Name)
        foreach ($secret in @('d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k')) {
            Assert-Canary (-not ($names -contains $secret)) 'Private signing material appears in public JWKS.'
        }
        $match = @($localKeys | Where-Object {
            $_.kid -ceq $key.kid -and $_.kty -ceq $key.kty -and
            $_.n -ceq $key.n -and $_.e -ceq $key.e -and
            $_.alg -ceq $key.alg -and $_.use -ceq $key.use
        })
        Assert-Canary ($match.Count -eq 1) 'Public signing key does not match local JWKS.'
    }
}

Assert-Canary ($env:OS -eq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'vaulter') 'Canary runs only on Vaulter.'
Assert-Canary (Test-Path -LiteralPath $stateDir -PathType Container) 'Protected auth state directory is missing.'
$acl = Get-Acl -LiteralPath $stateDir
Assert-Canary ($acl.AreAccessRulesProtected) 'Auth state directory must have protected ACLs.'
$ts = Get-Command tailscale.exe -ErrorAction Stop
$before = Get-FunnelStatus $ts.Source
Assert-FunnelBaseline $before
$privateBefore = Get-PrivateSections $before
$authReady = Get-Json "$localAuth/readyz"
Assert-Canary ($authReady.status -eq 'ready') 'Local tether-auth must be ready.'
$localPublicJwks = Get-Json "$localAuth/jwks"
Assert-Canary (@($localPublicJwks.keys).Count -gt 0) 'Local public JWKS is empty.'
$oldResource = Get-Json "$origin/.well-known/oauth-protected-resource/mcp"
Assert-Canary (@($oldResource.authorization_servers).Count -eq 1) 'Existing issuer must be unambiguous.'
$oldIssuer = [string](@($oldResource.authorization_servers)[0])
Assert-Canary ($oldIssuer -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Public issuer is no longer Auth0; stop.'
Assert-HealthyRelay $oldIssuer

if (-not $Apply) {
    Write-Output 'JWKS-only Funnel canary preflight: PASS. No changes made.'
    Write-Output 'Run with -Apply to back up routes, publish /jwks, and verify rollback gates.'
    return
}

# Backup all existing public and private routes in a locally protected directory.
# No token, private signing key, or bridge credential file is read or printed.
$backupJson = @(& $ts.Source funnel status --json)
Assert-Canary ($LASTEXITCODE -eq 0 -and $backupJson.Count -gt 0) 'Funnel configuration backup failed.'
$backupRaw = $backupJson -join [Environment]::NewLine
try { $null = $backupRaw | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'Funnel status --json was not valid JSON.' }
$id = [Guid]::NewGuid().ToString('N')
$backupPath = Join-Path $stateDir ("funnel-pre-jwks-$id.json")
$statusBackupPath = Join-Path $stateDir ("funnel-pre-jwks-$id.txt")
$utf8 = [System.Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($backupPath, $backupRaw, $utf8)
[IO.File]::WriteAllText($statusBackupPath, $before, $utf8)
Write-Output 'Existing Funnel configuration backed up in protected local auth-state directory.'

$attempted = $false
try {
    # Preserve Funnel mode on 443; do not invoke any global route-clearing commands.
    $attempted = $true
    & $ts.Source funnel --bg --https=443 --set-path=/jwks http://127.0.0.1:8790/jwks
    Assert-Canary ($LASTEXITCODE -eq 0) 'Tailscale rejected the /jwks mount.'

    $verified = $false
    for ($i = 0; $i -lt 8; $i++) {
        try {
            Assert-PublicJwks $localPublicJwks
            $verified = $true
            break
        } catch {
            if ($i -eq 7) { throw }
            Start-Sleep -Seconds 2
        }
    }
    Assert-Canary $verified 'Public JWKS could not be verified.'
    Assert-HealthyRelay $oldIssuer
    $after = Get-FunnelStatus $ts.Source
    Assert-FunnelBaseline $after -RequireCanary
    Assert-Canary ((Get-PrivateSections $after) -ceq $privateBefore) 'A private port mapping changed.'

    Write-Output 'FUNNEL JWKS CANARY VERIFIED: public /jwks matches local public keys.'
    Write-Output 'Public MCP root, Auth0 issuer and four private ports: UNCHANGED.'
} catch {
    Write-Warning 'JWKS canary failed. Rollback: removing only the newly added /jwks mount.'
    if ($attempted) {
        & $ts.Source funnel --https=443 --set-path=/jwks off
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'Rollback could not remove the mount. Inspect Funnel status; do not use reset.'
        }
    }
    try {
        $rolledBack = Get-FunnelStatus $ts.Source
        Assert-FunnelBaseline $rolledBack
        Assert-Canary ((Get-PrivateSections $rolledBack) -ceq $privateBefore) 'Private ports changed after rollback.'
        Assert-HealthyRelay $oldIssuer
        Write-Output 'Rollback verified: existing relay and private ports healthy.'
    } catch {
        Write-Warning 'Post-rollback verification failed. Preserve route backup; do not change other ports.'
    }
    throw 'JWKS canary did not pass; stop public OAuth routing until failure is diagnosed.'
}
