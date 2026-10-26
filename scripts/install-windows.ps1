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

# Preflight before creating or deleting anything. Device state must not live
# inside the binaries directory, or vice versa.
$installRoot = $install.TrimEnd([char[]]@('\', '/'))
$stateRoot = $state.TrimEnd([char[]]@('\', '/'))
$comparison = [StringComparison]::OrdinalIgnoreCase
if ([string]::Equals($installRoot, $stateRoot, $comparison) -or
    $installRoot.StartsWith(($stateRoot + [IO.Path]::DirectorySeparatorChar), $comparison) -or
    $stateRoot.StartsWith(($installRoot + [IO.Path]::DirectorySeparatorChar), $comparison)) {
    throw "install prefix and state directory must not overlap"
}

# In particular, invalid agent arguments must never erase a prior install
# on a forced retry. Validate every input before creating install/state.
$validatedAgentArgs = $null
if ($InstallScheduledTask) {
    if (-not $AgentArgumentsFile -or -not (Test-Path -LiteralPath $AgentArgumentsFile -PathType Leaf)) {
        throw "-InstallScheduledTask requires an existing -AgentArgumentsFile"
    }
    $agentArgsSource = (Resolve-Path -LiteralPath $AgentArgumentsFile).Path
    try {
        $validatedAgentArgs = Get-Content -LiteralPath $agentArgsSource -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "AgentArgumentsFile must contain valid JSON of tetherd arguments"
    }
    if (-not ($validatedAgentArgs -is [System.Array]) -or $validatedAgentArgs.Count -eq 0) {
        throw "AgentArgumentsFile must contain a nonempty JSON array of tetherd arguments"
    }
    foreach ($argument in $validatedAgentArgs) {
        if ($argument -isnot [string] -or [string]::IsNullOrWhiteSpace($argument)) {
            throw "scheduled agent arguments must contain nonempty strings only"
        }
    }
    foreach ($requiredFlag in @("--relay-url", "--device-id", "--device-credential-file")) {
        if ($validatedAgentArgs -cnotcontains $requiredFlag) {
            throw "scheduled agent arguments require $requiredFlag"
        }
        $flagIndex = [array]::IndexOf($validatedAgentArgs, $requiredFlag)
        if ($flagIndex -ge ($validatedAgentArgs.Count - 1) -or
            ([string]$validatedAgentArgs[$flagIndex + 1]).StartsWith("--")) {
            throw "scheduled agent argument $requiredFlag requires a nonempty value"
        }
    }
    if (Get-ScheduledTask -TaskName "Tetherplane Agent" -ErrorAction SilentlyContinue) {
        throw "existing Tetherplane Agent task requires separately reviewed migration"
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
    if ($existing.Count -gt 0) {
        # -Force is deliberately non-destructive pending a separately tested
        # versioned upgrade and rollback procedure. Never overwrite a device.
        throw "refusing to replace a populated install prefix, including with -Force; use an approved migration"
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
    $validatedAgentArgs | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $configDir "agent-args.json") -Encoding UTF8

    $taskName = "Tetherplane Agent"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $install "launch\tetherplane-agent.ps1") + '"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        throw "scheduled task already exists: $taskName; explicit migration required"
    }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -RunLevel Limited | Out-Null
}

$receipt = [ordered]@{
    install_prefix = $install
    state_dir = $state
    state_created_by_installer = (-not $stateExisted)
    scheduled_task = $taskName
}
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $configDir "install.json") -Encoding UTF8

Write-Output "TETHERPLANE_INSTALL_OK $install"
