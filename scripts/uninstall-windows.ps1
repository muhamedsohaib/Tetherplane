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
