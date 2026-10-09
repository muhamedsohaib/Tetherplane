# Read-only S4U auth supervision and unchanged-public-routing contract.
# Runs on Windows PowerShell 5.1 and PowerShell 7; no live task is touched.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scriptPath = Join-Path $PSScriptRoot '..\..\scripts\vaulter-tether-auth-supervised-postcheck.ps1'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw 'Missing supervised-auth post-activation read-only check.'
}
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $scriptPath).Path,
    [ref]$tokens, [ref]$parseErrors
)
if (@($parseErrors).Count -gt 0) { throw 'Post-activation PowerShell script does not parse.' }
$source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $scriptPath).Path)
foreach ($required in @(
    'COMPUTERNAME', 'vaulter',
    'Tetherplane-TetherAuth-Startup', 'Get-ScheduledTask', 'Running',
    'S4U', 'BootTrigger', 'RestartCount', 'AreAccessRulesProtected',
    'Get-FileHash', 'Win32_Process', 'Get-CimInstance', 'Get-NetTCPConnection',
    'ParentProcessId', 'CommandLine', '-Serve', 'tether-auth-startup-runner.ps1',
    '127.0.0.1', '8788', '8790', 'jwks', 'readyz',
    'authorization_servers', 'https://tetherplane-dev.eu.auth0.com/',
    'Funnel on', 'tailnet only', '10000', '8443', '9443', '9445',
    'No changes made', 'SUPERVISED AUTH POSTCHECK PASS',
    'Get-PublicJwksFingerprint', 'Test-TaskPrincipalIsCurrentUser'
)) {
    if (-not $source.Contains($required)) {
        throw "Post-activation check missing safety requirement: $required"
    }
}
if ($source -match '(?im)^\s*\$pid\s*=') {
    throw 'Do not assign to the reserved Windows PowerShell PID variable.'
}
$commands = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($bad in @(
    'Start-Process', 'Stop-Process', 'Start-ScheduledTask', 'Stop-ScheduledTask',
    'Enable-ScheduledTask', 'Disable-ScheduledTask',
    'Register-ScheduledTask', 'Unregister-ScheduledTask', 'Set-ScheduledTask',
    'Set-Acl', 'Set-Content', 'Remove-Item', 'New-Item',
    'Start-Service', 'Stop-Service', 'Restart-Service',
    'Invoke-Expression'
)) {
    if ($commands -contains $bad) {
        throw "Post-activation check must remain read-only, but includes: $bad"
    }
}
if ($source -match '(?i)\btailscale\s+(?:funnel|serve)\s+(?:--bg|--set-path|reset|off)') {
    throw 'Post-activation check cannot change existing Tailscale routing.'
}
if ($source -match '(?i)(gh auth token|TETHERPLANE_AUTH_BRIDGE_TOKEN|bridge-token\.secret)') {
    throw 'The post-activation check must not read private bridge credentials.'
}
if ($source -match '(?im)Write-(?:Output|Host|Warning|Error)\s+.*(?:CommandLine|UserId|SecurityIdentifier|privateKey)') {
    throw 'Do not expose raw task command lines, task identities or private material.'
}
$extractor = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Test-TaskPrincipalIsCurrentUser'
}, $true)
if ($null -eq $extractor) { throw 'Missing canonical SID comparison helper.' }
Invoke-Expression $extractor.Extent.Text
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (Test-TaskPrincipalIsCurrentUser $identity.User.Value $identity.User) -or
    -not (Test-TaskPrincipalIsCurrentUser $identity.Name $identity.User)) {
    throw 'Current user SID and account label must match the same principal.'
}
if (Test-TaskPrincipalIsCurrentUser 'S-1-5-18' ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-19'))) {
    throw 'Different task-owner SID must not pass ownership check.'
}
Write-Output 'Read-only supervised-auth post-activation contracts passed.'
