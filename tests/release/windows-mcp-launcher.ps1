$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$launcher = Join-Path $PSScriptRoot '..\..\packaging\windows\tetherplane-mcp.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0 -or $null -eq $ast.ParamBlock) {
    throw 'MCP launcher must have a real PowerShell parameter block before executable statements'
}
# Run a real child PowerShell, intercepting only Node; verify the installed
# entrypoint forwards explicit args and receipt state without launching an agent.
$root = Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-mcp-launcher-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'launch'), (Join-Path $root 'bin'),
        (Join-Path $root 'adapters\compact-mcp\dist'), (Join-Path $root 'config') | Out-Null
    Copy-Item -LiteralPath $launcher -Destination (Join-Path $root 'launch\tetherplane-mcp.ps1')
    [IO.File]::WriteAllText((Join-Path $root 'bin\tetherd.exe'), 'not-executable-fixture')
    [IO.File]::WriteAllText((Join-Path $root 'adapters\compact-mcp\dist\stdio-server.js'), 'not-executable-fixture')
    @{ state_dir = (Join-Path $root 'owner state') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'config\install.json')
    $driver = @'
param($Root)
function node {
    $expected = @((Join-Path $Root 'adapters\compact-mcp\dist\stdio-server.js'), '--tetherd',
        (Join-Path $Root 'bin\tetherd.exe'), '--state-dir', (Join-Path $Root 'owner state'), '--allow', (Join-Path $Root 'allowed folder'))
    if (($args | ConvertTo-Json -Compress) -cne ($expected | ConvertTo-Json -Compress)) { throw 'launcher argument forwarding mismatch' }
    $global:LASTEXITCODE = 0
    Write-Output 'WINDOWS_INSTALLED_MCP_LAUNCHER_FORWARDING_OK'
}
& (Join-Path $Root 'launch\tetherplane-mcp.ps1') '--allow' (Join-Path $Root 'allowed folder')
'@
    $driverPath = Join-Path $root 'driver.ps1'
    [IO.File]::WriteAllText($driverPath, $driver)
    & powershell.exe -NoProfile -NonInteractive -File $driverPath $root
    if ($LASTEXITCODE -ne 0) { throw 'installed launcher forwarding test failed' }
} finally {
    $safeParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ([IO.Path]::GetFullPath($root).StartsWith($safeParent + 'tetherplane-mcp-launcher-', [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}
