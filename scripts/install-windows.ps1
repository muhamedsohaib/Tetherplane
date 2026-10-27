param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA "Tetherplane\state"),
    [switch]$Force,
    [switch]$IncludeRelay,
    [switch]$InstallScheduledTask,
    [string]$AgentArgumentsFile,
    [switch]$PreflightOnly
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

# Fail before any install/state writes or task replacement. A bare tetherd.exe
# exits with CLI code 2: a scheduled agent must have a transport mode.
# The argument file is parsed locally but its contents never enter diagnostics.
$agentArgs = $null
if ($InstallScheduledTask) {
    if ([string]::IsNullOrWhiteSpace($AgentArgumentsFile)) {
        throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: scheduled task requires a local argument file"
    }
    $agentArgsSource = (Resolve-Path -LiteralPath $AgentArgumentsFile -ErrorAction Stop).Path
    $rawArgs = Get-Content -LiteralPath $agentArgsSource -Raw -ErrorAction Stop
    # PowerShell 5.1 can unwrap a one-element JSON array into a scalar.
    # Verify the original top-level shape, then normalize both forms.
    if (-not $rawArgs.TrimStart().StartsWith('[') -or
        -not $rawArgs.TrimEnd().EndsWith(']')) {
        throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: arguments must be a JSON array"
    }
    try {
        $decoded = ConvertFrom-Json -InputObject $rawArgs -ErrorAction Stop
    } catch {
        throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: invalid argument JSON"
    }
    $agentArgs = @($decoded)
    if ($agentArgs.Count -eq 0) {
        throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: missing transport and identity arguments"
    }
    foreach ($arg in $agentArgs) {
        if (-not ($arg -is [string]) -or [string]::IsNullOrWhiteSpace($arg)) {
            throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: empty or non-string agent argument"
        }
    }
    $stdio = @($agentArgs | Where-Object { $_ -ceq '--stdio-rpc' }).Count
    $remote = @($agentArgs | Where-Object { $_ -ceq '--relay-url' }).Count
    if ($stdio + $remote -ne 1) {
        throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: exactly one agent transport mode is required"
    }
    if ($remote -eq 1) {
        foreach ($flag in @('--relay-url', '--device-id', '--device-credential-file')) {
            $indices = @()
            for ($i = 0; $i -lt $agentArgs.Count; $i++) {
                if ($agentArgs[$i] -ceq $flag) { $indices += $i }
            }
            if ($indices.Count -ne 1 -or $indices[0] -ge ($agentArgs.Count - 1) -or
                [string]::IsNullOrWhiteSpace([string]$agentArgs[$indices[0] + 1]) -or
                [string]$agentArgs[$indices[0] + 1] -like '--*') {
                throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: incomplete or duplicate remote device argument"
            }
        }
        # Never inspect, output or hash the referenced credential file here.
    } elseif ($agentArgs -contains '--device-id' -or
              $agentArgs -contains '--device-credential-file') {
        throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: device identity requires remote transport"
    }
    # On SAC-enforced Windows, refuse to schedule a new untrusted native PE.
    # A valid signature is NOT proof SAC will admit execution; live proof remains.
    $sacMode = $null
    try {
        $policy = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name 'VerifiedAndReputablePolicyState' -ErrorAction Stop
        $sacMode = [int]$policy.VerifiedAndReputablePolicyState
    } catch {
        # An unreadable policy is not proof that SAC is Off.
    }
    if ($sacMode -eq 1) {
        $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $package 'bin\tetherd.exe') -ErrorAction Stop
        if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
            throw "SCHEDULED_AGENT_PREFLIGHT_NO_GO: SAC is On and native executable is not trusted-signed"
        }
    }
}

# A dry, read-only admission result lets CI and operators verify a candidate
# without deleting/replacing any prior install or creating a task. This never
# constitutes relay authentication or Windows SAC execution acceptance.
if ($PreflightOnly) {
    Write-Output 'TETHERPLANE_INSTALL_PREFLIGHT_PASS: no install/state/task changes'
    return
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
    ConvertTo-Json -InputObject $agentArgs -Depth 4 | Set-Content -LiteralPath (Join-Path $configDir "agent-args.json") -Encoding UTF8

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
