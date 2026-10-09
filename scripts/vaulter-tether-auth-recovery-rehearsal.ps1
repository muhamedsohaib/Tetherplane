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
param([switch]$Exercise, [switch]$RefreshSupervisor)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:taskName = 'Tetherplane-TetherAuth-Startup'
$script:origin = 'https://vaulter.tailf65eba.ts.net'
$script:stateDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:repoDir = Split-Path -Parent $PSScriptRoot
$script:protectedRunner = Join-Path $script:stateDir 'tether-auth-startup-runner.ps1'
$script:authConfig = Join-Path $script:stateDir 'tether-auth-config.json'
$script:postcheck = Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1'
. (Join-Path $PSScriptRoot 'vaulter-tether-auth-runner-integrity.ps1')

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
function Invoke-GuardedSupervisorRefresh {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][hashtable]$Operations)
    foreach ($name in @(
        'VerifyBaseline','VerifyTarget','QuiesceTask','StopOwnedTask',
        'VerifyVacant','ReenableTask','StartTask','VerifyNewTask',
        'RestoreTask','VerifyRecoveredTask',
        'DisableTask','StopTask','ClearListener',
        'RecoverOriginalV1','VerifyRecoveredV1','RestoreStage','VerifyStage'
    )) {
        if (-not $Operations.ContainsKey($name) -or
            -not ($Operations[$name] -is [scriptblock])) {
            throw 'Supervisor refresh operation missing.'
        }
    }
    & $Operations['VerifyBaseline']
    & $Operations['VerifyTarget']
    try {
        foreach ($name in @(
            'QuiesceTask','StopOwnedTask','VerifyVacant',
            'ReenableTask','StartTask','VerifyNewTask'
        )) { & $Operations[$name] }
        return 'refreshed'
    } catch {
        try {
            & $Operations['RestoreTask']
            & $Operations['VerifyRecoveredTask']
            return 'manually_restored'
        } catch {
            # First recover the exact protected v1 task. A healthy staged
            # fallback remains available if original v1 recovery fails.
            try {
                foreach ($name in @(
                    'DisableTask','StopTask','ClearListener',
                    'RecoverOriginalV1','VerifyRecoveredV1'
                )) { & $Operations[$name] }
                return 'v1_restored'
            } catch {
                $verified = $true
                foreach ($name in @(
                    'DisableTask','StopTask','ClearListener',
                    'RestoreStage','VerifyStage'
                )) {
                    try { & $Operations[$name] }
                    catch { $verified = $false }
                }
                if (-not $verified) {
                    throw 'SUPERVISOR REFRESH FAILED; rollback unverified. Do not reboot or change relay/Funnel.'
                }
                throw 'SUPERVISOR REFRESH FAILED; staged auth restored and rollback verified.'
            }
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
function Format-RecoveryObservation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Phase,
        [Parameter(Mandatory=$true)][int]$ElapsedSeconds,
        [Parameter(Mandatory=$true)][bool]$ParentAlive,
        [Parameter(Mandatory=$true)][string]$TaskState,
        [Parameter(Mandatory=$true)][string]$ResultCode,
        [Parameter(Mandatory=$true)][string]$ListenerState
    )
    # Only allowlisted statuses reach the terminal; never raw command text.
    $safePhase = if (@('automatic','manual') -ccontains $Phase) { $Phase } else { 'unknown' }
    $safeTask = if (@('Running','Ready','Queued','Disabled','Unknown') -ccontains $TaskState) { $TaskState } else { 'Unknown' }
    $safeResult = if ($ResultCode -cmatch '^0x[0-9A-F]{8}$') { $ResultCode } else { 'unknown' }
    $safeListener = if (@('none','original','replacement','unknown') -ccontains $ListenerState) { $ListenerState } else { 'unknown' }
    $safeSeconds = [Math]::Max(0, [Math]::Min($ElapsedSeconds, 3600))
    $parentState = if ($ParentAlive) { 'alive' } else { 'exited' }
    return ('RESTART TRACE: phase={0}; elapsed_s={1}; original_parent={2}; task={3}; scheduler_result={4}; listener={5}' -f $safePhase,$safeSeconds,$parentState,$safeTask,$safeResult,$safeListener)
}

