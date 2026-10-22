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

# Existing tasks must be reconciled before migrating from a launcher.
# Silently replacing them can strand a child or duplicate a device identity.
if ($InstallScheduledTask) {
    if ($AgentTaskName -notmatch '^Tetherplane(?:[ -][A-Za-z0-9._-]+)*$') {
        throw "scheduled task name must be Tetherplane-owned"
    }
    if (Get-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue) {
        throw "existing scheduled task requires stopped-and-orphan-free migration"
    }
    # New names must not run beside a differently named live legacy agent.
    # Multiple identical device registrations would supersede one another.
    $runningAgents = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe'" -ErrorAction Stop)
    if ($runningAgents.Count -ne 0) {
        throw "a tetherd process is already running; reconcile old agent before registering another task"
    }
    # A stopped legacy task can still restart at the next logon. Refuse
    # registration even if that task currently has no running agent.
    $agentTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
        $taskNameMatches = $_.TaskName -match '(?i)^Tetherplane(?:\s+\S+)*\s+Agent$'
        $nativeActionMatches = @($_.Actions | Where-Object {
            [string]$_.Execute -match '(?i)[\\/]tetherd\.exe$'
        }).Count -gt 0
        $taskNameMatches -or $nativeActionMatches
    })
    if ($agentTasks.Count -gt 0) {
        throw "existing Tetherplane agent task requires explicit migration before registering another"
    }
}

foreach ($required in @(
    "bin\tetherd.exe",
    "adapters\compact-mcp\dist\stdio-server.js",
    "protocol\schemas\result.schema.json",
    "launch\tetherplane-mcp.ps1",
    "manifest.json"
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $package $required))) {
        throw "package is missing required artifact: $required"
    }
}

if (Test-Path -LiteralPath $install) {
    $existing = @(Get-ChildItem -LiteralPath $install -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0 -and -not $Force) {
        throw "install prefix is not empty; use -Force to replace a prior Tetherplane install"
    }
    if ($Force) {
        Remove-Item -LiteralPath $install -Recurse -Force
    }
}

$stateExisted = Test-Path -LiteralPath $state
New-Item -ItemType Directory -Force -Path $install,$state | Out-Null
foreach ($directory in @("bin","adapters","protocol","launch")) {
    Copy-Item -LiteralPath (Join-Path $package $directory) -Destination $install -Recurse -Force
}
foreach ($file in @("manifest.json","README.md","SECURITY.md","CONTRIBUTING.md","LICENSE-MIT","LICENSE-APACHE","install-model-worker-windows.ps1","uninstall-windows.ps1")) {
    $source = Join-Path $package $file
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $install $file) -Force
    }
}
if ($IncludeRelay -and (Test-Path -LiteralPath (Join-Path $package "relay"))) {
    Copy-Item -LiteralPath (Join-Path $package "relay") -Destination $install -Recurse -Force
}

$configDir = Join-Path $install "config"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

$taskName = $null
if ($InstallScheduledTask) {
    if (-not $AgentArgumentsFile) {
        throw "-InstallScheduledTask requires -AgentArgumentsFile"
    }
    $agentArgsSource = (Resolve-Path -LiteralPath $AgentArgumentsFile).Path
    $agentArgs = Get-Content -LiteralPath $agentArgsSource -Raw | ConvertFrom-Json
    if (-not ($agentArgs -is [System.Array])) {
        throw "AgentArgumentsFile must contain a JSON array of tetherd arguments"
    }
    if ($agentArgs.Count -eq 0 -or
        $agentArgs -contains "--stdio-rpc" -or
        $agentArgs -contains "--arguments-file" -or
        $agentArgs -notcontains "--relay-url" -or
        $agentArgs -notcontains "--device-id" -or
        $agentArgs -notcontains "--device-credential-file") {
        throw "scheduled agent requires relay identity and a credential-file reference"
    }
    $argsPath = Join-Path $configDir "agent-args.json"
    $json = ConvertTo-Json -InputObject $agentArgs -Depth 4 -Compress
    [IO.File]::WriteAllText($argsPath, $json, [Text.UTF8Encoding]::new($false))

    # Task Scheduler owns tetherd directly, not a PowerShell-spawned child.
    $taskName = $AgentTaskName
    $action = New-ScheduledTaskAction -Execute (Join-Path $install "bin\tetherd.exe") -Argument ('--arguments-file "' + $argsPath + '"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited | Out-Null
}

$receipt = [ordered]@{
    install_prefix = $install
    state_dir = $state
    state_created_by_installer = (-not $stateExisted)
    scheduled_task = $taskName
}
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $configDir "install.json") -Encoding UTF8

Write-Output "TETHERPLANE_INSTALL_OK $install"
