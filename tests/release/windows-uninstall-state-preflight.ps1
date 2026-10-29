$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$uninstaller = Join-Path $repo "scripts\uninstall-windows.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("tetherplane-uninstall-state-ci-" + [guid]::NewGuid().ToString("N"))
$global:tpPreflightRegistryAttempts = 0

# Protect actual HKCU Run values even against a regression in the uninstaller.
function Remove-ItemProperty {
    [CmdletBinding()]
    param([string]$Path,[string]$Name)
    if ($Path -ne "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -or
        $Name -ne "TetherplaneModelWorker") {
        throw "unexpected registry removal in state-purge CI test"
    }
    $global:tpPreflightRegistryAttempts++
}
function New-DisposableInstall {
    param([string]$Prefix,[string]$State,[bool]$InstallerOwned)
    foreach ($relative in @(
        "config\install.json",
        "bin\tetherd.exe",
        "bin\tetherd-agentw.exe",
        "manifest.json",
        "uninstall-windows.ps1"
    )) {
        $path = Join-Path $Prefix $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        [IO.File]::WriteAllText($path, "test-only")
    }
    [ordered]@{
        install_prefix = $Prefix
        state_dir = $State
        state_created_by_installer = $InstallerOwned
        scheduled_task = $null
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Prefix "config\install.json")
    New-Item -ItemType Directory -Force -Path $State | Out-Null
    [IO.File]::WriteAllText((Join-Path $State "preserve.txt"), "test-owned")
}

try {
    $foreignInstall = Join-Path $root "foreign-state-install"
    $foreignState = Join-Path $root "foreign-preserved-state"
    New-DisposableInstall -Prefix $foreignInstall -State $foreignState -InstallerOwned $false
    $rejected = $false
    try {
        & $uninstaller -InstallPrefix $foreignInstall -PurgeState
    }
    catch {
        if ([string]$_.Exception.Message -match "not created by the Tetherplane installer") {
            $rejected = $true
        } else { throw }
    }
    if (-not $rejected -or
        -not (Test-Path -LiteralPath (Join-Path $foreignInstall "config\install.json") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $foreignState "preserve.txt") -PathType Leaf) -or
        $global:tpPreflightRegistryAttempts -ne 0) {
        throw "RELEASE_NO_GO: invalid -PurgeState caused changes before ownership preflight"
    }
    Write-Output "WINDOWS_UNOWNED_STATE_PREDELETE_REJECTED_OK"

    # Deleting a state directory must continue to work when the same
    # installation receipt explicitly records it was installer-created.
    $managedInstall = Join-Path $root "managed-install"
    $managedState = Join-Path $root "managed-state"
    New-DisposableInstall -Prefix $managedInstall -State $managedState -InstallerOwned $true
    & $uninstaller -InstallPrefix $managedInstall -PurgeState
    if ((Test-Path -LiteralPath $managedInstall) -or
        (Test-Path -LiteralPath $managedState)) {
        throw "RELEASE_NO_GO: valid owned-state purge did not clean both install and state"
    }
    Write-Output "WINDOWS_OWNED_STATE_PURGE_OK"
}
finally {
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

