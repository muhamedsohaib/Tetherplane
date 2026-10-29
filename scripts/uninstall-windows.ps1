param(
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [switch]$PurgeState
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$install = [IO.Path]::GetFullPath($InstallPrefix)
$config = Join-Path $install "config\install.json"
# Uninstall is destructive: require a self-consistent installation receipt,
# expected install artifacts and an ordinary directory before any mutations.
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

# Fail closed on running agents in this prefix, whether console or windowless.
$ownedExecutables = @(
    [IO.Path]::GetFullPath((Join-Path $install "bin\tetherd.exe")),
    [IO.Path]::GetFullPath((Join-Path $install "bin\tetherd-agentw.exe"))
)
$runningOwned = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe' OR Name='tetherd-agentw.exe'" -ErrorAction Stop |
    Where-Object {
        $exe = [string]$_.ExecutablePath
        $exe -and @($ownedExecutables | Where-Object { [string]::Equals($_, $exe, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    })
if ($runningOwned.Count -gt 0) {
    throw "refusing uninstall: agent executable is still running in this prefix"
}

# A receipt's task name alone is not an authorization to unregister a task.
$taskName = $null
if ($receipt.PSObject.Properties.Name -contains "scheduled_task" -and [string]$receipt.scheduled_task) {
    $taskName = [string]$receipt.scheduled_task
    if ($taskName -notmatch '^Tetherplane(?:[ -][A-Za-z0-9._-]+)*
$modelWorkerRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$modelWorkerRunValue = "TetherplaneModelWorker"
Remove-ItemProperty -Path $modelWorkerRunKey -Name $modelWorkerRunValue -ErrorAction SilentlyContinue

$modelWorkerSupervisor = Join-Path $install "config\model-worker-supervisor.ps1"
$modelWorkerMain = Join-Path $install "adapters\model-client\dist\worker-main.js"
$modelWorkerProcesses =
    @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $name = [string]$_.Name
            $commandLine = [string]$_.CommandLine
            (
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

$stateDir = $null
$stateManaged = $false
if ($receipt) {
    if ($receipt.state_dir) {
        $stateDir = [IO.Path]::GetFullPath([string]$receipt.state_dir)
    }
    $stateManaged = [bool]$receipt.state_created_by_installer
}

if (Test-Path -LiteralPath $install) {
    Remove-Item -LiteralPath $install -Recurse -Force
}

if ($PurgeState) {
    if (-not $stateDir) {
        throw "cannot purge state without an install receipt"
    }
    if (-not $stateManaged) {
        throw "refusing to purge a state directory not created by the Tetherplane installer"
    }
    $root = [IO.Path]::GetPathRoot($stateDir)
    if ($stateDir -eq $root -or $stateDir.Length -le $root.Length + 3) {
        throw "refusing unsafe state purge path: $stateDir"
    }
    Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "TETHERPLANE_UNINSTALL_OK $install"
) {
        throw "refusing uninstall: task ownership name mismatch"
    }
    $tasks = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
    $taskExe = [IO.Path]::GetFullPath((Join-Path $install "bin\tetherd-agentw.exe"))
    $taskArgs = '--arguments-file "' + (Join-Path $install "config\agent-args.json") + '"'
    if ($tasks.Count -ne 1 -or @($tasks[0].Actions).Count -ne 1) {
        throw "refusing uninstall: task ownership cannot be uniquely verified"
    }
    $task = $tasks[0]
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$task.Actions[0].Execute), $taskExe, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$task.Actions[0].Arguments -cne $taskArgs -or
        [string]$task.Principal.RunLevel -ne "Limited" -or
        [string]$task.State -eq "Running") {
        throw "refusing uninstall: task ownership mismatch or agent still running"
    }
}

# All preflight ownership checks have passed; only now alter a verified task.
if ($taskName) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$modelWorkerRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$modelWorkerRunValue = "TetherplaneModelWorker"
Remove-ItemProperty -Path $modelWorkerRunKey -Name $modelWorkerRunValue -ErrorAction SilentlyContinue

$modelWorkerSupervisor = Join-Path $install "config\model-worker-supervisor.ps1"
$modelWorkerMain = Join-Path $install "adapters\model-client\dist\worker-main.js"
$modelWorkerProcesses =
    @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $name = [string]$_.Name
            $commandLine = [string]$_.CommandLine
            (
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

$stateDir = $null
$stateManaged = $false
if ($receipt) {
    if ($receipt.state_dir) {
        $stateDir = [IO.Path]::GetFullPath([string]$receipt.state_dir)
    }
    $stateManaged = [bool]$receipt.state_created_by_installer
}

if (Test-Path -LiteralPath $install) {
    Remove-Item -LiteralPath $install -Recurse -Force
}

if ($PurgeState) {
    if (-not $stateDir) {
        throw "cannot purge state without an install receipt"
    }
    if (-not $stateManaged) {
        throw "refusing to purge a state directory not created by the Tetherplane installer"
    }
    $root = [IO.Path]::GetPathRoot($stateDir)
    if ($stateDir -eq $root -or $stateDir.Length -le $root.Length + 3) {
        throw "refusing unsafe state purge path: $stateDir"
    }
    Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "TETHERPLANE_UNINSTALL_OK $install"
