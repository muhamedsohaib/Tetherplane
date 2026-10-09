# The routing preflight is intentionally read-only and safe to run on Vaulter.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scriptFile = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-route-preflight.ps1'
if (-not (Test-Path -LiteralPath $scriptFile -PathType Leaf)) {
    throw 'Missing read-only Vaulter OAuth routing preflight script.'
}
$source = Get-Content -LiteralPath $scriptFile -Raw
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $scriptFile).Path, [ref]$tokens, [ref]$errors
)
if (@($errors).Count -gt 0) { throw 'Vaulter routing preflight does not parse.' }

foreach ($required in @(
    'COMPUTERNAME',
    '127.0.0.1:8788',
    '127.0.0.1:8790',
    'X-Forwarded-Proto',
    'X-Forwarded-Host',
    '/.well-known/openid-configuration',
    '/.well-known/oauth-protected-resource/mcp',
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
    'registration_endpoint',
    'tailscale',
    'funnel',
    'status'
)) {
    if (-not $source.Contains($required)) {
        throw "Routing preflight missing mandatory check: $required"
    }
}
$commands = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($forbidden in @(
    'Start-Process', 'Stop-Process', 'Set-Content', 'Set-Acl', 'Set-Item',
    'Set-ExecutionPolicy', 'New-Item', 'Remove-Item', 'Invoke-Expression',
    'Restart-Service', 'Start-Service', 'Stop-Service'
)) {
    if ($commands -contains $forbidden) {
        throw "Preflight must not mutate Vaulter: found $forbidden"
    }
}
if ($source -match '(?i)\btailscale\s+(funnel|serve)\s+(reset|set-config|--set-path|--bg)') {
    throw 'Preflight must not modify Tailscale Serve or Funnel routes.'
}
Write-Output 'Vaulter OAuth routing preflight read-only contract passed.'
