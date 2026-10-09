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
    [switch]$Stage,
    [switch]$ReuseExistingState
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Stage([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-WorkspaceCommand([string[]]$Arguments) {
    $prefix = @($script:PnpmPrefix)
    & $script:PnpmCommand @prefix @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm operation failed (exit code $LASTEXITCODE)"
    }
}

function Test-HttpJson([string]$Url, [hashtable]$Headers = @{}) {
    Invoke-RestMethod -Uri $Url -Headers $Headers -TimeoutSec 10 -ErrorAction Stop
}

# Only the -Stage phase installs this short-lived shim in the current process
# PATH. Package lifecycle scripts resolve "pnpm" through it instead of an
# unrelated globally installed pnpm (e.g. 11.x).
function New-PnpmCorepackShim([string]$CorepackPath) {
    if (-not $CorepackPath -or $CorepackPath -match '["\r\n]' -or
        -not (Test-Path -LiteralPath $CorepackPath -PathType Leaf)) {
        throw 'Corepack path is missing or unsafe for a Windows command shim.'
    }
    $shimDirectory = Join-Path ([IO.Path]::GetTempPath()) (
        'tetherplane-pnpm-' + [Guid]::NewGuid().ToString('N')
    )
    New-Item -Path $shimDirectory -ItemType Directory -ErrorAction Stop | Out-Null
    try {
        $launcher = '@echo off' + [Environment]::NewLine +
            'call "' + $CorepackPath + '" pnpm %*' + [Environment]::NewLine +
            'exit /b %errorlevel%' + [Environment]::NewLine
        [IO.File]::WriteAllText(
            (Join-Path $shimDirectory 'pnpm.cmd'),
            $launcher,
            [System.Text.Encoding]::ASCII
        )
        return $shimDirectory
    } catch {
        Remove-Item -LiteralPath $shimDirectory -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
}

Assert-Stage ($env:OS -eq 'Windows_NT') 'This deployment script runs only on Windows.'
Assert-Stage ($env:COMPUTERNAME -ieq 'vaulter') 'This deployment script may run only on Vaulter.'
Assert-Stage (-not $ReuseExistingState -or $Stage) 'ReuseExistingState requires -Stage.'
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
$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
$git = Get-Command git.exe -ErrorAction Stop

$nodeVersion = (& $node.Source -p 'process.versions.node').Trim()
Assert-Stage ([int]($nodeVersion.Split('.')[0]) -ge 22) 'Node.js 22 or later is required.'

$manifest = Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$pinMatch = [regex]::Match([string]$manifest.packageManager, '^pnpm@(10\.\d+\.\d+)$')
Assert-Stage ($pinMatch.Success) 'The repository must pin a pnpm 10 release in packageManager.'
$pinnedPnpm = $pinMatch.Groups[1].Value

$script:PnpmPrefix = @()
$script:PnpmCommand = $null
$pnpmVersion = $null
if ($null -ne $pnpm) {
    $installedVersion = (& $pnpm.Source --version)
    if ($LASTEXITCODE -eq 0 -and $installedVersion) {
        $pnpmVersion = ([string]$installedVersion).Trim()
        if ($pnpmVersion -ceq $pinnedPnpm) {
            $script:PnpmCommand = $pnpm.Source
        }
    }
}

if ($null -eq $script:PnpmCommand) {
    Assert-Stage ($null -ne $corepack) "Repository requires pnpm $pinnedPnpm. Current pnpm is $pnpmVersion and corepack.cmd was not found. Install Corepack or the pinned pnpm release first."
    # Do not replace or reconfigure Vaulter's global pnpm. Corepack reads the
    # packageManager pin from the repository and uses an isolated user cache.
    $script:PnpmCommand = $corepack.Source
    $script:PnpmPrefix = @('pnpm')
    $pnpmVersion = "$pinnedPnpm (Corepack, resolution deferred)"
    if ($Stage) {
        Push-Location $RepoRoot
        try {
            $prefix = @($script:PnpmPrefix)
            $resolvedVersion = (& $script:PnpmCommand @prefix --version)
            Assert-Stage ($LASTEXITCODE -eq 0) "Corepack could not load pnpm $pinnedPnpm."
        } finally {
            Pop-Location
        }
        Assert-Stage (([string]$resolvedVersion).Trim() -ceq $pinnedPnpm) "Corepack did not resolve the repository's pinned pnpm $pinnedPnpm."
        $pnpmVersion = "$pinnedPnpm (Corepack)"
    }
}

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

$originalPath = $env:PATH
$pnpmShimDirectory = $null
try {
    if ($script:PnpmPrefix.Count -gt 0) {
        $pnpmShimDirectory = New-PnpmCorepackShim -CorepackPath $script:PnpmCommand
        $env:PATH = "$pnpmShimDirectory;$originalPath"
    }

    Push-Location $RepoRoot
    try {
        if ($pnpmShimDirectory) {
            # Match the CMD lookup used by nested package.json lifecycle steps.
            $nestedVersion = @(& cmd.exe /d /c pnpm --version)
            Assert-Stage ($LASTEXITCODE -eq 0 -and
                (($nestedVersion -join '').Trim() -ceq $pinnedPnpm)) "Nested pnpm must resolve to $pinnedPnpm through Corepack."
        }
        Invoke-WorkspaceCommand -Arguments @('install', '--frozen-lockfile')
        Invoke-WorkspaceCommand -Arguments @('--filter', '@tetherplane/protocol', 'build')
        Invoke-WorkspaceCommand -Arguments @('--filter', '@tetherplane/auth', 'build')
        Invoke-WorkspaceCommand -Arguments @('--filter', '@tetherplane/auth', 'test')
        Invoke-WorkspaceCommand -Arguments @('--filter', '@tetherplane/auth', 'typecheck')
        Invoke-WorkspaceCommand -Arguments @('--filter', '@tetherplane/relay', 'test')
    } finally {
        Pop-Location
    }
} finally {
    $env:PATH = $originalPath
    if ($pnpmShimDirectory -and (Test-Path -LiteralPath $pnpmShimDirectory)) {
        Remove-Item -LiteralPath $pnpmShimDirectory -Recurse -Force
    }
}

$configFile = Join-Path $StateDirectory 'tether-auth-config.json'
$signerFile = Join-Path $StateDirectory 'tether-auth-jwks.json'
$bridgeFile = Join-Path $StateDirectory 'bridge-token.secret'
$databaseFile = Join-Path $StateDirectory 'provider.sqlite'

if ($ReuseExistingState) {
    Assert-Stage (Test-Path -LiteralPath $StateDirectory -PathType Container) 'Existing auth state directory is unavailable.'
    $existingAcl = Get-Acl -LiteralPath $StateDirectory
    Assert-Stage ($existingAcl.AreAccessRulesProtected) 'Existing auth-state directory permissions are not protected.'
    foreach ($requiredFile in @($configFile, $signerFile, $bridgeFile, $databaseFile)) {
        Assert-Stage (Test-Path -LiteralPath $requiredFile -PathType Leaf) 'Existing signing material is unavailable or incomplete. Do not regenerate it.'
    }
    $savedConfig = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    $configValid = (
        ([string]$savedConfig.issuer -ceq "$PublicOrigin/") -and
        ([string]$savedConfig.resource -ceq "$PublicOrigin/mcp") -and
        ([string]$savedConfig.databasePath -ieq $databaseFile) -and
        ([string]$savedConfig.jwksFile -ieq $signerFile) -and
        ([string]$savedConfig.relay.url -ceq 'http://127.0.0.1:8788') -and
        ([string]$savedConfig.relay.bridgeTokenEnv -ceq 'TETHERPLANE_AUTH_BRIDGE_TOKEN') -and
        ($savedConfig.relay.allowInsecureLocalhost -eq $true)
    )
    Assert-Stage $configValid 'Existing OAuth configuration does not match the intended issuer, resource, state files, or loopback relay.'
    $savedJwks = Get-Content -LiteralPath $signerFile -Raw | ConvertFrom-Json
    Assert-Stage (@($savedJwks.keys).Count -gt 0) 'Existing signing material is unavailable.'
    $savedBridge = ([IO.File]::ReadAllText($bridgeFile)).Trim()
    Assert-Stage ($savedBridge -match '^[A-Za-z0-9_-]{60,}$') 'Existing bridge credential file is invalid.'
    Write-Output 'Existing signer, bridge credential, config and SQLite state validated; reusing without rotation.'
} else {
    Assert-Stage (-not (Test-Path -LiteralPath $StateDirectory)) 'Auth state directory already exists; use -Stage -ReuseExistingState only after reviewing the previous staging failure.'

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

    $config = [ordered]@{
        issuer = "$PublicOrigin/"
        resource = "$PublicOrigin/mcp"
        databasePath = $databaseFile
        jwksFile = $signerFile
        relay = [ordered]@{
            url = 'http://127.0.0.1:8788'
            bridgeTokenEnv = 'TETHERPLANE_AUTH_BRIDGE_TOKEN'
            allowInsecureLocalhost = $true
        }
    }
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 8), $utf8NoBom)
}

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
    # Proxy discovery must advertise canonical HTTPS endpoints, not localhost.
    # Only this loopback listener is allowed to trust these forwarded headers.
    $proxyHeaders = @{
        'X-Forwarded-Proto' = 'https'
        'X-Forwarded-Host' = $origin.Authority
    }
    $metadata = Test-HttpJson -Url 'http://127.0.0.1:8790/.well-known/openid-configuration' -Headers $proxyHeaders
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
