param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA "Tetherplane\state"),
    [switch]$Force,
    [switch]$IncludeRelay,
    [switch]$InstallScheduledTask,
    [string]$AgentArgumentsFile,
    [string]$AgentTaskName = "Tetherplane Agent"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$package = (Resolve-Path -LiteralPath $PackagePath).Path
$install = [IO.Path]::GetFullPath($InstallPrefix)
$state = [IO.Path]::GetFullPath($StateDir)
if ([string]::Equals($install.TrimEnd('\'), $state.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
    $state.StartsWith($install.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $install.StartsWith($state.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'state and install directories must be separate, non-overlapping paths'
}

# Existing agent registrations must be migrated explicitly. These checks
# precede all file replacement, including -Force without -InstallScheduledTask.
if ($InstallScheduledTask) {
    if ($AgentTaskName -notmatch '^Tetherplane(?:[ -][A-Za-z0-9._-]+)*$') {
        throw "scheduled task name must be Tetherplane-owned"
    }
    if (Get-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue) {
        throw "existing scheduled task requires stopped-and-orphan-free migration"
    }
}
if ($InstallScheduledTask -or $Force) {
    $runningAgents = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe' OR Name='tetherd-agentw.exe'" -ErrorAction Stop)
    if ($runningAgents.Count -ne 0) {
        throw "a tetherd process is already running; reconcile old agent before replacing or installing"
    }
    # Include disabled legacy tasks and recovery canaries; preserve unrelated
    # browser bridge and emergency relay tasks.
    $agentTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
        $taskNameMatches = $_.TaskName -match '(?i)^Tetherplane(?:[ -][A-Za-z0-9._-]+)*[ -](?:Agent|Canary(?:[ -][A-Za-z0-9._-]+)*)$'
        $actionMatches = @($_.Actions | Where-Object {
            $exe = $_.PSObject.Properties['Execute']
            $arguments = $_.PSObject.Properties['Arguments']
            ($null -ne $exe -and [string]$exe.Value -match '(?i)(?:^|[\\/])tetherd(?:-agentw)?\.exe$') -or
            ($null -ne $arguments -and [string]$arguments.Value -match '(?i)tetherplane-agent\.ps1')
        }).Count -gt 0
        $taskNameMatches -or $actionMatches
    })
    if ($agentTasks.Count -gt 0) {
        throw "existing Tetherplane agent task requires explicit migration before replacing or installing"
    }
}

foreach ($required in @(
    "bin\tetherd.exe",
    "bin\tetherd-agentw.exe",
    "bin\tetherplane-browserw.exe",
    "bin\tetherplane-modelw.exe",
    "adapters\compact-mcp\dist\stdio-server.js",
    "protocol\schemas\result.schema.json",
    "launch\tetherplane-mcp.ps1",
    "launch\tetherplane-browser.ps1",
    "launch\tetherplane-browser-setup.ps1",
    "browser\host.mjs",
    "browser\extension\manifest.json",
    "browser\extension\dist\background.js",
    "browser\extension\dist\pair.js",
    "manifest.json"
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $package $required))) {
        throw "package is missing required artifact: $required"
    }
}

$agentArgs = $null
$previousReceipt = $null
if ($InstallScheduledTask) {
    if (-not $AgentArgumentsFile) {
        throw "-InstallScheduledTask requires -AgentArgumentsFile"
    }
    $agentArgsSource = (Resolve-Path -LiteralPath $AgentArgumentsFile).Path
    $agentArgs = Get-Content -LiteralPath $agentArgsSource -Raw | ConvertFrom-Json
    if (-not ($agentArgs -is [System.Array])) {
        throw "AgentArgumentsFile must contain a JSON array of tetherd arguments"
    }
    if (@($agentArgs | Where-Object { $_ -isnot [string] }).Count -ne 0) {
        throw "AgentArgumentsFile must contain only string arguments"
    }
    if ($agentArgs.Count -eq 0 -or
        $agentArgs -contains "--stdio-rpc" -or
        $agentArgs -contains "--arguments-file" -or
        $agentArgs -notcontains "--relay-url" -or
        $agentArgs -notcontains "--device-id" -or
        $agentArgs -notcontains "--device-credential-file") {
        throw "scheduled agent requires relay identity and a credential-file reference"
    }
    # Presence of three flags is insufficient: duplicates and missing values
    # can make a scheduled native agent exit after the old install is replaced.
    # Inspect flags only; never open or display the credential-file contents.
    foreach ($requiredFlag in @("--relay-url", "--device-id", "--device-credential-file")) {
        $positions = @()
        for ($index = 0; $index -lt $agentArgs.Count; $index++) {
            if ($agentArgs[$index] -ceq $requiredFlag) {
                $positions += $index
            }
        }
        if ($positions.Count -ne 1 -or $positions[0] -ge ($agentArgs.Count - 1) -or
            [string]::IsNullOrWhiteSpace([string]$agentArgs[$positions[0] + 1]) -or
            [string]$agentArgs[$positions[0] + 1] -like "--*") {
            throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: incomplete or duplicate remote device argument"
        }
    }
}

