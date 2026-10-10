# Offline safety contract for the Vaulter relay bridge wrapper.
# Uses only temporary synthetic files; never reads a real credential, scheduler, or listener.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$wrapper = Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-bridge-launcher.ps1'
if (-not (Test-Path -LiteralPath $wrapper -PathType Leaf)) {
    throw 'RED: repository-managed relay bridge launcher is missing.'
}
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $wrapper).Path, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -ne 0) {
    throw 'Relay bridge launcher does not parse.'
}
$unsafeNames = @('Start-Process','Stop-Process','Set-ScheduledTask',
    'Start-ScheduledTask','Stop-ScheduledTask','Register-ScheduledTask',
    'Unregister-ScheduledTask','Invoke-Expression','Write-Host')
$commands = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($name in $unsafeNames) {
    if ($commands -contains $name) {
        throw "Unsafe operation in bridge launcher: $name"
    }
}
$fn = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Invoke-VerifiedRelayBridgeLauncher'
}, $true)
if ($null -eq $fn) {
    throw 'Missing independently testable guarded bridge launcher.'
}
# Import only the function, never the production script's top-level operation.
Invoke-Expression $fn.Extent.Text
$source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $wrapper).Path)
foreach ($guard in @('AreAccessRulesProtected','Get-FileHash',
                     'bridge-token.secret','deviceLoginBridge',
                     'TETHERPLANE_AUTH_BRIDGE_TOKEN','finally')) {
    if (-not $source.Contains($guard)) {
        throw "Bridge launcher missing safeguard: $guard"
    }
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) (
    'tetherplane-relay-bridge-' + [guid]::NewGuid().ToString('N'))
$state = Join-Path $fixture 'state'
$launcher = Join-Path $fixture 'tetherplane-relay.ps1'
$relayConfig = Join-Path $fixture 'relay-auth.json'
$secret = Join-Path $state 'bridge-token.secret'
$authConfig = Join-Path $state 'tether-auth-config.json'
$marker = Join-Path $fixture 'invoked.txt'
$dummy = 'X' * 64
$oldBridge = [Environment]::GetEnvironmentVariable(
    'TETHERPLANE_AUTH_BRIDGE_TOKEN','Process')
$oldMarker = [Environment]::GetEnvironmentVariable(
    'TETHERPLANE_BRIDGE_TEST_MARKER','Process')
