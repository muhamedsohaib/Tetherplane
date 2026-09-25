param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA "Tetherplane\state"),
    [switch]$Force,
    [switch]$IncludeRelay,
    [switch]$InstallScheduledTask,
    [string]$AgentArgumentsFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$package = (Resolve-Path -LiteralPath $PackagePath).Path
$install = [IO.Path]::GetFullPath($InstallPrefix)
$state = [IO.Path]::GetFullPath($StateDir)

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
    $agentArgs | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $configDir "agent-args.json") -Encoding UTF8

    $taskName = "Tetherplane Agent"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $install "launch\tetherplane-agent.ps1") + '"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask -and -not $Force) {
        throw "scheduled task already exists: $taskName"
    }
    if ($existingTask) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -RunLevel Limited -Force | Out-Null
}

$receipt = [ordered]@{
    install_prefix = $install
    state_dir = $state
    state_created_by_installer = (-not $stateExisted)
    scheduled_task = $taskName
}
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $configDir "install.json") -Encoding UTF8

Write-Output "TETHERPLANE_INSTALL_OK $install"
