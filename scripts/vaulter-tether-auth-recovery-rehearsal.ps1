<#
.SYNOPSIS
  Guarded Windows S4U auth restart rehearsal, with read-only default.
.DESCRIPTION
  -Exercise terminates only the verified task-owned Node auth process to test
  automatic recovery; on failure it attempts manual task recovery, then restores
  staged auth with the protected credential if necessary.
  Reboot recovery remains unverified until tested separately.
#>
[CmdletBinding()]
param([switch]$Exercise)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:taskName = 'Tetherplane-TetherAuth-Startup'
$script:origin = 'https://vaulter.tailf65eba.ts.net'
$script:stateDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:repoDir = Split-Path -Parent $PSScriptRoot
$script:protectedRunner = Join-Path $script:stateDir 'tether-auth-startup-runner.ps1'
$script:authConfig = Join-Path $script:stateDir 'tether-auth-config.json'
$script:postcheck = Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1'

function Assert-Recovery([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Invoke-RestartRecoveryTransaction {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][hashtable]$Operations)
    foreach ($key in @(
        'VerifyBaseline','VerifyCrashTarget','CrashOwnedAuth','WaitAutomatic',
        'StartTaskManually','WaitManual','DisableTask','StopTask',
        'ClearOwnedListener','RestoreStage','VerifyStage'
    )) {
        if (-not $Operations.ContainsKey($key) -or
            -not ($Operations[$key] -is [scriptblock])) {
            throw 'Restart rehearsal operations are incomplete.'
        }
    }
    # No task or process may be changed if either pre-mutation check fails.
    & $Operations['VerifyBaseline']
    & $Operations['VerifyCrashTarget']
    try {
        & $Operations['CrashOwnedAuth']
        & $Operations['WaitAutomatic']
        return 'automatic'
    } catch {
        # Stop-Process may have taken effect before raising an error.
        try {
            & $Operations['StartTaskManually']
            & $Operations['WaitManual']
            return 'manual_only'
        } catch {
            $verified = $true
            foreach ($step in @(
                'DisableTask','StopTask','ClearOwnedListener',
                'RestoreStage','VerifyStage'
            )) {
                try { & $Operations[$step] }
                catch { $verified = $false }
            }
            if (-not $verified) {
                throw 'Auth restart failed; rollback unverified. Do not reboot or modify relay/Funnel.'
            }
            throw 'Auth restart failed; staged auth restored and rollback verified.'
        }
    }
}
function Test-RegisteredRestartPolicy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string]$TaskXml
    )
    try {
        # Compare both persisted Task Scheduler views without leaking task
        # XML, which may contain action paths or account identity.
        [xml]$registered = $TaskXml
        $restart = $registered.SelectSingleNode(
            "//*[local-name()='Settings']/*[local-name()='RestartOnFailure']"
        )
        if ($null -eq $restart) { return $false }
        $countNode = $restart.SelectSingleNode("*[local-name()='Count']")
        $intervalNode = $restart.SelectSingleNode("*[local-name()='Interval']")
        if ($null -eq $countNode -or $null -eq $intervalNode) {
            return $false
        }
        $xmlCount = [int]$countNode.InnerText
        $cimCount = [int]$Settings.RestartCount
        return (
            $xmlCount -eq 10 -and
            $cimCount -eq $xmlCount -and
            ([string]$intervalNode.InnerText) -ceq 'PT1M' -and
            ([string]$Settings.RestartInterval) -ceq 'PT1M'
        )
    } catch { return $false }
}

