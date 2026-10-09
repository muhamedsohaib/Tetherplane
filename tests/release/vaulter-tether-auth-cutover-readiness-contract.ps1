$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$target = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-cutover-readiness.ps1'
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw 'Missing read-only Vaulter cutover readiness check.'
}

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $target).Path, [ref]$tokens, [ref]$parseErrors
)
if (@($parseErrors).Count -gt 0) { throw "Readiness script must parse on Windows." }
$source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $target).Path)

foreach ($guard in @(
    'COMPUTERNAME', 'vaulter', '127.0.0.1',
    '8788', '8790', 'Get-NetTCPConnection',
    'Get-CimInstance', 'Win32_Process', 'Win32_Service',
    '--auth-config', '--state-file',
    'credentialHash', 'revokedAt', 'accountId',
    'offline', 'not a live online-device proof',
    'No changes made', 'Get-FlagPath'
)) {
    if (-not $source.Contains($guard)) {
        throw "Readiness check missing guard: $guard"
    }
}

# $PID is a read-only automatic PowerShell variable (case-insensitive).
if ($source -match '(?im)^\s*\$pid\s*=') {
    throw 'Readiness script must not assign to the automatic $PID variable.'
}

$commands = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($forbidden in @(
    'Set-Content', 'Set-Acl', 'Set-Item', 'New-Item', 'Remove-Item',
    'Start-Process', 'Stop-Process', 'Start-Service', 'Stop-Service',
    'Restart-Service', 'Register-ScheduledTask', 'Set-ScheduledTask',
    'schtasks.exe', 'Invoke-Expression', 'Set-ExecutionPolicy'
)) {
    if ($commands -contains $forbidden) {
        throw "Readiness script must be read-only. Found $forbidden"
    }
}
if ($source -match '(?i)tailscale\s+(serve|funnel)\s+(--set-path|reset|--bg)') {
    throw 'Readiness check must not change any Tailscale service.'
}
if ($source -match 'Write-(Output|Host)\s+.*(CommandLine|credentialHash|bridgeToken|TokenValue)') {
    throw 'Readiness script must not expose private process arguments or secrets.'
}

$parser = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Get-FlagPath'
}, $true)
if ($null -eq $parser) { throw 'Missing argument path extractor.' }
Invoke-Expression $parser.Extent.Text
$sample = 'node C:\Tetherplane\relay\dist\cli.js --auth-config "C:\Users\test account\.tetherplane\auth.json" --state-file "C:\Users\test account\.tetherplane\devices.json"'
$expectedConfig = 'C:\Users\test account\.tetherplane\auth.json'
$expectedState = 'C:\Users\test account\.tetherplane\devices.json'
if ((Get-FlagPath $sample '--auth-config') -ne $expectedConfig -or
    (Get-FlagPath $sample '--state-file') -ne $expectedState) {
    throw 'Quoted relay argument paths must parse without echoing raw arguments.'
}
if ($null -ne (Get-FlagPath 'node relay.js' '--auth-config')) {
    throw 'Missing relay flag must not be guessed.'
}

# These are rooted-ish strings that are not fully-qualified Windows paths.
# Windows PowerShell 5.1 does not provide [IO.Path]::IsPathFullyQualified.
foreach ($invalidPath in @(
    'auth.json',
    '.\auth.json',
    'C:relative\auth.json',
    '\Users\relative\auth.json'
)) {
    $commandLine = ('node relay.js --auth-config "{0}"' -f $invalidPath)
    if ($null -ne (Get-FlagPath $commandLine '--auth-config')) {
        throw 'Relative Windows path was incorrectly treated as fully qualified.'
    }
}
$uncPath = '\\vaulter\auth-state\auth.json'
if ((Get-FlagPath ('node relay.js --auth-config "{0}"' -f $uncPath) '--auth-config') -ne $uncPath) {
    throw 'Fully-qualified UNC paths must remain supported.'
}

Write-Output 'Read-only Vaulter cutover readiness contract passed.'
