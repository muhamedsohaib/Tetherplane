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
# Ensure a single [string[]] function parameter receives all intended arguments.
# Splatting at the function call site silently misbinds trailing pnpm arguments.
if ($source -match '(?m)^\s*Invoke-WorkspaceCommand\s+@\(') {
    throw 'pnpm wrapper must receive -Arguments @(...) explicitly, not array splatting.'
}
$parsed = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $stage).Path, [ref]$tokens, [ref]$errors
)
$wrapper = $parsed.Find({
    param($astNode)
    $astNode -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $astNode.Name -eq 'Invoke-WorkspaceCommand'
}, $true)
if ($null -eq $wrapper) { throw 'pnpm wrapper function is absent.' }
Invoke-Expression $wrapper.Extent.Text
$script:PnpmCommand = (Get-Command cmd.exe -ErrorAction Stop).Source
$output = @(Invoke-WorkspaceCommand -Arguments @('/d', '/c', 'echo', 'argument-one', 'argument-two'))
if ((($output -join [Environment]::NewLine).Trim()) -ne 'argument-one argument-two') {
    throw 'pnpm wrapper dropped an argument.'
}
Write-Output 'Windows PowerShell staging syntax and safety guard checks passed.'
