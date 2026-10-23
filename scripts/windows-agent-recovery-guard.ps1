# Tetherplane Windows recovery guard: a fail-closed, non-interactive caller of
# ONE already approved native Scheduled Task. It does not install an agent,
# register a device, modify credentials, or terminate any process.
# Scheduled usage requires pinned fingerprints and a separate scheduled task
# running as the SAME Windows account, with RunLevel Limited and IgnoreNew.
param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$ExpectedExeSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedArgsSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedPrincipalSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedDeviceId,
    [Parameter(Mandatory = $true)][string]$ExpectedRelayUrl,
    [switch]$StartIfMissing,
    [string]$ReceiptPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-GuardPath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    if (-not [IO.Path]::IsPathRooted($LiteralPath)) { throw "path not absolute" }
    $full = [IO.Path]::GetFullPath($LiteralPath)
    $part = $full
    while ($part) {
        $item = Get-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "redirected path rejected"
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if (-not $parent -or $parent -eq $part) { break }
        $part = $parent
    }
    return $full
}

function Assert-GuardHash {
    param([string]$LiteralPath, [string]$ExpectedSha256)
    if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "invalid expected fingerprint" }
    $path = Assert-GuardPath -LiteralPath $LiteralPath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "required file missing" }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $ExpectedSha256) {
        throw "installed file fingerprint mismatch"
    }
    return $path
}

function Resolve-GuardOwnerSid {
    param([string]$PrincipalUserId)
    if ([string]::IsNullOrWhiteSpace($PrincipalUserId)) { throw "task owner missing" }
    if ($PrincipalUserId -match '^S-1-') { return $PrincipalUserId }
    try {
        return ([Security.Principal.NTAccount]$PrincipalUserId).Translate(
            [Security.Principal.SecurityIdentifier]
        ).Value
    } catch { throw "task owner unresolved" }
}

function Get-GuardArgument {
    param([string[]]$Tokens, [string]$Name)
    $matches = @()
    for ($i = 0; $i -lt $Tokens.Length; $i++) {
        if ($Tokens[$i] -ceq $Name) { $matches += $i }
    }
    if ($matches.Count -ne 1 -or $matches[0] + 1 -ge $Tokens.Length) {
        throw "required agent argument missing or repeated"
    }
    $value = [string]$Tokens[$matches[0] + 1]
    if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith('--')) {
        throw "invalid agent argument value"
    }
    return $value
}

# Pure decision logic, exercised under Windows PowerShell and Pester. The
# owner/argument/hash/process checks must pass before this function is called.
function Get-GuardDecision {
    param(
        [string]$TaskState,
        [int]$AgentCount,
        [bool]$AgentMatchesTask,
        [bool]$CompetingAgentTaskEnabled
    )
    if ($CompetingAgentTaskEnabled) { throw "competing agent task enabled" }
    if ($AgentCount -gt 1) { throw "multiple native agents present" }
    if ($AgentCount -eq 1) {
        if (-not $AgentMatchesTask -or $TaskState -ne 'Running') {
            throw "unknown or orphan agent present"
        }
        return 'healthy'
    }
    if ($AgentCount -eq 0 -and $TaskState -eq 'Ready') { return 'missing' }
    throw "native task state is not safe for recovery"
}

