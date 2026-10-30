param(
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [switch]$PurgeState
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$install = [IO.Path]::GetFullPath($InstallPrefix)
$config = Join-Path $install "config\install.json"
# Validate the installed directory and task ownership before any mutation.
$receiptError = "refusing uninstall: missing or mismatched Tetherplane install receipt"
if (-not (Test-Path -LiteralPath $config -PathType Leaf) -or
    -not (Test-Path -LiteralPath $install -PathType Container)) {
    throw $receiptError
}
if (((Get-Item -LiteralPath $install -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "refusing uninstall: install prefix is a reparse point"
}
try {
    $receipt = Get-Content -LiteralPath $config -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if (-not $receipt -or $receipt.PSObject.Properties.Name -notcontains "install_prefix") {
        throw $receiptError
    }
    $claimedInstall = [IO.Path]::GetFullPath([string]$receipt.install_prefix)
    if (-not [string]::Equals($claimedInstall, $install, [StringComparison]::OrdinalIgnoreCase)) {
        throw $receiptError
    }
}
catch {
    throw $receiptError
}
foreach ($ownedFile in @("bin\tetherd.exe","bin\tetherd-agentw.exe","manifest.json","uninstall-windows.ps1")) {
    if (-not (Test-Path -LiteralPath (Join-Path $install $ownedFile) -PathType Leaf)) {
        throw $receiptError
    }
}

# A live agent in this prefix must be stopped through an explicit owner-approved
# lifecycle action; unregistering a task alone could leave an orphan process.
$ownedExecutables = @(
    [IO.Path]::GetFullPath((Join-Path $install "bin\tetherd.exe"))
    [IO.Path]::GetFullPath((Join-Path $install "bin\tetherd-agentw.exe"))
)
$runningOwned = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe' OR Name='tetherd-agentw.exe'" -ErrorAction Stop |
    Where-Object {
        $exe = [string]$_.ExecutablePath
        $exe -and ($ownedExecutables -icontains $exe)
    })
if ($runningOwned.Count -gt 0) {
    throw "refusing uninstall: agent executable is still running in this prefix"
}

$taskName = $null
if ($receipt.PSObject.Properties.Name -contains "scheduled_task" -and [string]$receipt.scheduled_task) {
    $taskName = [string]$receipt.scheduled_task
    if ($taskName -notmatch '^Tetherplane(?:[ -][A-Za-z0-9._-]+)*$') {
        throw "refusing uninstall: task ownership name mismatch"
    }
    $tasks = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
    if ($tasks.Count -ne 1 -or @($tasks[0].Actions).Count -ne 1) {
        throw "refusing uninstall: task ownership cannot be uniquely verified"
    }
    $task = $tasks[0]
    $expectedExe = [IO.Path]::GetFullPath((Join-Path $install "bin\tetherd-agentw.exe"))
    $expectedArguments = '--arguments-file "' + (Join-Path $install "config\agent-args.json") + '"'
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$task.Actions[0].Execute), $expectedExe, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$task.Actions[0].Arguments -cne $expectedArguments -or
        [string]$task.Principal.RunLevel -ne "Limited" -or
        [string]$task.State -eq "Running") {
        throw "refusing uninstall: task ownership mismatch or agent still running"
    }
}

