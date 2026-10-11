param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA "Tetherplane\state"),
    [switch]$Force,
    [switch]$IncludeRelay,
    [switch]$InstallScheduledTask,
    [string]$ScheduledTaskName = "Tetherplane Agent",
    [string]$AgentArgumentsFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$package = (Resolve-Path -LiteralPath $PackagePath).Path
$install = [IO.Path]::GetFullPath($InstallPrefix)
$state = [IO.Path]::GetFullPath($StateDir)

$meshTaskInstall = $false
$taskName = $null
$agentArgs = $null
if ($InstallScheduledTask) {
    if (-not $AgentArgumentsFile) {
        throw "-InstallScheduledTask requires -AgentArgumentsFile"
    }
    if ($ScheduledTaskName -cnotmatch '^Tetherplane (Agent|Mesh (Leno|RTX|Surface|Vaulter))$') {
        throw "unrecognized Tetherplane scheduled task identity"
    }
    $taskName = $ScheduledTaskName
    $meshTaskInstall = $taskName -cmatch '^Tetherplane Mesh (Leno|RTX|Surface|Vaulter)$'
    if ($meshTaskInstall -and $Force) {
        throw "mesh installations cannot use -Force or overwrite an existing task"
    }
    $existingTask = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask -and -not $Force) {
        throw "scheduled task already exists: $taskName"
    }
    $agentArgsSource = (Resolve-Path -LiteralPath $AgentArgumentsFile).Path
    $agentArgs = Get-Content -LiteralPath $agentArgsSource -Raw | ConvertFrom-Json
    if (-not ($agentArgs -is [System.Array])) {
        throw "AgentArgumentsFile must contain a JSON array of tetherd arguments"
    }
}

$required = @(
    "bin\tetherd.exe",
    "adapters\compact-mcp\dist\stdio-server.js",
    "protocol\schemas\result.schema.json",
    "launch\tetherplane-mcp.ps1",
    "manifest.json"
)
if ($meshTaskInstall) {
    if ($IncludeRelay) {
        throw "mesh agent installation must not install or alter the existing relay"
    }
    $deviceId = $taskName.Substring('Tetherplane Mesh '.Length)
    $meshInstall = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\Tetherplane-Mesh'))
    $meshState = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA ('Tetherplane\mesh\' + $deviceId)))
    if (-not [string]::Equals($meshInstall,$install,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($meshState,$state,[StringComparison]::OrdinalIgnoreCase)) {
        throw "mesh install or state path is not the approved device-scoped path"
    }
    $required += "Uninstall-Tetherplane-Mesh.ps1"
}
foreach ($artifact in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $package $artifact) -PathType Leaf)) {
        throw "package is missing required artifact: $artifact"
    }
}

if (Test-Path -LiteralPath $install) {
    $installInfo=Get-Item -LiteralPath $install -Force -ErrorAction Stop
    if ($installInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "install prefix must not be a reparse point"
    }
    $existing = @(Get-ChildItem -LiteralPath $install -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0 -and -not $Force) {
        throw "install prefix is not empty; refusing to replace a prior Tetherplane install"
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
$filesToCopy = @("manifest.json","README.md","SECURITY.md","CONTRIBUTING.md","LICENSE-MIT","LICENSE-APACHE")
if (-not $meshTaskInstall) {
    $filesToCopy += @("install-model-worker-windows.ps1","uninstall-windows.ps1")
}
foreach ($file in $filesToCopy) {
    $source = Join-Path $package $file
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $install $file) -Force
    }
}
if ($meshTaskInstall) {
    # The generic uninstaller changes the legacy model-worker registration.
    # Never expose it as the uninstaller of a side-by-side mesh installation.
    Copy-Item -LiteralPath (Join-Path $package "Uninstall-Tetherplane-Mesh.ps1") -Destination (Join-Path $install "uninstall-windows.ps1") -Force
}
if ($IncludeRelay -and (Test-Path -LiteralPath (Join-Path $package "relay"))) {
    Copy-Item -LiteralPath (Join-Path $package "relay") -Destination $install -Recurse -Force
}

$configDir = Join-Path $install "config"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

if ($InstallScheduledTask) {
    $agentArgs | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $configDir "agent-args.json") -Encoding UTF8
    $taskPowerShellArgs = '-NoProfile -NonInteractive -WindowStyle Hidden'
    if (-not $meshTaskInstall) {
        # Preserve the legacy task contract; signed mesh agents never need an
        # execution-policy override.
        $taskPowerShellArgs += ' -ExecutionPolicy Bypass'
    }
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($taskPowerShellArgs + ' -File "' + (Join-Path $install "launch\tetherplane-agent.ps1") + '"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    if ($existingTask) {
        Unregister-ScheduledTask -TaskPath '\' -TaskName $taskName -Confirm:$false
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