function Invoke-GuardedAgentRecovery {
    param(
        [string]$TargetTaskName,
        [string]$ExeSha256,
        [string]$ArgsSha256,
        [string]$PrincipalSha256,
        [string]$DeviceId,
        [string]$RelayUrl,
        [switch]$Recover
    )
    if ($TargetTaskName -notmatch '^Tetherplane(?:[ -][A-Za-z0-9._-]+)*$') {
        throw "invalid owned task name"
    }
    if ($DeviceId -notmatch '^[A-Za-z0-9._-]{1,100}$') { throw "invalid expected device" }
    if ($RelayUrl -notmatch '^wss://[^\s]+/device$') { throw "invalid expected relay" }

    $task = Get-ScheduledTask -TaskName $TargetTaskName -ErrorAction Stop
    if (-not [bool]$task.Settings.Enabled) { throw "approved task is disabled" }
    if ([string]$task.Settings.MultipleInstances -ne 'IgnoreNew') {
        throw "native task single-instance protection missing"
    }
    if ([string]$task.Principal.LogonType -ne 'Interactive') {
        throw "native task logon type changed"
    }
    $ownerSid = Resolve-GuardOwnerSid -PrincipalUserId ([string]$task.Principal.UserId)
    $currentSid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    if ($ownerSid -cne $currentSid) { throw "native task belongs to a different user" }

    $actions = @($task.Actions)
    if ($actions.Count -ne 1) { throw "native task has multiple actions" }
    $exe = [string]$actions[0].Execute
    if ([IO.Path]::GetFileName($exe) -ine 'tetherd.exe') { throw "task is not native tetherd" }
    $exe = Assert-GuardHash -LiteralPath $exe -ExpectedSha256 $ExeSha256
    $argsMatch = [regex]::Match(
        [string]$actions[0].Arguments,
        '^\s*--arguments-file\s+"([^"]+)"\s*$'
    )
    if (-not $argsMatch.Success) { throw "native task argument-file contract changed" }
    $argsFile = Assert-GuardHash -LiteralPath $argsMatch.Groups[1].Value -ExpectedSha256 $ArgsSha256
    $args = [string[]](ConvertFrom-Json -InputObject (Get-Content -LiteralPath $argsFile -Raw))
    if ($args.Length -gt 100 -or $args.Length -lt 6) { throw "unexpected native arguments" }
    if ((Get-GuardArgument -Tokens $args -Name '--device-id') -cne $DeviceId -or
        (Get-GuardArgument -Tokens $args -Name '--relay-url') -cne $RelayUrl) {
        throw "agent identity or transport differs from approved pins"
    }
    $credential = Get-GuardArgument -Tokens $args -Name '--device-credential-file'
    $profile = Get-GuardArgument -Tokens $args -Name '--principal-profile'
    $state = Get-GuardArgument -Tokens $args -Name '--state-dir'
    foreach ($path in @($credential, $profile, $state)) {
        $full = Assert-GuardPath -LiteralPath $path
        if ($path -eq $state) {
            if (-not (Test-Path -LiteralPath $full -PathType Container)) {
                throw "agent state missing"
            }
        } elseif (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            throw "agent identity file missing"
        }
    }
    [void](Assert-GuardHash -LiteralPath $profile -ExpectedSha256 $PrincipalSha256)
    $profileData = Get-Content -LiteralPath $profile -Raw | ConvertFrom-Json
    if (@($profileData.allowed_devices) -cnotcontains $DeviceId) {
        throw "agent principal does not authorize requested device"
    }

    # A task-local IgnoreNew setting cannot fence another task (or an orphan).
    # Examine ALL native agent actions plus legacy agent task names before
    # deciding to start the approved task. Never disable/kill an unknown one.
    $allTasks = @(Get-ScheduledTask -ErrorAction Stop)
    $competing = @($allTasks | Where-Object {
        if ($_.TaskName -eq $TargetTaskName -or -not [bool]$_.Settings.Enabled) { return $false }
        $namedAgent = $_.TaskName -match '(?i)^Tetherplane(?:[ -]\S+)*[ -]Agent$' -or
                      $_.TaskName -match '(?i)^Tetherplane(?:[ -]\S+)*[ -]Canary(?:[ -]V\d+)?$'
        $nativeAgent = @($_.Actions | Where-Object {
            $exec = $_.PSObject.Properties['Execute']
            $null -ne $exec -and [string]$exec.Value -match '(?i)[\\/]tetherd\.exe$'
        }).Count -gt 0
        $namedAgent -or $nativeAgent
    })
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe'" -ErrorAction Stop)
    $matches = $false
    if ($processes.Count -eq 1) {
        $matches = ([string]$processes[0].ExecutablePath -ieq $exe)
    }
    $decision = Get-GuardDecision -TaskState ([string]$task.State) 
        -AgentCount $processes.Count -AgentMatchesTask $matches 
        -CompetingAgentTaskEnabled ($competing.Count -ne 0)

    if ($decision -eq 'healthy') {
        return [pscustomobject]@{ status = 'healthy'; started = $false; agent_count = 1 }
    }
    if (-not $Recover) {
        return [pscustomobject]@{ status = 'would_start'; started = $false; agent_count = 0 }
    }

    # Recheck immediately before mutation. A concurrent unknown agent or
    # changed task state is an uncertain race: fail closed, no implicit retry.
    $taskNow = Get-ScheduledTask -TaskName $TargetTaskName -ErrorAction Stop
    $agentsNow = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe'" -ErrorAction Stop)
    if ($agentsNow.Count -ne 0 -or [string]$taskNow.State -ne 'Ready' -or
        -not [bool]$taskNow.Settings.Enabled) {
        throw "agent or native task changed during recovery preflight"
    }
    if (@($taskNow.Actions).Count -ne 1 -or
        [string]$taskNow.Actions[0].Execute -ine $exe -or
        [string]$taskNow.Actions[0].Arguments -cne [string]$actions[0].Arguments) {
        throw "native task action changed during recovery preflight"
    }
    Start-ScheduledTask -TaskName $TargetTaskName -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 250
        $startedAgents = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe'" -ErrorAction Stop)
        if ($startedAgents.Count -eq 1 -and
            [string]$startedAgents[0].ExecutablePath -ieq $exe) {
            return [pscustomobject]@{ status = 'started_local'; started = $true; agent_count = 1 }
        }
        if ($startedAgents.Count -gt 1) { throw "agent cardinality changed after start" }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "start issued but agent startup is unverified; do not retry automatically"
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $result = Invoke-GuardedAgentRecovery -TargetTaskName $TaskName 
            -ExeSha256 $ExpectedExeSha256 -ArgsSha256 $ExpectedArgsSha256 
            -PrincipalSha256 $ExpectedPrincipalSha256 -DeviceId $ExpectedDeviceId 
            -RelayUrl $ExpectedRelayUrl -Recover:$StartIfMissing
        $result | ConvertTo-Json -Compress | Write-Output
    } catch {
        # No credentials, arbitrary paths or OS command lines are printed.
        Write-Error ("TETHERPLANE_RECOVERY_DENIED: " + $_.Exception.Message)
        exit 1
    }
}