# State purge authorization must be checked BEFORE unregistering a task,
# removing a Run value, terminating any worker or deleting installation files.
$stateDir = $null
$stateManaged = $false
if ($receipt.PSObject.Properties.Name -contains "state_dir" -and [string]$receipt.state_dir) {
    $stateDir = [IO.Path]::GetFullPath([string]$receipt.state_dir)
    if ([string]::Equals($install.TrimEnd('\'), $stateDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
        $stateDir.StartsWith($install.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $install.StartsWith($stateDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'refusing uninstall: state and install directories overlap; owner migration required'
    }
}
if ($receipt.PSObject.Properties.Name -contains "state_created_by_installer") {
    $stateManaged = [bool]$receipt.state_created_by_installer
}
if ($PurgeState) {
    if (-not $stateDir) {
        throw "cannot purge state without an install receipt"
    }
    if (-not $stateManaged) {
        throw "refusing to purge a state directory not created by the Tetherplane installer"
    }
    $stateRoot = [IO.Path]::GetPathRoot($stateDir)
    if ($stateDir -eq $stateRoot -or $stateDir.Length -le $stateRoot.Length + 3) {
        throw "refusing unsafe state purge path: $stateDir"
    }
    if (Test-Path -LiteralPath $stateDir -PathType Container) {
        if (((Get-Item -LiteralPath $stateDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "refusing state purge through a reparse point"
        }
    }
}

# Refuse to remove an active owner browser companion from this exact install.
# The owner must first stop the session in an approved maintenance operation.
$ownedBrowserExe = [IO.Path]::GetFullPath((Join-Path $install "bin\tetherplane-browserw.exe"))
$liveBrowser = @(Get-CimInstance Win32_Process -Filter "Name='tetherplane-browserw.exe'" -ErrorAction Stop |
    Where-Object {
        $exe = [string]$_.ExecutablePath
        $exe -and [string]::Equals($exe, $ownedBrowserExe, [StringComparison]::OrdinalIgnoreCase)
    })
if ($liveBrowser.Count -gt 0) {
    throw "refusing uninstall: owned authenticated browser is running; stop in an approved maintenance step"
}

# Only a verified task action in a stopped state is eligible for unregister.
if ($taskName) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Optional browser HKCU Run cleanup is restricted to the *exact installed*
# native executable and the single supported owner-state argument. Preserve
# any foreign or legacy registrations unchanged for owner-reviewed migration.
$browserRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$browserRunName = "TetherplaneAuthenticatedBrowserHost"
$browserRegistration = Get-ItemProperty -Path $browserRunKey -Name $browserRunName -ErrorAction SilentlyContinue
if ($browserRegistration) {
    $registeredBrowser = [string]$browserRegistration.$browserRunName
    $ownedPrefix = '^"' + [regex]::Escape($ownedBrowserExe) + '" --browser-state-dir "[^"]+"$'
    if ($registeredBrowser -match $ownedPrefix) {
        Remove-ItemProperty -Path $browserRunKey -Name $browserRunName -ErrorAction SilentlyContinue
    }
}

$modelWorkerRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$modelWorkerRunValue = "TetherplaneModelWorker"
$modelWorkerSupervisor = Join-Path $install "config\model-worker-supervisor.ps1"
$modelWorkerMain = Join-Path $install "adapters\model-client\dist\worker-main.js"
$modelWorkerNative = Join-Path $install "bin\tetherplane-modelw.exe"
$modelWorkerArgs = Join-Path $install "config\model-worker-args.json"

# Do not remove a different installation's globally named Run registration.
$expectedRunCommand = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $modelWorkerSupervisor + '"'
$expectedNativeRun = '"' + $modelWorkerNative + '" --arguments-file "' + $modelWorkerArgs + '"'
$existingRunValue = Get-ItemProperty -Path $modelWorkerRunKey -Name $modelWorkerRunValue -ErrorAction SilentlyContinue
if ($existingRunValue -and [string]$existingRunValue.$modelWorkerRunValue -cin @($expectedRunCommand, $expectedNativeRun)) {
    Remove-ItemProperty -Path $modelWorkerRunKey -Name $modelWorkerRunValue -ErrorAction SilentlyContinue
}
$modelWorkerProcesses =
    @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $name = [string]$_.Name
            $commandLine = [string]$_.CommandLine
            (
                ($name -eq "tetherplane-modelw.exe") -and
                ([string]$_.ExecutablePath -ieq $modelWorkerNative)
            ) -or (
                ($name -in @("powershell.exe", "pwsh.exe")) -and
                ($commandLine.IndexOf($modelWorkerSupervisor, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
            ) -or (
                ($name -eq "node.exe") -and
                ($commandLine.IndexOf($modelWorkerMain, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
            )
        }
    )

foreach ($process in $modelWorkerProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $install) {
    Remove-Item -LiteralPath $install -Recurse -Force
}
if ($PurgeState) {
    Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "TETHERPLANE_UNINSTALL_OK $install"
