$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$stage = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-stage.ps1'
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $stage).Path,
    [ref]$tokens,
    [ref]$errors
) | Out-Null
if (@($errors).Count -ne 0) {
    throw "Staging script does not parse: $(@($errors) -join ', ')"
}
$source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $stage).Path)
foreach ($guard in @(
    'AreAccessRulesProtected',
    '127.0.0.1:8788',
    '127.0.0.1:8790',
    'tether-auth-jwks.json',
    'TETHERPLANE_AUTH_BRIDGE_TOKEN',
    'code_challenge_methods_supported',
    'offline_access',
    'registration_endpoint',
    'Stop-Process -Id $authProcess.Id',
    'No changes made'
)) {
    if (-not $source.Contains($guard)) { throw "Missing staging safety guard: $guard" }
}
Write-Output 'Windows PowerShell staging syntax and safety guard checks passed.'
