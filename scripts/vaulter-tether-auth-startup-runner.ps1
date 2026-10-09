<#
.SYNOPSIS
  Restricted tether-auth startup task runner for Vaulter.
.DESCRIPTION
  Use only via the verified S4U scheduled task. The task arguments contain file
  paths, never the bridge secret. No secrets are printed by this runner.
  -Validate checks encrypted-state access and both loopback health endpoints.
  -Serve starts the auth server with the existing issuer, signing key and SQLite.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$StateDirectory,
    [Parameter(Mandatory=$true)][string]$RepoRoot,
    [Parameter(Mandatory=$true)][string]$NodeExecutable,
    [switch]$Validate,
    [switch]$Serve,
    [string]$ProbeResultFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Runner([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

if ($Validate -eq $Serve) {
    throw 'Specify exactly one of -Validate or -Serve.'
}
if ($Serve -and $ProbeResultFile) {
    throw 'Probe result files are forbidden when starting the service.'
}

$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$NodeExecutable = [IO.Path]::GetFullPath($NodeExecutable)

$probePath = $null
if ($ProbeResultFile) {
    $probePath = [IO.Path]::GetFullPath($ProbeResultFile)
    $parentPath = [IO.Path]::GetDirectoryName($probePath)
    Assert-Runner ($parentPath -ieq $StateDirectory) 'Probe result must remain inside private auth-state directory.'
    Assert-Runner ([IO.Path]::GetFileName($probePath) -match '^s4u-probe-[a-f0-9]{32}\.result$') 'Probe marker filename is invalid.'
}

$oldToken = [Environment]::GetEnvironmentVariable('TETHERPLANE_AUTH_BRIDGE_TOKEN', 'Process')
try {
    Assert-Runner ($env:OS -eq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'vaulter') 'Auth runner is restricted to Vaulter.'
    Assert-Runner (Test-Path -LiteralPath $StateDirectory -PathType Container) 'Protected auth-state directory unavailable.'
    Assert-Runner ((Get-Acl -LiteralPath $StateDirectory).AreAccessRulesProtected) 'Auth-state ACLs must be protected.'
    Assert-Runner (Test-Path -LiteralPath $NodeExecutable -PathType Leaf) 'Node.js executable unavailable.'
    $entryPoint = Join-Path $RepoRoot 'auth\dist\cli.js'
    $authConfig = Join-Path $StateDirectory 'tether-auth-config.json'
    $jwksFile = Join-Path $StateDirectory 'tether-auth-jwks.json'
    $bridgeFile = Join-Path $StateDirectory 'bridge-token.secret'
    $database = Join-Path $StateDirectory 'provider.sqlite'
    foreach ($file in @($entryPoint, $authConfig, $jwksFile, $bridgeFile, $database)) {
        Assert-Runner (Test-Path -LiteralPath $file -PathType Leaf) 'Required protected auth runtime file missing.'
    }

    $cfg = Get-Content -LiteralPath $authConfig -Raw | ConvertFrom-Json -ErrorAction Stop
    Assert-Runner (
        ([string]$cfg.issuer -ceq 'https://vaulter.tailf65eba.ts.net/') -and
        ([string]$cfg.resource -ceq 'https://vaulter.tailf65eba.ts.net/mcp') -and
        ([string]$cfg.jwksFile -ieq $jwksFile) -and
        ([string]$cfg.databasePath -ieq $database) -and
        ([string]$cfg.relay.url -ceq 'http://127.0.0.1:8788') -and
        ([string]$cfg.relay.bridgeTokenEnv -ceq 'TETHERPLANE_AUTH_BRIDGE_TOKEN') -and
        ($cfg.relay.allowInsecureLocalhost -eq $true)
    ) 'Auth deployment metadata no longer matches intended loopback/issuer.'

    # Ensure S4U can actually read existing protected files. Do not output data.
    $jwkDocument = [IO.File]::ReadAllText($jwksFile) | ConvertFrom-Json
    Assert-Runner (@($jwkDocument.keys).Count -gt 0) 'Signing keys unavailable.'
    $bridgeToken = ([IO.File]::ReadAllText($bridgeFile)).Trim()
    Assert-Runner ($bridgeToken -match '^[A-Za-z0-9_-]{60,}$') 'Bridge credential cannot be read.'

    $nodeVersion = (& $NodeExecutable -p 'process.versions.node')
    Assert-Runner ($LASTEXITCODE -eq 0 -and [int](([string]$nodeVersion).Split('.')[0]) -ge 22) 'Node.js runtime is incompatible.'

    if ($Validate) {
        # S4U logon may lack network credentials. Verify that it can actually
        # reach loopback sockets before registering any permanent startup task.
        $relayHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 10
        $authReady = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/readyz' -TimeoutSec 10
        Assert-Runner ($relayHealth.status -eq 'ok' -and $authReady.status -eq 'ready') 'S4U session cannot reach healthy local services.'
        if ($probePath) {
            Assert-Runner (-not (Test-Path -LiteralPath $probePath)) 'Existing probe marker may not be replaced.'
            [IO.File]::WriteAllText($probePath, 'PASS', [System.Text.Encoding]::ASCII)
        }
        return
    }

    $listener = @(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)
    Assert-Runner ($listener.Count -eq 0) 'Port 8790 already has a listener; do not start a duplicate auth service.'

    # The secret goes into THIS PROCESS environment only; never a task action
    # argument, command line, working copy, printed value or log.
    $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = $bridgeToken
    $bridgeToken = $null
    $jwkDocument = $null

    Push-Location -LiteralPath $RepoRoot
    try {
        & $NodeExecutable $entryPoint --config $authConfig --host '127.0.0.1' --port '8790' --allow-insecure-localhost
        if ($LASTEXITCODE -ne 0) {
            throw 'tether-auth process exited unsuccessfully.'
        }
    } finally {
        Pop-Location
    }
} catch {
    # Fail closed. Task Scheduler will record a nonzero exit without leaking
    # any sensitive input or raw exception payload.
    if ($probePath -and -not (Test-Path -LiteralPath $probePath)) {
        try { [IO.File]::WriteAllText($probePath, 'FAIL', [System.Text.Encoding]::ASCII) }
        catch { }
    }
    throw 'Tetherplane auth task verification/startup failed (secret details omitted).'
} finally {
    if ($null -eq $oldToken) {
        Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue
    } else {
        $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = $oldToken
    }
}