function Wait-SupervisedAuth([int]$PriorPid, [int]$Attempts, [switch]$TraceAutomatic) {
    $began = Get-Date
    for ($i = 0; $i -lt $Attempts; $i++) {
        if ($TraceAutomatic -and ($i % 10 -eq 0)) {
            # Read only process existence, scheduler status, and listener ownership.
            # Never expose task action, command line, account or credentials.
            $parentAlive = $false
            $taskState = 'Unknown'
            $resultCode = 'unknown'
            $listenerState = 'unknown'
            try {
                $originalParent = Get-CimInstance Win32_Process -Filter "ProcessId=$script:originalParentPid" -ErrorAction Stop
                $parentAlive = ($null -ne $originalParent -and $originalParent.CreationDate -eq $script:originalParentCreationDate)
            } catch { }
            try {
                $taskState = [string](Get-Task).State
                $info = Get-ScheduledTaskInfo -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
                $resultCode = '0x{0:X8}' -f ([uint32](([long]$info.LastTaskResult) -band 4294967295))
            } catch { }
            try {
                $ports = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
                if ($ports.Count -eq 0) {
                    $listenerState = 'none'
                } elseif ($ports.Count -eq 1 -and $ports[0].LocalAddress -ceq '127.0.0.1') {
                    $listenerState = if ([int]$ports[0].OwningProcess -eq $PriorPid) { 'original' } else { 'replacement' }
                }
            } catch { }
            $elapsed = [int][Math]::Floor(((Get-Date) - $began).TotalSeconds)
            # Host output cannot alter the transaction's automatic/manual status.
            Write-Host (Format-RecoveryObservation -Phase 'automatic' -ElapsedSeconds $elapsed -ParentAlive $parentAlive -TaskState $taskState -ResultCode $resultCode -ListenerState $listenerState)
        }
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
    if ($TraceAutomatic) {
        Write-Host 'RESTART TRACE: automatic wait exhausted; entering guarded manual recovery.'
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
function Wait-HealthyTask([int]$Attempts=35) {
    for ($i=0; $i -lt $Attempts; $i++) {
        try {
            $owned = Get-TaskOwnedListener
            $task = Get-Task
            if ($null -ne $owned -and $task.State -eq 'Running' -and
                [bool]$task.Settings.Enabled -and
                (Get-Json 'http://127.0.0.1:8790/readyz').status -ceq 'ready') {
                & $script:postcheck | Out-Null
                Verify-SharedState
                $xml = [string](Export-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop)
                Assert-Recovery (Test-RegisteredRestartPolicy -Settings $task.Settings -TaskXml $xml) 'Restart policy changed while recovering task.'
                return
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw 'Task did not recover as a healthy S4U-owned auth instance.'
}
function Wait-VacantSupervisor([int]$Attempts=30) {
    for ($i=0; $i -lt $Attempts; $i++) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$script:originalParentPid" -ErrorAction SilentlyContinue
        if ($listeners.Count -eq 0 -and
            ($null -eq $parent -or $parent.CreationDate -ne $script:originalParentCreationDate)) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'Old supervisor or port 8790 is still active; refusing to start another task.'
}
function Stop-OriginalSupervisorInstance {
    Assert-Recovery (-not [bool](Get-Task).Settings.Enabled) 'Task must be disabled before rotation.'
    $owned = Get-TaskOwnedListener
    Assert-Recovery (
        $null -ne $owned -and
        $owned.ProcessId -eq $script:originalPid -and
        $owned.CreationDate -eq $script:originalCreationDate -and
        $owned.ParentProcessId -eq $script:originalParentPid
    ) 'Original owned listener changed; refusing task stop.'
    Stop-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop | Out-Null
    # Stopping the PowerShell task may orphan the original Node child.
    # Never terminate a newly arriving or unrecognized listener.
    $leftover = Get-AuthPortProcess
    if ($null -ne $leftover) {
        Assert-Recovery ($leftover.ProcessId -eq $script:originalPid -and
            $leftover.CreationDate -eq $script:originalCreationDate) 'Listener identity changed; refusing process termination.'
        $target = Get-Process -Id $script:originalPid -ErrorAction Stop
        Assert-Recovery ($target.ProcessName -ieq 'node') 'Expected auth child changed identity.'
        Stop-Process -Id $script:originalPid -ErrorAction Stop
    }
}
function Restore-SupervisedTask {
    if (-not [bool](Get-Task).Settings.Enabled) {
        Enable-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop | Out-Null
    }
    Assert-Recovery ([bool](Get-Task).Settings.Enabled) 'Task could not be enabled during recovery.'
    $listener = Get-AuthPortProcess
    if ($null -ne $listener) {
        Assert-Recovery ($null -ne (Get-TaskOwnedListener)) 'Unexpected listener; refusing duplicate startup.'
        return
    }
    # Clear a stale task instance that holds the IgnoreNew execution slot.
    if ((Get-Task).State -eq 'Running') {
        Stop-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop | Out-Null
        Wait-FreePort
    }
    Start-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
}

$script:startedStagePid = $null
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
        $script:startedStagePid = [int]$started.Id
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
            Assert-Recovery ($null -ne $script:startedStagePid -and
                [int]$listener.ProcessId -eq [int]$script:startedStagePid) 'Staged listener was not launched by this recovery.'
            Verify-SharedState
            # Record only verified process identity; never log protected arguments,
            # credentials or signer state. The protected ACL is inherited explicitly.
            $record = [ordered]@{
                schema = 'tether-auth-owned-stage/v1'
                port = 8790
                pid = [int]$listener.ProcessId
                parentPid = [int]$listener.ParentProcessId
                creationDate = [string]$listener.CreationDate
            }
            $proofPath = Join-Path $script:stateDir 'tether-auth-owned-staged-fallback.json'
            $temporaryProof = Join-Path $script:stateDir ('staged-proof-' + [Guid]::NewGuid().ToString('N') + '.tmp')
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            try {
                [IO.File]::WriteAllText($temporaryProof, ($record | ConvertTo-Json -Compress), $utf8)
                Set-Acl -LiteralPath $temporaryProof -AclObject (Get-Acl -LiteralPath $script:protectedRunner -ErrorAction Stop) -ErrorAction Stop
                if (Test-Path -LiteralPath $proofPath -PathType Leaf) {
                    # Keep overwrite atomic on Windows; do not touch unrelated evidence.
                    $priorProof = Join-Path $script:stateDir ('staged-proof-old-' + [Guid]::NewGuid().ToString('N') + '.tmp')
                    [IO.File]::Replace($temporaryProof,$proofPath,$priorProof)
                } else {
                    Move-Item -LiteralPath $temporaryProof -Destination $proofPath -ErrorAction Stop
                }
            } finally {
                if (Test-Path -LiteralPath $temporaryProof) {
                    Remove-Item -LiteralPath $temporaryProof -Force -ErrorAction SilentlyContinue
                }
            }
            return
        } catch {
            if ($i -eq ($Attempts - 1)) {
                throw 'Staged auth rollback did not pass health and ownership verification.'
            }
        }
    }
}

# Every source, identity and health gate runs before a deliberate process exit.
if ($Exercise -and $RefreshSupervisor) {
    throw 'Select only one disruptive action: -Exercise or -RefreshSupervisor.'
}
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
$sourceRunnerV1 = Join-Path $script:repoDir 'scripts\vaulter-tether-auth-startup-runner.ps1'
$sourceRunnerV2 = Join-Path $script:repoDir 'scripts\vaulter-tether-auth-startup-runner-v2.ps1'
# The install on disk may be v1 or v2; both require an exact source match.
# This alone is not proof that a running PowerShell parent loaded v2.
$installedRunnerVersion = Get-VerifiedRunnerVersion -V1SourcePath $sourceRunnerV1 -V2SourcePath $sourceRunnerV2 -ProtectedRunnerPath $script:protectedRunner
Assert-Recovery ($installedRunnerVersion -cin @('v1','v2')) 'Unexpected protected runner source.'
$script:offlineRescue = Join-Path $PSScriptRoot 'vaulter-tether-auth-offline-restore.ps1'
if ($RefreshSupervisor -and $installedRunnerVersion -ceq 'v2') {
    # Fail closed BEFORE service disruption if the exact original backup,
    # local git revision, S4U task and ACL cannot pass independent preflight.
    Assert-Recovery (Test-Path -LiteralPath $script:offlineRescue -PathType Leaf) 'Offline original-v1 rescue unavailable.'
    & $script:offlineRescue | Out-Null
}
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
$script:originalParentPid = [int]$originalListener.ParentProcessId
$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$script:originalParentPid" -ErrorAction Stop
Assert-Recovery ($null -ne $parent -and $parent.Name -ieq 'powershell.exe') 'Original task parent disappeared.'
$script:originalParentCreationDate = $parent.CreationDate
Assert-Recovery ([bool]$task.Settings.Enabled) 'S4U startup task must be enabled.'
$script:baselineKeys = Get-PublicJwksFingerprint 'http://127.0.0.1:8790/jwks'
Verify-SharedState

if (-not $Exercise) {
    if (-not $RefreshSupervisor) {
        Write-Output "RESTART REHEARSAL PREFLIGHT PASS: auth PID $script:originalPid, S4U task running, restart policy configured."
        Write-Output 'No changes made. -RefreshSupervisor rotates the named task instance; -Exercise tests crash recovery separately.'
        return
    }
}

if ($RefreshSupervisor) {
    $refreshOps = @{
        VerifyBaseline = {
            & $script:postcheck | Out-Null
            Verify-SharedState
            $current = Get-Task
            $xml = [string](Export-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop)
            Assert-Recovery ($current.State -eq 'Running' -and
                [bool]$current.Settings.Enabled -and
                (Test-RegisteredRestartPolicy -Settings $current.Settings -TaskXml $xml)
            ) 'Registered S4U task changed since preflight.'
        }
        VerifyTarget = {
            $now = Get-TaskOwnedListener
            Assert-Recovery ($null -ne $now -and
                $now.ProcessId -eq $script:originalPid -and
                $now.CreationDate -eq $script:originalCreationDate -and
                $now.ParentProcessId -eq $script:originalParentPid
            ) 'Owned listener changed before supervisor refresh.'
        }
        QuiesceTask = {
            Disable-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop | Out-Null
            Assert-Recovery (-not [bool](Get-Task).Settings.Enabled) 'Task remains enabled; refusing stop.'
        }
        StopOwnedTask = {
            Stop-OriginalSupervisorInstance
        }
        VerifyVacant = {
            Wait-VacantSupervisor
            Assert-Recovery (-not [bool](Get-Task).Settings.Enabled) 'Task re-enabled during quiesce.'
        }
        ReenableTask = {
            Enable-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop | Out-Null
            Assert-Recovery ([bool](Get-Task).Settings.Enabled) 'Task did not re-enable.'
        }
        StartTask = {
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
            Assert-Recovery ($listeners.Count -eq 0) 'Port 8790 occupied; refusing duplicate task.'
            Start-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
        }
        VerifyNewTask = {
            Wait-SupervisedAuth -PriorPid $script:originalPid -Attempts 35
            Verify-SharedState
            $current = Get-Task
            $xml = [string](Export-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop)
            Assert-Recovery ([bool]$current.Settings.Enabled -and
                (Test-RegisteredRestartPolicy -Settings $current.Settings -TaskXml $xml)
            ) 'Replacement instance did not preserve repaired policy.'
        }
        RestoreTask = {
            Restore-SupervisedTask
        }
        VerifyRecoveredTask = {
            Wait-HealthyTask
        }
        RecoverOriginalV1 = {
            Assert-Recovery ($installedRunnerVersion -ceq 'v2') 'Verified v1 rollback is only available after v2 activation.'
            $taskBeforeRestore = Get-Task
            Assert-Recovery ($taskBeforeRestore.State -eq 'Disabled' -and
                -not [bool]$taskBeforeRestore.Settings.Enabled) 'Original S4U task was not safely disabled.'
            $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
                Where-Object { $_.LocalPort -eq 8790 })
            Assert-Recovery ($listeners.Count -eq 0) 'Port 8790 is not vacant before original v1 rollback.'
            # Three explicit, separately checked recovery actions. None
            # touches human-origin resources or task registration fields.
            & $script:offlineRescue -RestoreV1 | Out-Null
            & $script:offlineRescue -EnableV1Task | Out-Null
            & $script:offlineRescue -StartV1Task | Out-Null
        }
        VerifyRecoveredV1 = {
            $restored = Get-VerifiedRunnerVersion -V1SourcePath $sourceRunnerV1 -V2SourcePath $sourceRunnerV2 -ProtectedRunnerPath $script:protectedRunner
            Assert-Recovery ($restored -ceq 'v1') 'Recovered task does not use exact original v1 file bytes.'
            & $script:postcheck | Out-Null
            Verify-SharedState
            $taskNow = Get-Task
            $xml = [string](Export-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop)
            $listener = Get-TaskOwnedListener
            Assert-Recovery ($taskNow.State -eq 'Running' -and
                [bool]$taskNow.Settings.Enabled -and
                [string]$taskNow.Principal.LogonType -ceq 'S4U' -and
                (Test-RegisteredRestartPolicy -Settings $taskNow.Settings -TaskXml $xml) -and
                $null -ne $listener -and
                ($listener.ProcessId -ne $script:originalPid -or
                    $listener.CreationDate -ne $script:originalCreationDate)
            ) 'Original v1 S4U task did not recover with verified ownership, state and policy.'
        }
        DisableTask = {
            Disable-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop | Out-Null
            Assert-Recovery (-not [bool](Get-Task).Settings.Enabled) 'Failed supervisor could not be disabled.'
        }
        StopTask = {
            Stop-TaskOwnedService
        }
        ClearListener = {
            Wait-FreePort
        }
        RestoreStage = {
            Restore-StagedAuth
        }
        VerifyStage = {
            Wait-StagedAuth
        }
    }
    $refreshStatus = Invoke-GuardedSupervisorRefresh -Operations $refreshOps
    if ($refreshStatus -ceq 'refreshed') {
        $replacement = Get-TaskOwnedListener
        Write-Output "SUPERVISOR INSTANCE REFRESH VERIFIED: original listener PID=$script:originalPid, replacement PID=$($replacement.ProcessId)."
        Write-Output 'Original Auth0 relay, protected routes and public signing keys unchanged.'
    } elseif ($refreshStatus -ceq 'manually_restored') {
        Write-Output 'SUPERVISOR REFRESH FAILED; healthy task manually restored. Do not run -Exercise.'
    } elseif ($refreshStatus -ceq 'v1_restored') {
        Write-Output 'SUPERVISOR REFRESH FAILED; verified original v1 task restored. Do not run -Exercise.'
    } else {
        throw 'Unexpected supervisor refresh result.'
    }
    Write-Output 'Task instance restart does not prove automatic recovery. Reboot recovery remains unverified.'
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
        Wait-SupervisedAuth -PriorPid $script:originalPid -Attempts 75 -TraceAutomatic
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
