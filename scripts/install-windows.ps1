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
    $runningAgents = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe'" -ErrorAction Stop)
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
            ($null -ne $exe -and [string]$exe.Value -match '(?i)(?:^|[\\/])tetherd\.exe$') -or
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
foreach ($directory in @("bin","adapters","protocol","launch","browser")) {
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
