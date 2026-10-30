$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$installer = Join-Path $repo "scripts\install-authenticated-browser-windows.ps1"

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "authenticated browser installer is missing"
}

$text = Get-Content -LiteralPath $installer -Raw

if ($text -match "Register-ScheduledTask") {
    throw "authenticated browser companion must not require scheduled-task registration"
}

if ($text -notmatch "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run") {
    throw "authenticated browser companion must use per-user HKCU Run persistence"
}

if ($text -notmatch "TetherplaneAuthenticatedBrowserHost") {
    throw "authenticated browser companion startup value name is missing"
}

if ($text -notmatch 'tetherplane-browserw\.exe') {
    throw "browser persistence must use the native GUI launcher"
}
if ($text -match '\-WindowStyle\s+Hidden' -or
    $text -match 'browser-extension-host-supervisor\.ps1' -or
    $text -match "'powershell\.exe '\s*\+") {
    throw "legacy PowerShell browser autorun is forbidden"
}
Write-Output "AUTH_BROWSER_USER_PERSISTENCE_CONTRACT=PASS"
Write-Output "AUTH_BROWSER_NO_POWERSHELL_AUTORUN_CONTRACT=PASS"
