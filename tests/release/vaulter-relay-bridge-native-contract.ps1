# Native-child contract: launch must explicitly bind the staged relay auth config.
# This is entirely synthetic. Never reads live Vaulter state or starts the real relay.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-bridge-launcher.ps1'
$t = $null
$e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $scriptPath).Path,[ref]$t,[ref]$e)
if (@($e).Count -ne 0) { throw 'Wrapper does not parse.' }
$fn = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Invoke-VerifiedNativeRelayProcess'
},$true)
if ($null -eq $fn) {
    throw 'RED: native relay child launcher is missing; the original wrapper does not bind --auth-config.'
}
Invoke-Expression $fn.Extent.Text

$root = Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-native-bridge-'+[guid]::NewGuid().ToString('N'))
$state = Join-Path $root 'state'
$entry = Join-Path $root 'mock-relay.cjs'
$registry = Join-Path $root 'registry.json'
$candidate = Join-Path $root 'candidate.json'
$baseline = Join-Path $root 'baseline.json'
$marker = Join-Path $root 'invoked.txt'
$secret = Join-Path $state 'bridge-token.secret'
$deployment = Join-Path $state 'tether-auth-config.json'
$original = [Environment]::GetEnvironmentVariable('TETHERPLANE_AUTH_BRIDGE_TOKEN','Process')
$originalMarker = [Environment]::GetEnvironmentVariable('TETHERPLANE_NATIVE_TEST_MARKER','Process')
function MustFail([scriptblock]$body,[string]$label) {
    $rejected = $false
    try { & $body | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "Unexpected successful launch: $label" }
}
try {
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    $acl = Get-Acl -LiteralPath $state
    $acl.SetAccessRuleProtection($true,$true)
    Set-Acl -LiteralPath $state -AclObject $acl
    if (-not (Get-Acl -LiteralPath $state).AreAccessRulesProtected) { throw 'State ACL not protected.' }
    [IO.File]::WriteAllText($secret,'X'*64)
    [IO.File]::WriteAllText($deployment,'{"relay":{"bridgeTokenEnv":"TETHERPLANE_AUTH_BRIDGE_TOKEN"}}')
    [IO.File]::WriteAllText($registry,'{"version":1,"devices":[]}')
    [IO.File]::WriteAllText($candidate,'{"oidc":{"issuer":"https://tetherplane-dev.eu.auth0.com/","audience":"https://vaulter.tailf65eba.ts.net/mcp","jwksUri":"https://tetherplane-dev.eu.auth0.com/.well-known/jwks.json","scopes":["tetherplane:access"],"bindings":[{"subject":"fixture","clientId":"fixture","accountId":"fixture","principalId":"fixture"}]},"deviceLoginBridge":{"tokenEnv":"TETHERPLANE_AUTH_BRIDGE_TOKEN"}}')
    $baselineObj = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
    $baselineObj.PSObject.Properties.Remove('deviceLoginBridge')
    [IO.File]::WriteAllText($baseline,($baselineObj | ConvertTo-Json -Depth 32))
    $mock = @'
const fs = require("node:fs");
const args=process.argv.slice(2);
const param=(name)=>args[args.indexOf(name)+1];
if(process.env.TETHERPLANE_AUTH_BRIDGE_TOKEN!=="X".repeat(64) ||
   param("--auth-config")!==process.env.TETHERPLANE_NATIVE_TEST_CONFIG ||
   param("--state-file")!==process.env.TETHERPLANE_NATIVE_TEST_STATE ||
   param("--host")!=="127.0.0.1" ||
   param("--port")!=="8788" ||
   !args.includes("--allow-insecure-localhost")) process.exit(53);
fs.writeFileSync(process.env.TETHERPLANE_NATIVE_TEST_MARKER,"PASS");
'@
    [IO.File]::WriteAllText($entry,$mock)
    $env:TETHERPLANE_NATIVE_TEST_MARKER = $marker
    $env:TETHERPLANE_NATIVE_TEST_CONFIG = $candidate
    $env:TETHERPLANE_NATIVE_TEST_STATE = $registry
    Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue
    $params=@{
      StateDirectory=$state
      NodeExecutablePath=(Get-Command node.exe -ErrorAction Stop).Source
      RelayEntrypointPath=$entry
      ExpectedEntrypointSha256=(Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
      AuthConfigPath=$candidate
      BaselineAuthConfigPath=$baseline
      StateFilePath=$registry
    }
    Invoke-VerifiedNativeRelayProcess @params | Out-Null
    if(Test-Path -LiteralPath $marker){throw 'Read-only preflight launched a native child.'}
    Invoke-VerifiedNativeRelayProcess @params -Serve | Out-Null
    if(-not(Test-Path -LiteralPath $marker)){throw 'Native relay child was not invoked using the pinned auth config.'}
    if(Test-Path Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN){throw 'Bridge secret remained in parent environment.'}
    Remove-Item -LiteralPath $marker -Force
    $bad=@{}; foreach($key in $params.Keys){$bad[$key]=$params[$key]}
    $bad.ExpectedEntrypointSha256 = '0'*64
    MustFail { Invoke-VerifiedNativeRelayProcess @bad -Serve } 'tampered entrypoint hash'
    if(Test-Path -LiteralPath $marker){throw 'Tampered entrypoint was launched.'}
    Move-Item -LiteralPath $secret -Destination ($secret+'.held')
    try { MustFail { Invoke-VerifiedNativeRelayProcess @params -Serve } 'missing credential' }
    finally { Move-Item -LiteralPath ($secret+'.held') -Destination $secret }
    if(Test-Path -LiteralPath $marker){throw 'Missing credential launched a child.'}
    [IO.File]::WriteAllText($secret,'invalid')
    MustFail { Invoke-VerifiedNativeRelayProcess @params -Serve } 'invalid secret'
    [IO.File]::WriteAllText($secret,'X'*64)
    $oldJson=[IO.File]::ReadAllText($candidate)
    [IO.File]::WriteAllText($candidate,'{"oidc":{"issuer":"https://tetherplane-dev.eu.auth0.com/"}}')
    MustFail { Invoke-VerifiedNativeRelayProcess @params -Serve } 'missing bridge declaration'
    [IO.File]::WriteAllText($candidate,$oldJson)
    $mutated=Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
    $mutated.oidc.bindings[0].accountId='injected-other-account'
    [IO.File]::WriteAllText($candidate,($mutated | ConvertTo-Json -Depth 32))
    MustFail { Invoke-VerifiedNativeRelayProcess @params -Serve } 'identity binding changed'
    [IO.File]::WriteAllText($candidate,$oldJson)
    if(Test-Path -LiteralPath $marker){throw 'Unauthorized identity change launched a child.'}
    $env:TETHERPLANE_AUTH_BRIDGE_TOKEN='fixture-existing-value'
    [IO.File]::WriteAllText($entry,'process.exit(42)')
    $params.ExpectedEntrypointSha256=(Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
    MustFail { Invoke-VerifiedNativeRelayProcess @params -Serve } 'failing native child'
    if($env:TETHERPLANE_AUTH_BRIDGE_TOKEN -cne 'fixture-existing-value'){throw 'Parent environment not restored.'}
    $global:LASTEXITCODE = 0
    Write-Output 'VAULTER NATIVE RELAY BRIDGE CONTRACT PASS'
} finally {
    if($null -eq $original){Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue}
    else{$env:TETHERPLANE_AUTH_BRIDGE_TOKEN=$original}
    foreach($name in @('TETHERPLANE_NATIVE_TEST_MARKER','TETHERPLANE_NATIVE_TEST_CONFIG','TETHERPLANE_NATIVE_TEST_STATE')){
        Remove-Item -Path "Env:\$name" -ErrorAction SilentlyContinue
    }
    if($null -ne $originalMarker){$env:TETHERPLANE_NATIVE_TEST_MARKER=$originalMarker}
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
