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
    'Get-VerifiedRunnerVersion', 'vaulter-tether-auth-startup-runner-v2.ps1', 'Win32_Process', 'Get-CimInstance', 'Get-NetTCPConnection',
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

# Tailscale's human status output may vary spacing without changing its routes.
# Only the JSON route table is authoritative for destination matching.
$guard=$ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Test-FunnelPublicRoutes'
},$true)
if($null -eq $guard){throw 'RED: semantic Funnel route validator missing.'}
Invoke-Expression $guard.Extent.Text
if(-not $source.Contains('funnel status --json')){
    throw 'Funnel routes must be verified against its structured JSON status.'
}
$origin='https://vaulter.tailf65eba.ts.net'
$json=@'
{
 "Web":{"vaulter.tailf65eba.ts.net:443":{"Handlers":{
   "/":{"Proxy":"http://127.0.0.1:8788"},
   "/jwks":{"Proxy":"http://127.0.0.1:8790/jwks"}
 }}},
 "AllowFunnel":{"vaulter.tailf65eba.ts.net:443":true}
}
'@
$config=$json|ConvertFrom-Json -ErrorAction Stop
# The JWKS line is semantically identical but intentionally has two spaces.
$status=@(
    'https://vaulter.tailf65eba.ts.net (Funnel on)',
    '|-- / proxy http://127.0.0.1:8788',
    '|-- /jwks  proxy http://127.0.0.1:8790/jwks'
) -join [Environment]::NewLine
if(-not (Test-FunnelPublicRoutes -Config $config -Status $status -Origin $origin)){
    throw 'Identical JSON routing with presentation-only whitespace changes was rejected.'
}
$originalStatus=$status.Replace('/jwks  proxy','/jwks proxy')
if(-not (Test-FunnelPublicRoutes -Config $config -Status $originalStatus -Origin $origin)){
    throw 'Original status formatting was rejected.'
}
$negative=@(
    @{Name='changed root'; Json=$json.Replace('8788','8789'); Status=$status; Origin=$origin},
    @{Name='changed jwks'; Json=$json.Replace('8790/jwks','8788/jwks'); Status=$status; Origin=$origin},
    @{Name='missing jwks'; Json=$json.Replace('"/jwks":{"Proxy":"http://127.0.0.1:8790/jwks"}','"/auth":{"Proxy":"http://127.0.0.1:8790/jwks"}'); Status=$status; Origin=$origin},
    @{Name='Funnel disabled'; Json=$json.Replace(':443":true',':443":false'); Status=$status; Origin=$origin},
    @{Name='no Funnel header'; Json=$json; Status=$status.Replace('(Funnel on)','(tailnet only)'); Origin=$origin},
    @{Name='unexpected origin'; Json=$json; Status=$status; Origin='https://other.tailf65eba.ts.net'}
)
foreach($case in $negative){
    $fixture=$case.Json|ConvertFrom-Json -ErrorAction Stop
    if(Test-FunnelPublicRoutes -Config $fixture -Status $case.Status -Origin $case.Origin){
        throw "Unsafe Funnel route configuration accepted: $($case.Name)"
    }
}
if(Test-FunnelPublicRoutes -Config $null -Status $status -Origin $origin){
    throw 'Missing JSON status was accepted.'
}
Write-Output 'Semantic Funnel JSON route and presentation-spacing regressions passed.'

Write-Output 'Read-only supervised-auth post-activation contracts passed.'