function Assert-Rejected([scriptblock]$Action, [string]$Label) {
    $failed = $false
    try {
        & $Action | Out-Null
    } catch {
        $failed = $true
        if ($_.Exception.Message.Contains(('X' * 64))) {
            throw 'A synthetic credential was exposed in an error message.'
        }
    }
    if (-not $failed) { throw "Unsafe input accepted: $Label" }
}
try {
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    $acl = Get-Acl -LiteralPath $state
    $acl.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $state -AclObject $acl
    if (-not (Get-Acl -LiteralPath $state).AreAccessRulesProtected) {
        throw 'Fixture state is not protected.'
    }
    [IO.File]::WriteAllText($secret, $dummy)
    $deployment = @{
        relay = @{ bridgeTokenEnv = 'TETHERPLANE_AUTH_BRIDGE_TOKEN' }
    }
    [IO.File]::WriteAllText($authConfig, ($deployment | ConvertTo-Json -Depth 8))
    $candidate = @{
        oidc = @{
            issuer = 'https://tetherplane-dev.eu.auth0.com/'
            audience = 'https://vaulter.tailf65eba.ts.net/mcp'
            scopes = @('tetherplane:access')
            bindings = @(@{ subject = 'fixture'; clientId = 'fixture'
                accountId = 'fixture'; principalId = 'fixture' })
        }
        deviceLoginBridge = @{ tokenEnv = 'TETHERPLANE_AUTH_BRIDGE_TOKEN' }
    }
    [IO.File]::WriteAllText($relayConfig, ($candidate | ConvertTo-Json -Depth 12))
    $child = @'
if ($env:TETHERPLANE_AUTH_BRIDGE_TOKEN -cne ('X' * 64)) {
    throw 'Child did not inherit the bridge credential.'
}
[IO.File]::WriteAllText($env:TETHERPLANE_BRIDGE_TEST_MARKER, 'invoked')
Write-Output 'SYNTHETIC CHILD PASS'
'@
    [IO.File]::WriteAllText($launcher, $child)
    $digest = (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash
    $env:TETHERPLANE_BRIDGE_TEST_MARKER = $marker
    Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue

    $parameters = @{
        StateDirectory = $state
        LauncherPath = $launcher
        AuthConfigPath = $relayConfig
        ExpectedLauncherSha256 = $digest
    }
    # Default mode must never invoke the relay, even with a valid secret.
    Invoke-VerifiedRelayBridgeLauncher @parameters | Out-Null
    if (Test-Path -LiteralPath $marker) {
        throw 'Preflight unexpectedly launched a child.'
    }
    $observed = @(Invoke-VerifiedRelayBridgeLauncher @parameters -Serve)
    if (-not (Test-Path -LiteralPath $marker) -or
        $observed -notcontains 'RELAY BRIDGE CHILD EXIT PASS') {
        throw 'Synthetic child did not inherit the process-scoped credential.'
    }
    if (($observed -join '') -match ('X' * 64)) {
        throw 'Credential appeared in child output.'
    }
    if (Test-Path Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN) {
        throw 'Credential remained in launcher process environment.'
    }
    Remove-Item -LiteralPath $marker -Force

    $badHash = @{}; foreach ($key in $parameters.Keys) { $badHash[$key] = $parameters[$key] }; $badHash.ExpectedLauncherSha256 = '0' * 64
    Assert-Rejected { Invoke-VerifiedRelayBridgeLauncher @badHash -Serve } 'altered launcher hash'
    if (Test-Path -LiteralPath $marker) {
        throw 'Hash mismatch started a child.'
    }
    Move-Item -LiteralPath $secret -Destination ($secret + '.held')
    try {
        Assert-Rejected { Invoke-VerifiedRelayBridgeLauncher @parameters -Serve } 'missing bridge secret'
    } finally {
        Move-Item -LiteralPath ($secret + '.held') -Destination $secret
    }
    [IO.File]::WriteAllText($secret, 'invalid-secret')
    Assert-Rejected { Invoke-VerifiedRelayBridgeLauncher @parameters -Serve } 'malformed bridge secret'
    [IO.File]::WriteAllText($secret, $dummy)

    $candidate.Remove('deviceLoginBridge')
    [IO.File]::WriteAllText($relayConfig, ($candidate | ConvertTo-Json -Depth 12))
    Assert-Rejected { Invoke-VerifiedRelayBridgeLauncher @parameters -Serve } 'relay config without bridge'
    $candidate.deviceLoginBridge = @{ tokenEnv = 'TETHERPLANE_AUTH_BRIDGE_TOKEN' }
    [IO.File]::WriteAllText($relayConfig, ($candidate | ConvertTo-Json -Depth 12))

    # Ensure a preexisting process-local variable is restored even after failure.
    $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = 'PREVIOUS_FIXTURE_VALUE'
    [IO.File]::WriteAllText($launcher, "throw 'synthetic child failure'")
    $parameters.ExpectedLauncherSha256 = (
        Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash
    Assert-Rejected { Invoke-VerifiedRelayBridgeLauncher @parameters -Serve } 'failing child'
    if ($env:TETHERPLANE_AUTH_BRIDGE_TOKEN -cne 'PREVIOUS_FIXTURE_VALUE') {
        throw 'Prior bridge environment was not restored after child failure.'
    }
    Write-Output 'VAULTER RELAY BRIDGE LAUNCHER CONTRACT PASS'
} finally {
    if ($null -eq $oldBridge) {
        Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue
    } else {
        $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = $oldBridge
    }
    if ($null -eq $oldMarker) {
        Remove-Item Env:\TETHERPLANE_BRIDGE_TEST_MARKER -ErrorAction SilentlyContinue
    } else {
        $env:TETHERPLANE_BRIDGE_TEST_MARKER = $oldMarker
    }
    Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
