<#
.SYNOPSIS
  Read-only preflight or one-time staging of tether-auth on Vaulter.
.DESCRIPTION
  -Stage builds and tests the existing auth package, creates protected local
  signing/bridge material, then starts tether-auth on loopback port 8790.
  It NEVER changes the existing relay, Tailscale Serve/Funnel, Git branches,
  device pairings, or the ChatGPT connection. After this command succeeds,
  the self-hosted authorization server is staged LOCALLY, not publicly live.
  Run from an existing checkout of the migration feature branch on Vaulter.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PublicOrigin = 'https://vaulter.tailf65eba.ts.net',
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'),
    [switch]$Stage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Stage([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-WorkspaceCommand([string[]]$Arguments) {
    & $script:PnpmCommand @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm operation failed (exit code $LASTEXITCODE)"
    }
}

function Test-HttpJson([string]$Url) {
    Invoke-RestMethod -Uri $Url -TimeoutSec 10 -ErrorAction Stop
}

Assert-Stage ($env:OS -eq 'Windows_NT') 'This deployment script runs only on Windows.'
Assert-Stage ($env:COMPUTERNAME -ieq 'vaulter') 'This deployment script may run only on Vaulter.'
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
Assert-Stage (-not $StateDirectory.StartsWith(($RepoRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) 'Authentication secrets must stay outside the source repository.'
Assert-Stage (Test-Path (Join-Path $RepoRoot 'auth\src\production.ts') -PathType Leaf) 'Tetherplane repository was not found at RepoRoot.'
Assert-Stage (Test-Path (Join-Path $RepoRoot 'scripts\vaulter-tether-auth-material.mjs') -PathType Leaf) 'Key-material helper is missing; use the migration branch.'

$origin = ([Uri]$PublicOrigin)
Assert-Stage ($origin.Scheme -eq 'https' -and $origin.IsDefaultPort -and
    ($origin.AbsolutePath -eq '/') -and (-not $origin.Query) -and (-not $origin.Fragment) -and
    $origin.UserInfo -eq '') 'PublicOrigin must be a clean HTTPS origin without a custom port.'
$PublicOrigin = $origin.GetLeftPart([UriPartial]::Authority)

$node = Get-Command node.exe -ErrorAction Stop
$pnpm = Get-Command pnpm.cmd -ErrorAction Stop
$git = Get-Command git.exe -ErrorAction Stop
$script:PnpmCommand = $pnpm.Source

$nodeVersion = (& $node.Source -p 'process.versions.node').Trim()
Assert-Stage ([int]($nodeVersion.Split('.')[0]) -ge 22) 'Node.js 22 or later is required.'
$pnpmVersion = (& $script:PnpmCommand --version).Trim()
Assert-Stage ([int]($pnpmVersion.Split('.')[0]) -eq 10) 'Use pnpm 10 for this repository.'

$gitSha = (& $git.Source -C $RepoRoot rev-parse --short HEAD).Trim()
Assert-Stage ($LASTEXITCODE -eq 0) 'Unable to inspect Git HEAD.'
$branch = (& $git.Source -C $RepoRoot branch --show-current).Trim()
$changes = @(& $git.Source -C $RepoRoot status --porcelain)
Assert-Stage ($LASTEXITCODE -eq 0) 'Unable to inspect Git status.'
$remoteUrl = (& $git.Source -C $RepoRoot remote get-url origin).Trim()
Assert-Stage ($LASTEXITCODE -eq 0) 'Unable to inspect Git remote.'
Assert-Stage ($remoteUrl -match '(^|[/@:])muhamedsohaib/Tetherplane(\.git)?$') 'This is not the canonical Tetherplane GitHub remote.'

$listener = @(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' })
Assert-Stage ($listener.Count -gt 0) 'The existing relay is not listening on 127.0.0.1:8788.'
$busyAuth = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
Assert-Stage ($busyAuth.Count -eq 0) 'Port 8790 is occupied; refusing to modify any existing process.'

$baseline = Test-HttpJson 'http://127.0.0.1:8788/healthz'
Assert-Stage ($baseline.status -eq 'ok') 'The existing relay did not pass its local health check.'
Write-Output "Vaulter preflight passed. Git=$gitSha branch=$branch Node=$nodeVersion pnpm=$pnpmVersion"
Write-Output 'Relay: healthy on loopback 8788; auth port 8790 available.'
if (-not $Stage) {
    Write-Output 'No changes made. Re-run with -Stage to stage and test tether-auth locally.'
    return
}
Assert-Stage ($changes.Count -eq 0) 'Working tree is not clean; refusing to stage from uncommitted source.'
Assert-Stage ($branch -eq 'feature/tether-auth-vaulter-migration-20261009') 'Checkout the verified migration feature branch before staging.'

Push-Location $RepoRoot
try {
    Invoke-WorkspaceCommand @('install', '--frozen-lockfile')
    Invoke-WorkspaceCommand @('--filter', '@tetherplane/auth', 'build')
    Invoke-WorkspaceCommand @('--filter', '@tetherplane/auth', 'test')
    Invoke-WorkspaceCommand @('--filter', '@tetherplane/auth', 'typecheck')
    Invoke-WorkspaceCommand @('--filter', '@tetherplane/relay', 'test')
} finally {
    Pop-Location
}

Assert-Stage (-not (Test-Path -LiteralPath $StateDirectory)) 'Auth state directory already exists; refusing to change existing state or ACLs.'

New-Item -Path $StateDirectory -ItemType Directory -Force | Out-Null
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$acl = Get-Acl -LiteralPath $StateDirectory
$acl.SetAccessRuleProtection($true, $false)
$inherited = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $currentIdentity.User,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inherited,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $StateDirectory -AclObject $acl
Assert-Stage ((Get-Acl -LiteralPath $StateDirectory).AreAccessRulesProtected) 'Unable to protect auth-state directory permissions.'

& $node.Source (Join-Path $RepoRoot 'scripts\vaulter-tether-auth-material.mjs') --directory $StateDirectory
Assert-Stage ($LASTEXITCODE -eq 0) 'Credential provisioning failed; relay and public routes were not changed.'

$configFile = Join-Path $StateDirectory 'tether-auth-config.json'
$config = [ordered]@{
    issuer = "$PublicOrigin/"
    resource = "$PublicOrigin/mcp"
    databasePath = (Join-Path $StateDirectory 'provider.sqlite')
    jwksFile = (Join-Path $StateDirectory 'tether-auth-jwks.json')
    relay = [ordered]@{
        url = 'http://127.0.0.1:8788'
        bridgeTokenEnv = 'TETHERPLANE_AUTH_BRIDGE_TOKEN'
        allowInsecureLocalhost = $true
    }
}
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 8), $utf8NoBom)

$stdout = Join-Path $StateDirectory 'tether-auth.stdout.log'
$stderr = Join-Path $StateDirectory 'tether-auth.stderr.log'
$previousBridge = [Environment]::GetEnvironmentVariable('TETHERPLANE_AUTH_BRIDGE_TOKEN', 'Process')
try {
    $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = ([IO.File]::ReadAllText((Join-Path $StateDirectory 'bridge-token.secret'))).Trim()
    # Quote only the file path, never a secret or bearer token, in process args.
    $argsText = "auth/dist/cli.js --config `"$configFile`" --host 127.0.0.1 --port 8790 --allow-insecure-localhost"
    $authProcess = Start-Process -FilePath $node.Source -ArgumentList $argsText `
        -WorkingDirectory $RepoRoot -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
} finally {
    if ($null -ne $previousBridge) { $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = $previousBridge }
    else { Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue }
}

try {
    $health = $null
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if ($authProcess.HasExited) { throw 'tether-auth exited early; inspect its protected local logs.' }
        try { $health = Test-HttpJson 'http://127.0.0.1:8790/healthz'; break }
        catch { continue }
    }
    Assert-Stage ($health -and $health.status -eq 'ok') 'tether-auth did not become healthy.'
    $ready = Test-HttpJson 'http://127.0.0.1:8790/readyz'
    Assert-Stage ($ready.status -eq 'ready') 'tether-auth readiness probe failed.'
    $metadata = Test-HttpJson 'http://127.0.0.1:8790/.well-known/openid-configuration'
    Assert-Stage ($metadata.issuer -ceq "$PublicOrigin/") 'Issuer mismatch.'
    Assert-Stage (@($metadata.code_challenge_methods_supported) -contains 'S256') 'PKCE S256 is not advertised.'
    Assert-Stage (@($metadata.scopes_supported) -contains 'offline_access') 'Refresh-token scope is not advertised.'
    Assert-Stage (@($metadata.token_endpoint_auth_methods_supported) -contains 'none') 'Public-client token authentication is not advertised.'
    foreach ($field in @('authorization_endpoint', 'token_endpoint', 'jwks_uri', 'registration_endpoint')) {
        $value = [string]$metadata.$field
        Assert-Stage ($value.StartsWith("$PublicOrigin/", [StringComparison]::Ordinal)) "Invalid $field in authorization metadata."
    }
    $publicJwksUri = [Uri]$metadata.jwks_uri
    $jwks = Test-HttpJson ("http://127.0.0.1:8790" + $publicJwksUri.PathAndQuery)
    Assert-Stage (@($jwks.keys).Count -gt 0) 'Public signing keys not exposed.'
    foreach ($key in @($jwks.keys)) {
        Assert-Stage ($key.kty -eq 'RSA' -and -not ($key.PSObject.Properties.Name -contains 'd')) 'Public JWKS invalid or leaks a private key.'
    }
} catch {
    if (-not $authProcess.HasExited) { Stop-Process -Id $authProcess.Id -ErrorAction SilentlyContinue }
    throw
}
Write-Output "tether-auth LOCAL STAGE VERIFIED: PID=$($authProcess.Id), loopback=127.0.0.1:8790"
Write-Output 'Auth0 relay, public Funnel routing, device policies, and ChatGPT connections remain UNCHANGED.'
Write-Output 'Next gate: public OAuth path routing, relay bridge configuration, then authenticated MCP acceptance.'
