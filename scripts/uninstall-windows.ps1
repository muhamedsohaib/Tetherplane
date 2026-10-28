param(
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [switch]$PurgeState
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$install = [IO.Path]::GetFullPath($InstallPrefix)
$config = Join-Path $install "config\install.json"
$receipt = $null
if (Test-Path -LiteralPath $config -PathType Leaf) {
    $receipt = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
}

if ($receipt -and $receipt.scheduled_task) {
    $taskName = [string]$receipt.scheduled_task
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
}

$modelWorkerRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$modelWorkerRunValue = "TetherplaneModelWorker"
$modelWorkerSupervisor = Join-Path $install "config\model-worker-supervisor.ps1"
$modelWorkerMain = Join-Path $install "adapters\model-client\dist\worker-main.js"

# A disposable installation must not delete an unrelated model worker's
# globally named startup entry. Only unregister the exact command that
# install-model-worker-windows.ps1 creates for THIS install prefix.
$expectedRunCommand = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $modelWorkerSupervisor + '"'
$existingRunValue = Get-ItemProperty -Path $modelWorkerRunKey -Name $modelWorkerRunValue -ErrorAction SilentlyContinue
if ($existingRunValue -and [string]$existingRunValue.$modelWorkerRunValue -ceq $expectedRunCommand) {
    Remove-ItemProperty -Path $modelWorkerRunKey -Name $modelWorkerRunValue -ErrorAction SilentlyContinue
}
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