if (Test-Path -LiteralPath $install) {
    $existing = @(Get-ChildItem -LiteralPath $install -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0 -and -not $Force) {
        throw "install prefix is not empty; use -Force to replace a prior Tetherplane install"
    }
    if ($Force) {
        if ($existing.Count -gt 0) {
            # Caller-supplied InstallPrefix must never authorize arbitrary removal.
            $existingReceipt = Join-Path $install "config\install.json"
            $ownershipError = "refusing -Force: populated prefix lacks a verified Tetherplane install receipt"
            if (-not (Test-Path -LiteralPath $existingReceipt -PathType Leaf)) {
                throw $ownershipError
            }
            if (((Get-Item -LiteralPath $install -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "refusing -Force: install prefix is a reparse point"
            }
            try {
                $previousReceipt = Get-Content -LiteralPath $existingReceipt -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
                if (-not $previousReceipt -or
                    $previousReceipt.PSObject.Properties.Name -notcontains "install_prefix") {
                    throw $ownershipError
                }
                $claimedPath = [IO.Path]::GetFullPath([string]$previousReceipt.install_prefix)
                if (-not [string]::Equals($claimedPath, $install, [StringComparison]::OrdinalIgnoreCase)) {
                    throw $ownershipError
                }
            }
            catch {
                throw $ownershipError
            }
            foreach ($ownedFile in @(
                "bin\tetherd.exe",
                "bin\tetherd-agentw.exe",
                "manifest.json",
                "uninstall-windows.ps1"
            )) {
                if (-not (Test-Path -LiteralPath (Join-Path $install $ownedFile) -PathType Leaf)) {
                    throw $ownershipError
                }
            }
            if ($previousReceipt.PSObject.Properties.Name -contains "scheduled_task" -and
                [string]$previousReceipt.scheduled_task) {
                throw "refusing -Force: installed scheduled agent requires explicit migration"
            }
            if ($previousReceipt.PSObject.Properties.Name -contains 'state_dir' -and [string]$previousReceipt.state_dir) {
                $previousState = [IO.Path]::GetFullPath([string]$previousReceipt.state_dir)
                if ([string]::Equals($install.TrimEnd('\'), $previousState.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
                    $previousState.StartsWith($install.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
                    $install.StartsWith($previousState.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'refusing -Force: previous state and install directories overlap; owner migration required'
                }
            }
        }
    }
}

$stateExisted = Test-Path -LiteralPath $state
if ($stateExisted -and -not (Test-Path -LiteralPath $state -PathType Container)) {
    throw 'existing state path must be a directory'
}
# Prepare a complete replacement beside the final prefix. A failed copy must
# never destroy the prior install or expose a partially copied new install.
$parent = Split-Path -Parent $install
$staging = Join-Path $parent ('.tetherplane-install-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path $parent ('.tetherplane-backup-' + [guid]::NewGuid().ToString('N'))
$priorMoved = $false
$candidateMoved = $false
$stateCreated = $false
$taskAttempted = $false
$committed = $false
$taskName = $null
try {
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    foreach ($directory in @("bin","adapters","protocol","launch","browser")) {
        Copy-Item -LiteralPath (Join-Path $package $directory) -Destination $staging -Recurse -Force
    }
    foreach ($file in @("manifest.json","README.md","SECURITY.md","CONTRIBUTING.md","LICENSE-MIT","LICENSE-APACHE","install-model-worker-windows.ps1","uninstall-windows.ps1")) {
        $source = Join-Path $package $file
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $staging $file) -Force
        }
    }
    if ($IncludeRelay -and (Test-Path -LiteralPath (Join-Path $package "relay"))) {
        Copy-Item -LiteralPath (Join-Path $package "relay") -Destination $staging -Recurse -Force
    }

    $configDir = Join-Path $staging "config"
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null

    if ($InstallScheduledTask) {
        $argsPath = Join-Path $configDir "agent-args.json"
        $json = ConvertTo-Json -InputObject $agentArgs -Depth 4 -Compress
        [IO.File]::WriteAllText($argsPath, $json, [Text.UTF8Encoding]::new($false))

        $taskName = $AgentTaskName
    }

    $stateOwned = -not $stateExisted
    if ($previousReceipt -and
        $previousReceipt.PSObject.Properties.Name -contains 'state_dir' -and
        $previousReceipt.PSObject.Properties.Name -contains 'state_created_by_installer' -and
        [string]::Equals([IO.Path]::GetFullPath([string]$previousReceipt.state_dir), $state, [StringComparison]::OrdinalIgnoreCase)) {
        $stateOwned = [bool]$previousReceipt.state_created_by_installer
    }
    $receipt = [ordered]@{
        install_prefix = $install
        state_dir = $state
        state_created_by_installer = $stateOwned
        scheduled_task = $taskName
    }
    $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $configDir "install.json") -Encoding UTF8

    if (Test-Path -LiteralPath $install) {
        Move-Item -LiteralPath $install -Destination $backup
        $priorMoved = $true
    }
    Move-Item -LiteralPath $staging -Destination $install
    $candidateMoved = $true
    if (-not $stateExisted) {
        New-Item -ItemType Directory -Path $state | Out-Null
        $stateCreated = $true
    }
    if ($InstallScheduledTask) {
        # Task Scheduler owns tetherd directly, not a PowerShell-spawned child.
        $argsPath = Join-Path $install 'config\agent-args.json'
        $action = New-ScheduledTaskAction -Execute (Join-Path $install "bin\tetherd-agentw.exe") -Argument ('--arguments-file "' + $argsPath + '"')
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $taskAttempted = $true
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited | Out-Null
    }
    $committed = $true
}
catch {
    $installError = $_
    # Registration can throw after creating a task. Remove only the exact
    # stopped action just attempted; any ambiguity preserves recovery files.
    if ($taskAttempted) {
        # A direct -TaskName lookup throws NotFound when registration failed
        # before creating anything. Enumeration preserves that empty outcome
        # while still treating a real scheduler access failure as a blocker.
        $createdTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object TaskName -CEQ $taskName)
        if ($createdTasks.Count -gt 0) {
            if ($createdTasks.Count -ne 1 -or @($createdTasks[0].Actions).Count -ne 1 -or
                [string]$createdTasks[0].Actions[0].Execute -ine (Join-Path $install 'bin\tetherd-agentw.exe') -or
                [string]$createdTasks[0].Actions[0].Arguments -cne ('--arguments-file "' + (Join-Path $install 'config\agent-args.json') + '"') -or
                [string]$createdTasks[0].Principal.RunLevel -ne 'Limited' -or
                [string]$createdTasks[0].State -eq 'Running') {
                throw 'INSTALL_ROLLBACK_REQUIRES_OWNER_REVIEW: task ownership or stopped state is unverified; backup preserved'
            }
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
        }
    }
    if ($candidateMoved -and (Test-Path -LiteralPath $install)) {
        Remove-Item -LiteralPath $install -Recurse -Force
    }
    if ($priorMoved) { Move-Item -LiteralPath $backup -Destination $install }
    # Never recursively delete state. Only remove a still-empty new directory.
    if ($stateCreated -and (Test-Path -LiteralPath $state) -and
        @(Get-ChildItem -LiteralPath $state -Force).Count -eq 0) {
        [IO.Directory]::Delete($state)
    }
    throw $installError
}
finally {
    # Both scratch paths are fixed GUID siblings computed above. Validate the
    # resolved targets before recursive cleanup; failed rollback retains backup.
    foreach ($scratch in @($staging, $backup)) {
        if ($scratch -eq $backup -and -not $committed) { continue }
        $resolved = [IO.Path]::GetFullPath($scratch)
        if (-not [string]::Equals((Split-Path -Parent $resolved), $parent, [StringComparison]::OrdinalIgnoreCase) -or
            (Split-Path -Leaf $resolved) -notmatch '^\.tetherplane-(install|backup)-[a-f0-9]{32}$') {
            throw 'unsafe installer scratch cleanup path'
        }
        if (Test-Path -LiteralPath $resolved) {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Continue
        }
    }
}

Write-Output "TETHERPLANE_INSTALL_OK $install"
