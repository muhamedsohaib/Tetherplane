# Standalone Windows Developer Beta toast acceptance.
# No Store/MSIX, no elevation, no scheduled tasks, no device commands.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ToastExecutable,
    [string]$ExpectedSha256,
    [switch]$KeepRegistration
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$identity = 'ARCUSLabs.Tetherplane.DevBeta'
$registrar = Join-Path $PSScriptRoot 'Register-TetherplaneToastBeta.ps1'
if (-not (Test-Path -LiteralPath $registrar -PathType Leaf)) {
    throw 'BETA_REGISTRAR_NOT_FOUND'
}
if (-not [IO.Path]::IsPathRooted($ToastExecutable) -or
    (Split-Path -Leaf $ToastExecutable) -cne 'tetherplane-toast-smoke.exe' -or
    -not (Test-Path -LiteralPath $ToastExecutable -PathType Leaf)) {
    throw 'BETA_EXECUTABLE_NOT_VERIFIED'
}
$exe = (Resolve-Path -LiteralPath $ToastExecutable).Path
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
if ($ExpectedSha256 -and $hash -ine $ExpectedSha256) {
    throw 'BETA_ARTIFACT_HASH_MISMATCH'
}
$link = Join-Path ([Environment]::GetFolderPath('Programs')) 'Tetherplane Developer Beta.lnk'
$createdHere = -not (Test-Path -LiteralPath $link)
$registered = $false
try {
    & $registrar -Operation Register -Executable $exe | Out-Host
    $registered = $true

    [void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
    $manager = [Windows.UI.Notifications.ToastNotificationManager]
    $before = @($manager::History.GetHistory($identity)).Count

    # The Rust CLI will fail with nonzero code if Windows rejects native dispatch.
    # It only displays a static synthetic test; no production device identity is used.
    try {
        & $exe --smoke --developer-beta | Out-Host
    } catch {
        # Fail closed on enforced Windows application-control rules. Never suggest bypasses.
        # Keep the exact cause distinct from an agent, identity, or toast-code failure.
        if ($_.Exception.Message -match '(?i)application control policy has blocked this file') {
            throw 'BETA_WINDOWS_APPLICATION_CONTROL_BLOCKED: unsigned test binary was denied by host policy; no security-policy change was attempted.'
        }
        throw
    }
    if ($LASTEXITCODE -ne 0) {
        throw ('BETA_NATIVE_TOAST_DISPATCH_FAILED_EXIT_' + $LASTEXITCODE)
    }

    $after = @($manager::History.GetHistory($identity)).Count
    Write-Output ('BETA_WINDOWS_HISTORY_BEFORE=' + $before)
    Write-Output ('BETA_WINDOWS_HISTORY_AFTER=' + $after)
    Write-Output ('BETA_EXECUTABLE_SHA256=' + $hash)
    if ($after -le $before) {
        throw 'BETA_NOTIFICATION_HISTORY_NOT_CONFIRMED'
    }
    Write-Output 'BETA_NATIVE_NOTIFICATION_HISTORY_VERIFIED'
    Write-Output 'BETA_POPUP_VISIBILITY_REQUIRES_HUMAN_CONFIRMATION'
} finally {
    if ($registered -and $createdHere -and -not $KeepRegistration) {
        & $registrar -Operation Unregister | Out-Host
    }
}
