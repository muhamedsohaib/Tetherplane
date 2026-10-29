$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Disposable Windows Task Scheduler test. No production agent, relay, registry
# or Tetherplane task is referenced; registered names contain a random CI GUID.
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$uninstaller = Join-Path $repo "scripts\uninstall-windows.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("tetherplane-uninstall-owner-ci-" + [guid]::NewGuid().ToString("N"))
$foreign = Join-Path $root "foreign-install"
$foreignTask = "Tetherplane CI Foreign-" + [guid]::NewGuid().ToString("N")
$owned = Join-Path $root "owned-install"
$ownedTask = "Tetherplane CI Owned-" + [guid]::NewGuid().ToString("N")

# The uninstaller may inspect HKCU Run in CI, but may not modify any real value.
$global:runRegistryRemovalAttempts = 0
function Remove-ItemProperty {
    [CmdletBinding()]
    param([string]$Path, [string]$Name)
    if ($Path -eq "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -and
        $Name -eq "TetherplaneModelWorker") {
        $global:runRegistryRemovalAttempts++
        return
    }
    throw "unexpected registry removal intercepted in disposable uninstaller test"
}

function New-CiOwnedPrefix {
    param([string]$Prefix,[string]$TaskName)
    foreach($relative in @(
        "config\install.json",
        "config\agent-args.json",
        "bin\tetherd.exe",
        "bin\tetherd-agentw.exe",
        "manifest.json",
        "uninstall-windows.ps1"
    )) {
        $path = Join-Path $Prefix $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        if ($relative -eq "bin\tetherd-agentw.exe") {
            Copy-Item -LiteralPath (Join-Path $env:WINDIR "System32\cmd.exe") -Destination $path
        } else {
            [IO.File]::WriteAllText($path, "test-only")
        }
    }
    [ordered]@{
        install_prefix = $Prefix
        state_dir = (Join-Path $root "preserved-state")
        state_created_by_installer = $false
        scheduled_task = $TaskName
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Prefix "config\install.json")
}

try {
    New-CiOwnedPrefix -Prefix $foreign -TaskName $foreignTask
    $marker = Join-Path $foreign "do-not-delete.txt"
    [IO.File]::WriteAllText($marker, "FOREIGN-OWNER")

    $foreignAction = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR "System32\cmd.exe") -Argument "/d /c exit /b 0"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $foreignTask -Action $foreignAction -Trigger $trigger -RunLevel Limited | Out-Null

    $rejected = $false
    try {
        & $uninstaller -InstallPrefix $foreign
    }
    catch {
        if ([string]$_.Exception.Message -match "task ownership") {
            $rejected = $true
        } else { throw }
    }
    if (-not $rejected) {
        throw "RELEASE_NO_GO: uninstall accepted a receipt referencing a foreign task"
    }
    if (-not (Get-ScheduledTask -TaskName $foreignTask -ErrorAction SilentlyContinue)) {
        throw "RELEASE_NO_GO: uninstaller removed foreign scheduled task before owner verification"
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw) -ne "FOREIGN-OWNER") {
        throw "RELEASE_NO_GO: rejected foreign-task uninstall deleted unrelated files"
    }
    if ($global:runRegistryRemovalAttempts -ne 0) {
        throw "RELEASE_NO_GO: rejected foreign-task uninstall reached registry mutation"
    }
    Write-Output "WINDOWS_FOREIGN_TASK_UNINSTALL_REJECTED_OK"

    # Without a receipt, an unrelated directory is not a Tetherplane install.
    $missingReceipt = Join-Path $root "missing-receipt"
    New-Item -ItemType Directory -Force -Path $missingReceipt | Out-Null
    $missingMarker = Join-Path $missingReceipt "keep.txt"
    [IO.File]::WriteAllText($missingMarker, "KEEP")
    $missingRejected = $false
    try {
        & $uninstaller -InstallPrefix $missingReceipt
    }
    catch {
        if ([string]$_.Exception.Message -match "install receipt") {
            $missingRejected = $true
        } else { throw }
    }
    if (-not $missingRejected -or -not (Test-Path -LiteralPath $missingMarker -PathType Leaf)) {
        throw "RELEASE_NO_GO: uninstaller accepted a foreign prefix without a receipt"
    }
    Write-Output "WINDOWS_MISSING_RECEIPT_UNINSTALL_REJECTED_OK"

    # The same uninstaller must still remove its own stopped scheduled task.
    New-CiOwnedPrefix -Prefix $owned -TaskName $ownedTask
    $ownedExe = Join-Path $owned "bin\tetherd-agentw.exe"
    $ownedArgs = Join-Path $owned "config\agent-args.json"
    $ownedAction = New-ScheduledTaskAction -Execute $ownedExe -Argument ('--arguments-file "' + $ownedArgs + '"')
    Register-ScheduledTask -TaskName $ownedTask -Action $ownedAction -Trigger $trigger -RunLevel Limited | Out-Null
    & $uninstaller -InstallPrefix $owned
    if (Test-Path -LiteralPath $owned) {
        throw "RELEASE_NO_GO: own inactive install prefix was not uninstalled"
    }
    if (Get-ScheduledTask -TaskName $ownedTask -ErrorAction SilentlyContinue) {
        throw "RELEASE_NO_GO: own inactive task was not unregistered"
    }
    Write-Output "WINDOWS_OWNED_TASK_UNINSTALL_OK"
}
finally {
    foreach($name in @($foreignTask,$ownedTask)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

