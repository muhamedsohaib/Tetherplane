<#
.SYNOPSIS
  Preflight or transactional activation of Vaulter's registered tether-auth task.
.DESCRIPTION
  Default: read-only checks. -Activate stops only the verified staging auth
  Node process on port 8790, enables/starts the existing S4U startup task,
  verifies task ownership, OAuth health, public JWKS and unchanged Auth0 relay.
  If a step fails, disables/stops that task and attempts verified restoration
  of the original staged auth process using the original protected state.
  No identities or secrets printed. No Funnel or relay changes.
#>
[CmdletBinding()]
param(
    [switch]$Activate,
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$taskName = 'Tetherplane-TetherAuth-Startup'
$origin = 'https://vaulter.tailf65eba.ts.net'

function Assert-Activation([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

# This separately testable transaction never assumes a failing operation had
# no side effects. It attempts every rollback step, even after a rollback error.
function Invoke-GuardedAuthHandover {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][hashtable]$Operations)

    foreach ($key in @('StopStage','EnableTask','StartTask','VerifyNew',
                       'StopTask','DisableTask','RestoreStage','VerifyRestore')) {
        if (-not $Operations.ContainsKey($key) -or
            -not ($Operations[$key] -is [scriptblock])) {
            throw 'Auth handover operations are incomplete.'
        }
    }
    try {
        foreach ($key in @('StopStage','EnableTask','StartTask','VerifyNew')) {
            $step = $Operations[$key]
            & $step
        }
        return 'activated'
    } catch {
        $rollbackComplete = $true
        foreach ($key in @('StopTask','DisableTask','RestoreStage','VerifyRestore')) {
            try {
                $step = $Operations[$key]
                & $step
            } catch {
                $rollbackComplete = $false
            }
        }
        if (-not $rollbackComplete) {
            throw 'Auth activation failed; rollback unverified. Do not reboot or modify Funnel/relay. Inspect protected local state and task status.'
        }
        throw 'Auth activation failed; staged tether-auth was rolled back and recovery verified.'
    }
}

function Get-Json([string]$Url) {
    Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 12 -ErrorAction Stop
}

function Get-FlagValue([string]$CommandLine, [string]$Flag) {
    if (-not $CommandLine) { return $null }
    $pattern = '(?i)(?:^|\s)' + [regex]::Escape($Flag) + '\s+(?:"([^"]+)"|(\S+))'
    $match = [regex]::Match($CommandLine, $pattern)
    if (-not $match.Success) { return $null }
    if ($match.Groups[1].Success) { return $match.Groups[1].Value }
    return $match.Groups[2].Value
}

function Get-AuthListener {
    $connections = @(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue)
    if ($connections.Count -eq 0) { return $null }
    Assert-Activation ($connections.Count -eq 1 -and
        $connections[0].LocalAddress -ceq '127.0.0.1') 'Auth listener unexpectedly changed binding.'
    $id = [int]$connections[0].OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop
    Assert-Activation ($null -ne $proc -and $proc.Name -ieq 'node.exe') 'Auth listener is not owned by the expected Node.js process.'
    $cmd = [string]$proc.CommandLine

    # Match both relative staging and absolute scheduled-runner entrypoints.
    Assert-Activation ($cmd -match '(?i)(?:^|[\s"\\/])auth[\\/]dist[\\/]cli\.js(?=[\s"]|$)') 'Auth listener does not execute tether-auth.'
    $configuredPath = Get-FlagValue $cmd '--config'
    Assert-Activation ($configuredPath -and
        ([IO.Path]::GetFullPath($configuredPath) -ieq $script:authConfig)) 'Auth listener does not use the existing protected config.'
    Assert-Activation ((Get-FlagValue $cmd '--host') -ceq '127.0.0.1' -and
        (Get-FlagValue $cmd '--port') -ceq '8790' -and
        $cmd.Contains('--allow-insecure-localhost')) 'Auth listener flags do not match the approved loopback serving mode.'
    return [pscustomobject]@{
        ProcessId = $id
        ParentProcessId = [int]$proc.ParentProcessId
        CreationDate = $proc.CreationDate
    }
}

function Get-PublicJwksFingerprint([string]$Url) {
    $keys = @((Get-Json $Url).keys)
    Assert-Activation ($keys.Count -gt 0) 'Authorization server publishes no public signing keys.'
    $rows = @(
        foreach ($key in $keys) {
            $names = @($key.PSObject.Properties.Name)
            foreach ($secret in @('d','p','q','dp','dq','qi','oth','k')) {
                Assert-Activation (-not ($names -contains $secret)) 'Public JWKS contains a private field.'
            }
            Assert-Activation ($key.kty -ceq 'RSA' -and
                -not [string]::IsNullOrWhiteSpace([string]$key.kid) -and
                -not [string]::IsNullOrWhiteSpace([string]$key.n) -and
                -not [string]::IsNullOrWhiteSpace([string]$key.e)) 'Public JWKS key is malformed.'
            # Never print the key material or fingerprint.
            [string]$key.kid + '|' + [string]$key.kty + '|' +
                [string]$key.n + '|' + [string]$key.e
        }
    )
    return (($rows | Sort-Object) -join ';')
}

function VerifyExistingAuth {
    $relay = Get-Json 'http://127.0.0.1:8788/healthz'
    $public = Get-Json "$origin/healthz"
    $ready = Get-Json 'http://127.0.0.1:8790/readyz'
    Assert-Activation ($relay.status -ceq 'ok' -and
        $public.status -ceq 'ok' -and
        $ready.status -ceq 'ready') 'Auth/relay service health is not satisfactory.'
    $resource = Get-Json "$origin/.well-known/oauth-protected-resource/mcp"
    Assert-Activation ($resource.resource -ceq "$origin/mcp" -and
        @($resource.authorization_servers).Count -eq 1 -and
        @($resource.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Public MCP issuer/resource unexpectedly changed.'
    Assert-Activation (
        (Get-PublicJwksFingerprint 'http://127.0.0.1:8790/jwks') -ceq $script:baselineFingerprint -and
        (Get-PublicJwksFingerprint "$origin/jwks") -ceq $script:baselineFingerprint
    ) 'Public or local JWKS changed during handover.'
}

function Get-TaskState {
    Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
}

function VerifySupervisedAuth {
    $listener = Get-AuthListener
    Assert-Activation ($null -ne $listener -and
        $listener.ProcessId -ne $script:stagedPid) 'Scheduled auth listener was not replaced.'
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.ParentProcessId)" -ErrorAction Stop
    Assert-Activation ($null -ne $parent -and $parent.Name -ieq 'powershell.exe') 'Scheduled auth process has an unexpected parent.'
    Assert-Activation (
        ([string]$parent.CommandLine).Contains($script:protectedRunner) -and
        ([string]$parent.CommandLine).Contains(' -Serve')
    ) 'Auth listener is not a child of the registered protected startup runner.'
    Assert-Activation ((Get-TaskState).State -eq 'Running') 'Startup task is not running.'
    VerifyExistingAuth
}

function VerifyRestoredAuth {
    Assert-Activation ((Get-TaskState).State -eq 'Disabled') 'Startup task is not disabled following rollback.'
    $listener = Get-AuthListener
    Assert-Activation ($null -ne $listener) 'Staged auth listener not restored.'
    VerifyExistingAuth
}

function Stop-TaskOwnedAuth {
    # The task may have started even if Start-ScheduledTask reported an error.
    $runningTask = Get-TaskState
    if ($runningTask.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $script:taskName -ErrorAction Stop
    }
    Start-Sleep -Milliseconds 500
    $listener = Get-AuthListener
    if ($null -eq $listener -or $listener.ProcessId -eq $script:stagedPid) { return }

    # Only terminate a Node process still demonstrably launched by OUR task.
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($null -ne $parent -and $parent.Name -ieq 'powershell.exe' -and
        ([string]$parent.CommandLine).Contains($script:protectedRunner) -and
        ([string]$parent.CommandLine).Contains(' -Serve')) {
        Stop-Process -Id $listener.ProcessId -ErrorAction Stop
        Start-Sleep -Milliseconds 500
    }
    $remaining = Get-AuthListener
    Assert-Activation ($null -eq $remaining -or $remaining.ProcessId -eq $script:stagedPid) 'Scheduled auth process still owns loopback port; rollback cannot safely replace it.'
}

function Restore-StagedAuth {
    $listener = Get-AuthListener
    if ($null -ne $listener) {
        Assert-Activation ($listener.ProcessId -eq $script:stagedPid) 'Unexpected listener blocks stage restoration.'
        return
    }
    $secretFile = Join-Path $script:stateDir 'bridge-token.secret'
    $token = ([IO.File]::ReadAllText($secretFile)).Trim()
    Assert-Activation ($token -match '^[A-Za-z0-9_-]{60,}$') 'Protected bridge credential cannot be loaded.'
    $original = [Environment]::GetEnvironmentVariable('TETHERPLANE_AUTH_BRIDGE_TOKEN','Process')
    try {
        $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = $token
        $logId = [Guid]::NewGuid().ToString('N')
        $stdout = Join-Path $script:stateDir ("tether-auth-recovery-$logId.stdout.log")
        $stderr = Join-Path $script:stateDir ("tether-auth-recovery-$logId.stderr.log")
        $argumentText = 'auth/dist/cli.js --config "' + $script:authConfig +
            '" --host 127.0.0.1 --port 8790 --allow-insecure-localhost'
        $newProcess = Start-Process -FilePath $script:nodeExecutable -ArgumentList $argumentText -WorkingDirectory $script:repoDir -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru -ErrorAction Stop
        Assert-Activation ($null -ne $newProcess) 'Could not relaunch original staged auth.'
    } finally {
        if ($null -eq $original) {
            Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue
        } else {
            $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = $original
        }
        $token = $null
    }
}

function Wait-VerifiedAuth([scriptblock]$Verify, [int]$MaxAttempts = 35) {
    for ($i = 0; $i -lt $MaxAttempts; $i++) {
        Start-Sleep -Seconds 1
        try {
            & $Verify
            return
        } catch {
            if ($i -eq ($MaxAttempts-1)) {
                throw 'Auth did not pass ownership/health verification within the deadline.'
            }
        }
    }
}

Assert-Activation ($env:OS -eq 'Windows_NT' -and
    $env:COMPUTERNAME -ieq 'vaulter') 'Auth activation runs only on Vaulter.'
$script:repoDir = [IO.Path]::GetFullPath($RepoRoot)
$script:stateDir = [IO.Path]::GetFullPath($StateDirectory)
$script:authConfig = Join-Path $script:stateDir 'tether-auth-config.json'
$script:protectedRunner = Join-Path $script:stateDir 'tether-auth-startup-runner.ps1'
$sourceRunner = Join-Path $script:repoDir 'scripts\vaulter-tether-auth-startup-runner.ps1'
$script:nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source

Assert-Activation (Test-Path -LiteralPath $script:stateDir -PathType Container) 'Protected auth-state directory missing.'
Assert-Activation ((Get-Acl -LiteralPath $script:stateDir).AreAccessRulesProtected) 'Auth state ACL is not protected.'
foreach ($file in @($script:authConfig, $script:protectedRunner, $sourceRunner,
        (Join-Path $script:stateDir 'bridge-token.secret'),
        (Join-Path $script:stateDir 'provider.sqlite'),
        (Join-Path $script:stateDir 'tether-auth-jwks.json'))) {
    Assert-Activation (Test-Path -LiteralPath $file -PathType Leaf) 'Required auth-state or startup-runner file missing.'
}
Assert-Activation (
    (Get-FileHash -LiteralPath $sourceRunner -Algorithm SHA256).Hash -ceq
    (Get-FileHash -LiteralPath $script:protectedRunner -Algorithm SHA256).Hash
) 'Protected startup runner differs from registered and verified source.'
$config = Get-Content -LiteralPath $script:authConfig -Raw | ConvertFrom-Json
Assert-Activation (
    $config.issuer -ceq "$origin/" -and
    $config.resource -ceq "$origin/mcp" -and
    $config.relay.url -ceq 'http://127.0.0.1:8788' -and
    $config.relay.bridgeTokenEnv -ceq 'TETHERPLANE_AUTH_BRIDGE_TOKEN' -and
    $config.databasePath -ieq (Join-Path $script:stateDir 'provider.sqlite') -and
    $config.jwksFile -ieq (Join-Path $script:stateDir 'tether-auth-jwks.json')
) 'Existing auth deployment metadata is not the expected Vaulter configuration.'

$task = Get-TaskState
$windowsIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
Assert-Activation ($task.State -eq 'Disabled' -and
    [string]$task.Principal.LogonType -ceq 'S4U' -and
    [string]$task.Principal.UserId -ieq $windowsIdentity.Name) 'Registered task is not disabled or does not match the S4U state owner.'
Assert-Activation (@($task.Triggers | Where-Object {
    $_.CimClass.CimClassName -match 'BootTrigger$'
}).Count -gt 0) 'Registered task has no system-startup trigger.'
Assert-Activation ($task.Settings.RestartCount -gt 0) 'Registered task lacks restart policy.'
Assert-Activation (@($task.Actions).Count -eq 1) 'Registered task must have exactly one action.'
$taskAction = @($task.Actions)[0]
$expectedPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Assert-Activation ([string]$taskAction.Execute -ieq $expectedPowerShell) 'Task does not use the pinned Windows PowerShell executable.'
$commandLine = [string]$taskAction.Arguments
Assert-Activation (
    $commandLine.Contains(' -File "' + $script:protectedRunner + '"') -and
    $commandLine.Contains(' -StateDirectory "' + $script:stateDir + '"') -and
    $commandLine.Contains(' -RepoRoot "' + $script:repoDir + '"') -and
    $commandLine.Contains(' -NodeExecutable "' + $script:nodeExecutable + '"') -and
    $commandLine.EndsWith(' -Serve', [StringComparison]::Ordinal)
) 'Registered task action differs from expected protected runner.'

$staged = Get-AuthListener
Assert-Activation ($null -ne $staged) 'Existing staged auth listener is unavailable.'
$script:stagedPid = [int]$staged.ProcessId
$script:stageCreationDate = $staged.CreationDate

$script:baselineFingerprint = Get-PublicJwksFingerprint 'http://127.0.0.1:8790/jwks'
VerifyExistingAuth
$ts = Get-Command tailscale.exe -ErrorAction Stop
$funnel = @(& $ts.Source funnel status)
Assert-Activation ($LASTEXITCODE -eq 0) 'Cannot read current Funnel routing.'
$funnelText = $funnel -join [Environment]::NewLine
Assert-Activation (
    $funnelText.Contains("$origin (Funnel on)") -and
    $funnelText.Contains('|-- / proxy http://127.0.0.1:8788') -and
    $funnelText.Contains('/jwks proxy http://127.0.0.1:8790/jwks')
) 'Baseline Funnel routes have changed.'

if (-not $Activate) {
    Write-Output "Auth handover preflight PASS: staged PID $script:stagedPid, S4U task disabled; public JWKS unchanged."
    Write-Output 'No changes made. Use -Activate only for a guarded scheduled-task handover.'
    return
}

$ops = @{
    StopStage = {
        $current = Get-AuthListener
        Assert-Activation ($null -ne $current -and
            $current.ProcessId -eq $script:stagedPid -and
            $current.CreationDate -eq $script:stageCreationDate) 'Staging process changed before activation; refusing to stop an unrelated process.'
        $processCheck = Get-Process -Id $script:stagedPid -ErrorAction Stop
        Assert-Activation ($processCheck.ProcessName -ieq 'node') 'Staged process is no longer the expected Node.js process.'
        Stop-Process -Id $script:stagedPid -ErrorAction Stop
        for ($i=0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            if ($null -eq (Get-AuthListener)) { return }
        }
        throw 'Original staged auth did not release port 8790.'
    }
    EnableTask = {
        Enable-ScheduledTask -TaskName $script:taskName -ErrorAction Stop | Out-Null
        Assert-Activation ((Get-TaskState).State -ne 'Disabled') 'Task remained disabled.'
    }
    StartTask = {
        Start-ScheduledTask -TaskName $script:taskName -ErrorAction Stop
    }
    VerifyNew = {
        Wait-VerifiedAuth { VerifySupervisedAuth }
    }
    StopTask = {
        Stop-TaskOwnedAuth
    }
    DisableTask = {
        Disable-ScheduledTask -TaskName $script:taskName -ErrorAction Stop | Out-Null
        Assert-Activation ((Get-TaskState).State -eq 'Disabled') 'Could not disable auth startup task.'
    }
    RestoreStage = {
        Restore-StagedAuth
    }
    VerifyRestore = {
        Wait-VerifiedAuth { VerifyRestoredAuth }
    }
}

$status = Invoke-GuardedAuthHandover -Operations $ops
Assert-Activation ($status -ceq 'activated') 'Unexpected handover result.'
$finalListener = Get-AuthListener
Write-Output "AUTH SUPERVISION ACTIVE: task=$taskName, listenerPID=$($finalListener.ProcessId), S4U startup task running."
Write-Output 'Local/public JWKS and Auth0 relay are unchanged. No identities or secrets printed.'
Write-Output 'A restart/reboot recovery test is still required before declaring unattended startup fully verified.'
