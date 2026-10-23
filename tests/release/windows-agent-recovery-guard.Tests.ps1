$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$guard = Join-Path $repo 'scripts\windows-agent-recovery-guard.ps1'

Describe 'guarded native agent recovery: pure denial and idempotency' {
    BeforeEach {
        $load = @{
            TaskName = 'Tetherplane Test Canary'
            ExpectedExeSha256 = ('a' * 64)
            ExpectedArgsSha256 = ('b' * 64)
            ExpectedPrincipalSha256 = ('c' * 64)
            ExpectedDeviceId = 'TEST01'
            ExpectedRelayUrl = 'wss://example.invalid/device'
            ExpectedRunLevel = 'Highest'
        }
        . $guard @load
    }
    It 'treats an owned running agent as healthy' {
        Get-GuardDecision -TaskState Running -AgentCount 1 -AgentMatchesTask $true -CompetingAgentTaskEnabled $false | Should Be 'healthy'
    }
    It 'considers a ready task with no agent eligible' {
        Get-GuardDecision -TaskState Ready -AgentCount 0 -AgentMatchesTask $false -CompetingAgentTaskEnabled $false | Should Be 'missing'
    }
    It 'rejects an orphan even when its executable matches' {
        { Get-GuardDecision -TaskState Ready -AgentCount 1 -AgentMatchesTask $true -CompetingAgentTaskEnabled $false } | Should Throw
    }
    It 'rejects a foreign running executable' {
        { Get-GuardDecision -TaskState Running -AgentCount 1 -AgentMatchesTask $false -CompetingAgentTaskEnabled $false } | Should Throw
    }
    It 'preserves a protected higher-integrity process without claiming ownership' {
        Get-GuardDecision -TaskState Running -AgentCount 1 -AgentMatchesTask $false -CompetingAgentTaskEnabled $false -AgentPathUnavailable $true | Should Be 'present_unverified'
    }
    It 'denies a possible orphan when its executable path is inaccessible' {
        { Get-GuardDecision -TaskState Ready -AgentCount 1 -AgentMatchesTask $false -CompetingAgentTaskEnabled $false -AgentPathUnavailable $true } | Should Throw
    }
    It 'rejects two active tetherd processes' {
        { Get-GuardDecision -TaskState Running -AgentCount 2 -AgentMatchesTask $true -CompetingAgentTaskEnabled $false } | Should Throw
    }
    It 'rejects a competing enabled agent task' {
        { Get-GuardDecision -TaskState Ready -AgentCount 0 -AgentMatchesTask $false -CompetingAgentTaskEnabled $true } | Should Throw
    }
    It 'does not activate disabled tasks or running tasks without a process' {
        { Get-GuardDecision -TaskState Disabled -AgentCount 0 -AgentMatchesTask $false -CompetingAgentTaskEnabled $false } | Should Throw
        { Get-GuardDecision -TaskState Running -AgentCount 0 -AgentMatchesTask $false -CompetingAgentTaskEnabled $false } | Should Throw
    }
    It 'rejects repeated, missing and malformed identity arguments' {
        { Get-GuardArgument -Tokens @('--device-id', 'A', '--device-id', 'B') -Name '--device-id' } | Should Throw
        { Get-GuardArgument -Tokens @('--device-id') -Name '--device-id' } | Should Throw
        { Get-GuardArgument -Tokens @('--device-id', '--relay-url') -Name '--device-id' } | Should Throw
    }
}

