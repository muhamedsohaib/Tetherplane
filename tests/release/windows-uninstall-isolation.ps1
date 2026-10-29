$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$uninstaller = Join-Path $repo "scripts\uninstall-windows.ps1"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "TetherplaneModelWorker"
if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "Windows uninstaller source missing"
}

# Do not read, write or delete an actual Run entry. Intercept the sole
# registry boundary while executing the real Windows uninstaller script.
$global:tpTestRunValue = $null
$global:tpTestRemovals = 0
function Get-ItemProperty {
    [CmdletBinding()]
    param([string]$Path, [string]$Name)
    if ($Path -eq "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -and $Name -eq "TetherplaneModelWorker") {
        return [pscustomobject]@{ TetherplaneModelWorker = $global:tpTestRunValue }
    }
    throw "unexpected property read intercepted"
}
function Remove-ItemProperty {
    [CmdletBinding()]
    param([string]$Path, [string]$Name)
    if ($Path -eq "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -and $Name -eq "TetherplaneModelWorker") {
        $global:tpTestRemovals++
        return
    }
    throw "unexpected registry write intercepted"
}
function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$ClassName)
    if ($ClassName -ne "Win32_Process") { throw "unexpected process inspection intercepted" }
    return @()
}
function Stop-Process { throw "test forbids process termination" }
function Unregister-ScheduledTask { throw "test forbids task unregister" }

foreach ($scenario in @("foreign", "owned")) {
    $root = Join-Path ([IO.Path]::GetTempPath()) ("tetherplane-uninstall-guard-" + [guid]::NewGuid().ToString("N"))
    $install = Join-Path $root "install"
    $state = Join-Path $root "state"
    $global:tpTestRemovals = 0
    try {
        New-Item -ItemType Directory -Force -Path (Join-Path $install "config"),$state | Out-Null
        # Current uninstaller first verifies a complete owned package prefix.
        # These are synthetic fixtures, not executable agent deployments.
        foreach ($relative in @(
            "bin\tetherd.exe",
            "bin\tetherd-agentw.exe",
            "manifest.json",
            "uninstall-windows.ps1"
        )) {
            $file = Join-Path $install $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
            [IO.File]::WriteAllText($file, "test-only")
        }
        [IO.File]::WriteAllText((Join-Path $state "preserve.txt"), "test-only")
        [ordered]@{
            install_prefix = $install
            state_dir = $state
            state_created_by_installer = $true
            scheduled_task = $null
        } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $install "config\install.json")

        if ($scenario -eq "foreign") {
            $global:tpTestRunValue = 'powershell.exe -NoProfile -File "C:\OtherProject\other-worker.ps1"'
            $expectedRemovals = 0
        } else {
            $supervisor = Join-Path $install "config\model-worker-supervisor.ps1"
            $global:tpTestRunValue = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $supervisor + '"'
            $expectedRemovals = 1
        }

        & $uninstaller -InstallPrefix $install | Out-Null
        if (Test-Path -LiteralPath $install) { throw "disposable install was not removed" }
        if (-not (Test-Path -LiteralPath (Join-Path $state "preserve.txt"))) {
            throw "ordinary uninstall deleted preserved state"
        }
        if ($global:tpTestRemovals -ne $expectedRemovals) {
            throw "RELEASE_NO_GO: $scenario model-worker Run entry: expected $expectedRemovals delete attempts, got $global:tpTestRemovals"
        }
        Write-Output "WINDOWS_UNINSTALL_ISOLATION_CASE=$scenario;VERDICT=PASS"
    }
    finally {
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Write-Output "WINDOWS_UNINSTALL_ISOLATION=PASS"
