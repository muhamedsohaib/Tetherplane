$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scriptFile = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-funnel-canary.ps1'
if (-not (Test-Path -LiteralPath $scriptFile -PathType Leaf)) {
    throw 'Missing reversible JWKS-only Funnel canary.'
}
$source = Get-Content -LiteralPath $scriptFile -Raw
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $scriptFile).Path, [ref]$tokens, [ref]$errors
)
if (@($errors).Count -gt 0) { throw 'JWKS Funnel canary does not parse.' }
foreach ($s in @(
    'vaulter',
    'Tetherplane\tether-auth',
    '127.0.0.1:8788',
    '127.0.0.1:8790/jwks',
    'https=443',
    'set-path=/jwks',
    'funnel status --json',
    'Funnel on',
    'tailnet only',
    'backup',
    'Rollback',
    'authorization_servers',
    'jwks',
    'private',
    'off'
)) {
    if (-not $source.Contains($s)) {
        throw "JWKS Funnel canary lacks guard: $s"
    }
}
foreach ($forbidden in @('serve reset', 'funnel reset', 'serve --https=443')) {
    if ($source.Contains($forbidden)) {
        throw "JWKS Funnel canary invokes forbidden operation: $forbidden"
    }
}
if ($source -match '(?i)jwksFile|bridge-token.secret|gh auth token') {
    throw 'JWKS Funnel canary must not read private signing or bridge-token files.'
}
$commands = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($forbidden in @('Restart-Service', 'Stop-Service', 'Start-Service',
                        'Stop-Process', 'Set-ExecutionPolicy', 'Set-Acl')) {
    if ($commands -contains $forbidden) {
        throw "JWKS Funnel canary must not disrupt services: $forbidden"
    }
}
Write-Output 'JWKS-only Funnel canary contract passed.'
