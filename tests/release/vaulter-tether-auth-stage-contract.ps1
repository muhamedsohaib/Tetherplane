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
$script:PnpmPrefix = @()
$output = @(Invoke-WorkspaceCommand -Arguments @('/d', '/c', 'echo', 'argument-one', 'argument-two'))
if ((($output -join [Environment]::NewLine).Trim()) -ne 'argument-one argument-two') {
    throw 'pnpm wrapper dropped an argument.'
}
# pnpm is pinned in package.json; do not require globally replacing another pnpm major.
foreach ($required in @('packageManager', 'corepack.cmd', 'PnpmPrefix')) {
    if (-not $source.Contains($required)) { throw "Staging script lacks pnpm/Corepack fallback: $required" }
}
$script:PnpmPrefix = @('/d', '/c', 'echo', 'pnpm')
$prefixed = @(Invoke-WorkspaceCommand -Arguments @('argument-one', 'argument-two'))
if ((($prefixed -join [Environment]::NewLine).Trim()) -ne 'pnpm argument-one argument-two') {
    throw 'pnpm wrapper dropped Corepack prefix or command arguments.'
}
# Behavioral regression for nested `pnpm` calls from package lifecycle scripts.
# The child launcher must route through the same Corepack pnpm version even
# when a different pnpm.cmd already exists in the machine PATH.
$shimAst = $parsed.Find({
    param($astNode)
    $astNode -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $astNode.Name -eq 'New-PnpmCorepackShim'
}, $true)
if ($null -eq $shimAst) { throw 'Missing isolated Corepack shim for nested pnpm calls.' }
Invoke-Expression $shimAst.Extent.Text
$fixture = Join-Path $env:TEMP ('tetherplane-pnpm-shim-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -Path $fixture -ItemType Directory -ErrorAction Stop | Out-Null
$oldPath = $env:PATH
$shimDirectory = $null
try {
    $corepackMock = Join-Path $fixture 'corepack.cmd'
    $mockBody = '@echo off' + [Environment]::NewLine +
        'echo [%1] [%2] [%3]' + [Environment]::NewLine
    [IO.File]::WriteAllText($corepackMock, $mockBody)
    $shimDirectory = New-PnpmCorepackShim -CorepackPath $corepackMock
    if (-not (Test-Path (Join-Path $shimDirectory 'pnpm.cmd'))) {
        throw 'Corepack shim failed to create pnpm.cmd.'
    }
    $env:PATH = "$shimDirectory;$oldPath"
    $nested = @(& cmd.exe /d /c pnpm --version)
    if ($LASTEXITCODE -ne 0 -or (($nested -join ' ').Trim()) -ne '[pnpm] [--version] []') {
        throw "Nested pnpm was not delegated to Corepack: $($nested -join ' ')"
    }
} finally {
    $env:PATH = $oldPath
    if ($shimDirectory -and (Test-Path $shimDirectory)) {
        Remove-Item $shimDirectory -Recurse -Force
    }
    if (Test-Path $fixture) { Remove-Item $fixture -Recurse -Force }
}

# Relay imports the generated protocol runtime; stage it before relay tests.
$protoBuild = "Invoke-WorkspaceCommand -Arguments @('--filter', '@tetherplane/protocol', 'build')"
$relayTest = "Invoke-WorkspaceCommand -Arguments @('--filter', '@tetherplane/relay', 'test')"
if (-not $source.Contains($protoBuild) -or
    $source.IndexOf($protoBuild, [StringComparison]::Ordinal) -gt
    $source.IndexOf($relayTest, [StringComparison]::Ordinal)) {
    throw 'Protocol runtime must be built before relay tests during staging.'
}

# A failed stage may leave valid signing/SQLite state. Preserve and reuse it.
foreach ($required in @(
    '[switch]$ReuseExistingState',
    'if ($ReuseExistingState)',
    'Existing OAuth configuration does not match',
    'Existing signing material is unavailable',
    'Proxy discovery',
    'X-Forwarded-Proto',
    'X-Forwarded-Host'
)) {
    if (-not $source.Contains($required)) {
        throw "Staging cannot safely resume with local public HTTPS metadata: $required"
    }
}

Write-Output 'Windows PowerShell staging syntax and safety guard checks passed.'