function Get-Task {
    Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
}
function Get-Flag([string]$CommandLine, [string]$Flag) {
    $pattern = '(?i)(?:^|\s)' + [regex]::Escape($Flag) + '\s+(?:"([^"]+)"|(\S+))'
    $m = [regex]::Match($CommandLine, $pattern)
    if (-not $m.Success) { return $null }
    if ($m.Groups[1].Success) { return $m.Groups[1].Value }
    return $m.Groups[2].Value
}
function Get-AuthPortProcess {
    $ports = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
    if ($ports.Count -eq 0) { return $null }
    Assert-Recovery ($ports.Count -eq 1 -and
        $ports[0].LocalAddress -ceq '127.0.0.1') 'Auth is not bound exclusively to loopback.'
    $listenerPid = [int]$ports[0].OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction Stop
    Assert-Recovery ($null -ne $proc -and $proc.Name -ieq 'node.exe') 'Unexpected listener process.'
    $cmd = [string]$proc.CommandLine
    Assert-Recovery (
        $cmd -match '(?i)(?:^|[\s"\\/])auth[\\/]dist[\\/]cli\.js(?=[\s"]|$)' -and
        (Get-Flag $cmd '--host') -ceq '127.0.0.1' -and
        (Get-Flag $cmd '--port') -ceq '8790' -and
        $cmd.Contains('--allow-insecure-localhost')
    ) 'Listener does not run the intended auth CLI.'
    $cfg = Get-Flag $cmd '--config'
    Assert-Recovery ($cfg -and
        [IO.Path]::GetFullPath($cfg) -ieq $script:authConfig) 'Auth config path changed.'
    return [pscustomobject]@{
        ProcessId = $listenerPid
        ParentProcessId = [int]$proc.ParentProcessId
        CreationDate = $proc.CreationDate
    }
}
function Get-TaskOwnedListener {
    $listener = Get-AuthPortProcess
    if ($null -eq $listener) { return $null }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.ParentProcessId)" -ErrorAction Stop
    Assert-Recovery ($null -ne $parent -and
        $parent.Name -ieq 'powershell.exe') 'Auth listener is not task-owned.'
    Assert-Recovery (
        ([string]$parent.CommandLine).Contains($script:protectedRunner) -and
        ([string]$parent.CommandLine).Contains(' -Serve')
    ) 'Auth is not owned by the protected task runner.'
    return $listener
}
function Get-Json([string]$Url) {
    Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 12 -ErrorAction Stop
}
function Get-PublicJwksFingerprint([string]$Url) {
    $keys = @((Get-Json $Url).keys)
    Assert-Recovery ($keys.Count -gt 0) 'Public JWKS is empty.'
    $rows = @(
        foreach ($key in $keys) {
            $names = @($key.PSObject.Properties.Name)
            foreach ($field in @('d','p','q','dp','dq','qi','oth','k')) {
                Assert-Recovery (-not ($names -contains $field)) 'Public JWK includes a private field.'
            }
            Assert-Recovery ($key.kty -ceq 'RSA' -and
                -not [string]::IsNullOrWhiteSpace([string]$key.kid) -and
                -not [string]::IsNullOrWhiteSpace([string]$key.n) -and
                -not [string]::IsNullOrWhiteSpace([string]$key.e)) 'Public JWK is malformed.'
            [string]$key.kid + '|' + [string]$key.kty + '|' +
                [string]$key.n + '|' + [string]$key.e
        }
    )
    return (($rows | Sort-Object) -join ';')
}
function Verify-SharedState {
    $auth = Get-Json 'http://127.0.0.1:8790/readyz'
    $relay = Get-Json 'http://127.0.0.1:8788/healthz'
    $public = Get-Json "$script:origin/healthz"
    $resource = Get-Json "$script:origin/.well-known/oauth-protected-resource/mcp"
    Assert-Recovery ($auth.status -ceq 'ready' -and
        $relay.status -ceq 'ok' -and $public.status -ceq 'ok') 'Auth or relay not healthy.'
    Assert-Recovery (
        $resource.resource -ceq "$script:origin/mcp" -and
        @($resource.authorization_servers).Count -eq 1 -and
        @($resource.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/'
    ) 'Original Auth0 resource metadata changed.'
    Assert-Recovery (
        (Get-PublicJwksFingerprint 'http://127.0.0.1:8790/jwks') -ceq $script:baselineKeys -and
        (Get-PublicJwksFingerprint "$script:origin/jwks") -ceq $script:baselineKeys
    ) 'Local/public JWKS changed.'
}
function Wait-SupervisedAuth([int]$PriorPid, [int]$Attempts) {
    for ($i = 0; $i -lt $Attempts; $i++) {
        try {
            $listener = Get-TaskOwnedListener
            if ($null -ne $listener -and $listener.ProcessId -ne $PriorPid -and
                (Get-Task).State -eq 'Running') {
                $ready = Get-Json 'http://127.0.0.1:8790/readyz'
                if ($ready.status -ceq 'ready') {
                    & $script:postcheck | Out-Null
                    return
                }
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw 'Scheduled auth restart did not pass independent health and ownership checks.'
}
function Wait-FreePort([int]$Attempts=20) {
    for ($i = 0; $i -lt $Attempts; $i++) {
        $ports = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
        if ($ports.Count -eq 0) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Auth port 8790 remained occupied; refusing duplicate auth startup.'
}

function Stop-TaskOwnedService {
    # Terminate only a Node instance whose current parent is our task runner.
    $owned = Get-TaskOwnedListener
    if ($null -ne $owned) {
        $again = Get-TaskOwnedListener
        Assert-Recovery ($null -ne $again -and
            $again.ProcessId -eq $owned.ProcessId -and
            $again.CreationDate -eq $owned.CreationDate) 'Auth target changed before manual shutdown.'
        Stop-Process -Id $owned.ProcessId -ErrorAction Stop
    }
    if ((Get-Task).State -eq 'Running') {
        Stop-ScheduledTask -TaskName $script:taskName -ErrorAction Stop
    }
}
function Restore-StagedAuth {
    Assert-Recovery ((Get-Task).State -eq 'Disabled') 'Refusing staged rollback while the supervisor task is enabled.'
    Wait-FreePort
    $secretFile = Join-Path $script:stateDir 'bridge-token.secret'
    $secret = ([IO.File]::ReadAllText($secretFile)).Trim()
    Assert-Recovery ($secret -match '^[A-Za-z0-9_-]{60,}$') 'Bridge secret cannot be recovered.'
    $priorEnv = [Environment]::GetEnvironmentVariable('TETHERPLANE_AUTH_BRIDGE_TOKEN','Process')
    try {
        # The bridge credential appears only in the child process environment.
        $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = $secret
        $nonce = [Guid]::NewGuid().ToString('N')
        $stdout = Join-Path $script:stateDir ("tether-auth-recovery-$nonce.stdout.log")
        $stderr = Join-Path $script:stateDir ("tether-auth-recovery-$nonce.stderr.log")
        $args = 'auth/dist/cli.js --config "' + $script:authConfig +
            '" --host 127.0.0.1 --port 8790 --allow-insecure-localhost'
        $started = Start-Process -FilePath $script:nodeExecutable -ArgumentList $args -WorkingDirectory $script:repoDir -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru -ErrorAction Stop
        Assert-Recovery ($null -ne $started) 'Staged auth recovery did not start.'
    } finally {
        $secret = $null
        if ($null -eq $priorEnv) {
            Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue
        } else {
            $env:TETHERPLANE_AUTH_BRIDGE_TOKEN = $priorEnv
        }
    }
}
function Wait-StagedAuth([int]$Attempts=35) {
    for ($i = 0; $i -lt $Attempts; $i++) {
        Start-Sleep -Seconds 1
        try {
            Assert-Recovery ((Get-Task).State -eq 'Disabled') 'Failed S4U task is not disabled.'
            $listener = Get-AuthPortProcess
            if ($null -eq $listener) { continue }
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.ParentProcessId)" -ErrorAction Stop
            if ($null -ne $parent -and
                ([string]$parent.CommandLine).Contains($script:protectedRunner)) {
                throw 'S4U task reappeared instead of the staged fallback.'
            }
            Verify-SharedState
            return
        } catch {
            if ($i -eq ($Attempts - 1)) {
                throw 'Staged auth rollback did not pass health and ownership verification.'
            }
        }
    }
}

# Every source, identity and health gate runs before a deliberate process exit.
Assert-Recovery ($env:OS -eq 'Windows_NT' -and
    $env:COMPUTERNAME -ieq 'vaulter') 'Restart rehearsal is restricted to Vaulter.'
$script:nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
Assert-Recovery (Test-Path -LiteralPath $script:postcheck -PathType Leaf) 'Independent auth postcheck is missing.'
Assert-Recovery (Test-Path -LiteralPath $script:stateDir -PathType Container) 'Protected auth-state directory missing.'
Assert-Recovery ((Get-Acl -LiteralPath $script:stateDir).AreAccessRulesProtected) 'Auth-state ACLs must be protected.'
foreach ($file in @(
    $script:authConfig, $script:protectedRunner,
    (Join-Path $script:stateDir 'tether-auth-jwks.json'),
    (Join-Path $script:stateDir 'provider.sqlite'),
    (Join-Path $script:stateDir 'bridge-token.secret')
)) {
    Assert-Recovery (Test-Path -LiteralPath $file -PathType Leaf) 'A required protected auth runtime file is missing.'
}
$repoRunner = Join-Path $script:repoDir 'scripts\vaulter-tether-auth-startup-runner.ps1'
Assert-Recovery (
    (Get-FileHash -LiteralPath $repoRunner -Algorithm SHA256).Hash -ceq
    (Get-FileHash -LiteralPath $script:protectedRunner -Algorithm SHA256).Hash
) 'Protected S4U task runner differs from the tested source.'
$task = Get-Task
Assert-Recovery ($task.State -eq 'Running' -and
    [string]$task.Principal.LogonType -ceq 'S4U') 'S4U task is not running.'
Assert-Recovery (@($task.Triggers | Where-Object {
    $_.CimClass.CimClassName -match 'BootTrigger$'
}).Count -gt 0) 'Task is missing a boot trigger.'
$registeredXml = [string](Export-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop)
Assert-Recovery (
    Test-RegisteredRestartPolicy -Settings $task.Settings -TaskXml $registeredXml
) 'Registered restart policy must match repaired count=10, interval=PT1M in CIM and XML.'
$taskActions = @($task.Actions)
Assert-Recovery ($taskActions.Count -eq 1 -and
    ([string]$taskActions[0].Arguments).Contains($script:protectedRunner) -and
    ([string]$taskActions[0].Arguments).EndsWith(' -Serve', [StringComparison]::Ordinal)
) 'Scheduled task action no longer executes the expected protected runner.'
# This independent check validates user SID, S4U parent process, healthy OAuth
# and relay, current Auth0 issuer, JWKS, Funnel, and private Tailscale ports.
& $script:postcheck | Out-Null
$originalListener = Get-TaskOwnedListener
Assert-Recovery ($null -ne $originalListener) 'No task-owned auth listener is running.'
$script:originalPid = [int]$originalListener.ProcessId
$script:originalCreationDate = $originalListener.CreationDate
$script:baselineKeys = Get-PublicJwksFingerprint 'http://127.0.0.1:8790/jwks'
Verify-SharedState

if (-not $Exercise) {
    Write-Output "RESTART REHEARSAL PREFLIGHT PASS: auth PID $script:originalPid, S4U task running, restart policy configured."
    Write-Output 'No changes made. -Exercise will intentionally stop the verified auth Node process.'
    return
}

$ops = @{
    VerifyBaseline = {
        & $script:postcheck | Out-Null
        Verify-SharedState
    }
    VerifyCrashTarget = {
        $now = Get-TaskOwnedListener
        Assert-Recovery (
            $null -ne $now -and
            $now.ProcessId -eq $script:originalPid -and
            $now.CreationDate -eq $script:originalCreationDate -and
            (Get-Task).State -eq 'Running'
        ) 'Auth PID, creation time or task ownership changed before the crash rehearsal.'
        $checked = Get-Process -Id $script:originalPid -ErrorAction Stop
        Assert-Recovery ($checked.ProcessName -ieq 'node') 'Restart target no longer matches Node.js.'
    }
    CrashOwnedAuth = {
        # Intentional failure injection: stop only the verified task-owned PID.
        Stop-Process -Id $script:originalPid -ErrorAction Stop
    }
    WaitAutomatic = {
        Wait-SupervisedAuth -PriorPid $script:originalPid -Attempts 75
    }
    StartTaskManually = {
        # Manual recovery is reported as a failure of automatic restart.
        Stop-TaskOwnedService
        Wait-FreePort
        Start-ScheduledTask -TaskName $script:taskName -ErrorAction Stop
    }
    WaitManual = {
        Wait-SupervisedAuth -PriorPid $script:originalPid -Attempts 35
    }
    DisableTask = {
        Disable-ScheduledTask -TaskName $script:taskName -ErrorAction Stop | Out-Null
        Assert-Recovery ((Get-Task).State -eq 'Disabled') 'Could not disable the failed task.'
    }
    StopTask = {
        Stop-TaskOwnedService
    }
    ClearOwnedListener = {
        Wait-FreePort
    }
    RestoreStage = {
        Restore-StagedAuth
    }
    VerifyStage = {
        Wait-StagedAuth
    }
}
$recoveryResult = Invoke-RestartRecoveryTransaction -Operations $ops
if ($recoveryResult -ceq 'automatic') {
    $replacement = Get-TaskOwnedListener
    Write-Output "RESTART AUTOMATICALLY VERIFIED: oldPID=$script:originalPid, newPID=$($replacement.ProcessId), auth ready."
} elseif ($recoveryResult -ceq 'manual_only') {
    Write-Output 'Automatic restart FAILED; manual task restart verified with unchanged Auth0 and public signing keys.'
} else {
    throw 'Unexpected recovery rehearsal result.'
}
Write-Output 'Reboot recovery remains unverified. Process restart does not prove unattended startup.'
