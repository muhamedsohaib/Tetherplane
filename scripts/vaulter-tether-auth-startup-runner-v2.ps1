<#
.SYNOPSIS
  Restricted tether-auth startup task runner for Vaulter.
.DESCRIPTION
  Use only via the verified S4U scheduled task. The task arguments contain file
  paths, never the bridge secret. No secrets are printed by this runner.
  -Validate checks encrypted-state access and both loopback health endpoints.
  -Serve supervises one Node auth child at a time, with capped retry backoff, using the existing issuer, signing key and SQLite. This v2 candidate is not deployed automatically.
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

function Invoke-TetherAuthChildSupervisor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][hashtable]$Operations,
        [int]$MaxRunsForTest = 0
    )
    if ($MaxRunsForTest -lt 0) { throw 'Invalid supervisor test budget.' }
    foreach ($key in @('AssertPortVacant','RunChild','PauseBeforeRestart')) {
        if (-not $Operations.ContainsKey($key) -or
            -not ($Operations[$key] -is [scriptblock])) {
            throw 'Incomplete auth child supervision operations.'
        }
    }
    # Zero means persistent production supervision. The positive bound is
    # exclusively for pure, mocked contract tests.
    $consecutiveShortRuns = 0
    $runCount = 0
    while ($true) {
        # No process may be started if anything else owns the auth port.
        & $Operations['AssertPortVacant']
        # Await the existing Node child synchronously. No detached process,
        # physical keyboard, desktop window or scheduled-task changes.
        $outcome = & $Operations['RunChild']
        if ($null -eq $outcome) { throw 'Child launch returned no termination status.' }
        try {
            if ($null -eq $outcome.UptimeSeconds -or $null -eq $outcome.ExitCode) {
                throw 'Missing child termination fields.'
            }
            $uptime = [double]$outcome.UptimeSeconds
            $exitCode = [int]$outcome.ExitCode
        } catch {
            throw 'Invalid child termination status.'
        }
        if ($uptime -lt 0 -or [double]::IsNaN($uptime) -or [double]::IsInfinity($uptime)) {
            throw 'Invalid child process uptime.'
        }
        # The auth server is a long-running service. Even exit code zero is
        # unexpected unless its protected PowerShell task is being stopped.
        $runCount++
        if ($MaxRunsForTest -gt 0 -and $runCount -ge $MaxRunsForTest) {
            return 'test_limit'
        }
        # A child surviving five minutes resets the exponential backoff.
        if ($uptime -ge 300) { $consecutiveShortRuns = 0 }
        $consecutiveShortRuns = [Math]::Min(7, $consecutiveShortRuns + 1)
        $delaySeconds = [int][Math]::Min(60,
            [Math]::Pow(2, $consecutiveShortRuns - 1))
        & $Operations['PauseBeforeRestart'] $delaySeconds
    }
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

    $supervisorOps = @{
        AssertPortVacant = {
            # A controlled task disable must prevent respawn. Never start
            # against a mismatched service principal or an occupied port.
            $managed = Get-ScheduledTask -TaskName 'Tetherplane-TetherAuth-Startup' -TaskPath '\' -ErrorAction Stop
            Assert-Runner ([bool]$managed.Settings.Enabled -and
                [string]$managed.Principal.LogonType -ceq 'S4U') 'Auth task is disabled or no longer S4U.'
            $occupied = @(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)
            Assert-Runner ($occupied.Count -eq 0) 'Port 8790 occupied; refusing duplicate auth process.'
        }
        RunChild = {
            $began = [datetime]::UtcNow
            # Do not put process output or potentially sensitive error lines
            # into the supervisor return pipeline or Task Scheduler output.
            & $NodeExecutable $entryPoint --config $authConfig --host '127.0.0.1' --port '8790' --allow-insecure-localhost 1>$null 2>$null
            [pscustomobject]@{
                ExitCode = [int]$LASTEXITCODE
                UptimeSeconds = [double]([datetime]::UtcNow - $began).TotalSeconds
            }
        }
        PauseBeforeRestart = {
            param([int]$Seconds)
            Start-Sleep -Seconds $Seconds
        }
    }
    Push-Location -LiteralPath $RepoRoot
    try {
        Invoke-TetherAuthChildSupervisor -Operations $supervisorOps | Out-Null
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