Describe 'guarded native agent recovery: isolated synthetic task contract' {
    BeforeEach {
        $load = @{
            TaskName = 'Tetherplane Test Canary'
            ExpectedExeSha256 = ('a' * 64)
            ExpectedArgsSha256 = ('b' * 64)
            ExpectedPrincipalSha256 = ('c' * 64)
            ExpectedDeviceId = 'TEST01'
            ExpectedRelayUrl = 'wss://example.invalid/device'
            ExpectedRunLevel = 'Highest'
        }
        . $guard @load
        $script:root = Join-Path ([IO.Path]::GetTempPath()) ('tp-recovery-guard-test-' + [Guid]::NewGuid().ToString('N'))
        $script:state = Join-Path $script:root 'state'
        $script:exe = Join-Path $script:root 'tetherd.exe'
        $script:argsFile = Join-Path $script:root 'args.json'
        $script:principal = Join-Path $script:state 'principal.json'
        $script:credential = Join-Path $script:state 'device.credential'
        $script:agentState = Join-Path $script:state 'agent'
        New-Item -ItemType Directory -Path $script:agentState -Force | Out-Null
        [IO.File]::WriteAllText($script:exe, 'synthetic test fixture - never launch')
        [IO.File]::WriteAllText($script:credential, 'synthetic-nonproduction-test-value')
        [IO.File]::WriteAllText($script:principal, '{"allowed_devices":["TEST01"],"allowed_capabilities":["device.status"]}')
        $argv = @('--relay-url','wss://example.invalid/device','--device-id','TEST01',
            '--device-credential-file',$script:credential,'--principal-profile',$script:principal,
            '--state-dir',$script:agentState)
        [IO.File]::WriteAllText($script:argsFile, (ConvertTo-Json -InputObject $argv -Compress))
        $script:pins = @{
            TargetTaskName = 'Tetherplane Test Canary'
            ExeSha256 = (Get-FileHash -LiteralPath $script:exe -Algorithm SHA256).Hash
            ArgsSha256 = (Get-FileHash -LiteralPath $script:argsFile -Algorithm SHA256).Hash
            PrincipalSha256 = (Get-FileHash -LiteralPath $script:principal -Algorithm SHA256).Hash
            DeviceId = 'TEST01'
            RelayUrl = 'wss://example.invalid/device'
            RunLevel = 'Highest'
        }
        $script:task = [pscustomobject]@{
            TaskName = 'Tetherplane Test Canary'
            State = 'Running'
            Settings = [pscustomobject]@{ Enabled = $true; MultipleInstances = 'IgnoreNew' }
            Principal = [pscustomobject]@{ UserId = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value; LogonType = 'Interactive'; RunLevel = 'Highest' }
            Triggers = @([pscustomobject]@{ Enabled = $true; CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' } })
            Actions = @([pscustomobject]@{ Execute = $script:exe; Arguments = ('--arguments-file "' + $script:argsFile + '"') })
        }
        $script:extraTasks = @()
        $script:runningAgents = @([pscustomobject]@{ ExecutablePath = $script:exe })
        $script:launched = $false
        Mock Get-ScheduledTask { if ($TaskName) { return $script:task }; return @($script:task) + @($script:extraTasks) }
        Mock Get-CimInstance { if ($script:launched) { return [pscustomobject]@{ ExecutablePath = $script:exe } }; return $script:runningAgents }
        Mock Start-ScheduledTask { $script:launched = $true }
        Mock Start-Sleep { }
    }
    AfterEach {
        if ($script:root -and (Test-Path -LiteralPath $script:root -PathType Container)) {
            Remove-Item -LiteralPath $script:root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    It 'does not start a second agent when already healthy' {
        $r = Invoke-GuardedAgentRecovery @script:pins -Recover
        $r.status | Should Be 'healthy'
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
    It 'reports absent agent without starting in read-only mode' {
        $script:task.State = 'Ready'; $script:runningAgents = @()
        $r = Invoke-GuardedAgentRecovery @script:pins
        $r.status | Should Be 'would_start'
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
    It 'requests only the existing task when its agent is genuinely absent' {
        $script:task.State = 'Ready'; $script:runningAgents = @()
        $r = Invoke-GuardedAgentRecovery @script:pins -Recover
        $r.status | Should Be 'started_local'
        Assert-MockCalled Start-ScheduledTask -Exactly 1 -Scope It
    }
    It 'rejects a newly enabled competing agent during the final preflight' {
        $script:task.State = 'Ready'; $script:runningAgents = @()
        $script:scanNumber = 0
        $script:lateAgentTask = [pscustomobject]@{
            TaskName = 'Tetherplane Other Agent'
            Settings = [pscustomobject]@{ Enabled = $true }
            Actions = @([pscustomobject]@{ Execute = $script:exe })
        }
        Mock Get-ScheduledTask {
            if ($TaskName) { return $script:task }
            $script:scanNumber++
            if ($script:scanNumber -ge 2) { return @($script:task) + @($script:lateAgentTask) }
            return $script:task
        }
        { Invoke-GuardedAgentRecovery @script:pins -Recover } | Should Throw
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
    It 'rejects identity bytes changed between preflight and launch' {
        $script:task.State = 'Ready'; $script:runningAgents = @()
        $script:processChecks = 0
        Mock Get-CimInstance {
            $script:processChecks++
            if ($script:processChecks -eq 2) {
                [IO.File]::AppendAllText($script:argsFile, ' ')
            }
            return @()
        }
        { Invoke-GuardedAgentRecovery @script:pins -Recover } | Should Throw
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }

    It 'refuses an orphan with an approved executable path' {
        $script:task.State = 'Ready'
        { Invoke-GuardedAgentRecovery @script:pins -Recover } | Should Throw
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
    It 'never starts when a running protected process hides its executable path' {
        $script:runningAgents = @([pscustomobject]@{ ExecutablePath = $null })
        $r = Invoke-GuardedAgentRecovery @script:pins -Recover
        $r.status | Should Be 'present_unverified'
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
    It 'refuses a second enabled agent task' {
        $script:task.State = 'Ready'; $script:runningAgents = @()
        $script:extraTasks = @([pscustomobject]@{
            TaskName = 'Tetherplane Other Agent'
            Settings = [pscustomobject]@{ Enabled = $true }
            Actions = @([pscustomobject]@{ Execute = $script:exe })
        })
        { Invoke-GuardedAgentRecovery @script:pins -Recover } | Should Throw
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
    It 'refuses changed identity bytes before starting' {
        $script:task.State = 'Ready'; $script:runningAgents = @()
        [IO.File]::AppendAllText($script:argsFile, ' ')
        { Invoke-GuardedAgentRecovery @script:pins -Recover } | Should Throw
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
    It 'refuses a foreign task owner before starting' {
        $script:task.State = 'Ready'; $script:runningAgents = @()
        $script:task.Principal.UserId = 'S-1-5-18'
        { Invoke-GuardedAgentRecovery @script:pins -Recover } | Should Throw
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
    It 'rejects an unexpected task privilege level' {
        $script:task.State = 'Ready'; $script:runningAgents = @()
        $script:task.Principal.RunLevel = 'Limited'
        { Invoke-GuardedAgentRecovery @script:pins -Recover } | Should Throw
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
    It 'rejects a disabled or replaced logon trigger' {
        $script:task.State = 'Ready'; $script:runningAgents = @()
        $script:task.Triggers[0].Enabled = $false
        { Invoke-GuardedAgentRecovery @script:pins -Recover } | Should Throw
        Assert-MockCalled Start-ScheduledTask -Exactly 0 -Scope It
    }
}
