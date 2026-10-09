<#
.SYNOPSIS
    Read-only HTTPS/Funnel preflight before routing tether-auth publicly.
.DESCRIPTION
    Run on Vaulter only after the local auth stage reports success.
    Prints public OAuth endpoint paths and current Funnel mappings.
    Does not write files, modify routes, restart services, or read credentials.
#>
[CmdletBinding()]
param(
    [string]$PublicOrigin = 'https://vaulter.tailf65eba.ts.net'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT' -or $env:COMPUTERNAME -ine 'vaulter') {
    throw 'This read-only routing preflight is restricted to Vaulter on Windows.'
}

$origin = [Uri]$PublicOrigin
if ($origin.Scheme -cne 'https' -or -not $origin.IsDefaultPort -or
    $origin.AbsolutePath -cne '/' -or $origin.Query -or $origin.Fragment -or
    $origin.UserInfo) {
    throw 'PublicOrigin must be a clean HTTPS origin on port 443.'
}
$PublicOrigin = $origin.GetLeftPart([UriPartial]::Authority)
if ($origin.Host -cne 'vaulter.tailf65eba.ts.net') {
    throw 'This preflight is restricted to the existing Vaulter public hostname.'
}

function Get-Json([string]$Url, [hashtable]$Headers = @{}) {
    Invoke-RestMethod -Method Get -Uri $Url -Headers $Headers -TimeoutSec 12 -ErrorAction Stop
}
function Test-OnlyLoopbackListener([int]$Port) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -cne '127.0.0.1') {
        throw "Port $Port must have exactly one loopback-only listener."
    }
    Write-Output ("Local listener {0}: 127.0.0.1, PID {1}" -f
        $Port, $listeners[0].OwningProcess)
}

Test-OnlyLoopbackListener 8788
Test-OnlyLoopbackListener 8790
$relayHealth = Get-Json 'http://127.0.0.1:8788/healthz'
$authHealth = Get-Json 'http://127.0.0.1:8790/healthz'
$authReady = Get-Json 'http://127.0.0.1:8790/readyz'
if ($relayHealth.status -cne 'ok' -or $authHealth.status -cne 'ok' -or
    $authReady.status -cne 'ready') {
    throw 'The relay and tether-auth must be healthy before public OAuth routing.'
}
Write-Output 'Local relay and tether-auth health/readiness: PASS'

# Simulate only the canonical same-host TLS-termination forwarding information.
# This operation is read-only: it does not send a token, cookie, or device secret.
$proxyHeaders = @{
    'X-Forwarded-Proto' = 'https'
    'X-Forwarded-Host' = $origin.Host
}
$metadata = Get-Json 'http://127.0.0.1:8790/.well-known/openid-configuration' $proxyHeaders
if ([string]$metadata.issuer -cne "$PublicOrigin/") {
    throw 'Self-hosted OAuth issuer does not match the public HTTPS origin.'
}
if (-not (@($metadata.code_challenge_methods_supported) -contains 'S256')) {
    throw 'PKCE S256 is missing.'
}
if (-not (@($metadata.scopes_supported) -contains 'offline_access')) {
    throw 'Refresh-token scope is missing.'
}

Write-Output '=== SELF-HOSTED OAUTH DISCOVERY (PUBLIC URL PATHS) ==='
Write-Output "Issuer: $($metadata.issuer)"
$fields = @(
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
    'registration_endpoint',
    'revocation_endpoint',
    'userinfo_endpoint',
    'end_session_endpoint',
    'introspection_endpoint',
    'device_authorization_endpoint'
)
foreach ($field in $fields) {
    $property = $metadata.PSObject.Properties[$field]
    $value = if ($null -eq $property) { '' } else { [string]$property.Value }
    if ([string]::IsNullOrWhiteSpace($value)) {
        if ($field -in @('authorization_endpoint', 'token_endpoint', 'jwks_uri', 'registration_endpoint')) {
            throw "Required OAuth endpoint $field is absent."
        }
        continue
    }
    $url = $null
    if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$url) -or
        $url.Scheme -cne 'https' -or
        $url.GetLeftPart([UriPartial]::Authority) -cne $PublicOrigin -or
        $url.UserInfo) {
        throw "Invalid public OAuth endpoint: $field"
    }
    Write-Output ("{0}: {1}" -f $field, $url.AbsolutePath)
}
Write-Output 'Proxy discovery hostname, PKCE, issuer and required endpoints: PASS'

$publicHealth = Get-Json "$PublicOrigin/healthz"
$publicReady = Get-Json "$PublicOrigin/readyz"
if ($publicHealth.status -cne 'ok' -or $publicReady.status -cne 'ready') {
    throw 'The public relay health/readiness baseline is failing.'
}

$protected = Get-Json "$PublicOrigin/.well-known/oauth-protected-resource/mcp"
if ([string]$protected.resource -cne "$PublicOrigin/mcp") {
    throw 'Existing public MCP protected-resource metadata has changed.'
}
Write-Output '=== CURRENT MCP IDENTITY (NO TOKEN VALUES) ==='
Write-Output "MCP resource: $($protected.resource)"
foreach ($provider in @($protected.authorization_servers)) {
    # Authorization-server URLs are public metadata and contain no bearer token.
    Write-Output "Current authorization server: $provider"
}
Write-Output 'Existing public relay and protected-resource metadata: PASS'

$tailscale = Get-Command tailscale.exe -ErrorAction Stop
$tailscaleRoutes = @(& $tailscale.Source funnel status)
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to read current Tailscale Funnel configuration.'
}
$routesText = $tailscaleRoutes -join [Environment]::NewLine
if (-not $routesText.Contains("$($origin.Host) (Funnel on)") -or
    -not $routesText.Contains('/ proxy http://127.0.0.1:8788')) {
    throw 'The expected public HTTPS Funnel root-to-relay mapping was not found.'
}
Write-Output '=== CURRENT TAILSCALE FUNNEL STATUS ==='
$tailscaleRoutes | ForEach-Object { Write-Output $_ }
Write-Output 'Existing Funnel root mapping: PASS'
Write-Output 'READ-ONLY ROUTING PREFLIGHT COMPLETE. No public route or auth configuration was changed.'
