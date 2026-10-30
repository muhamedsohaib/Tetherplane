param(
    [string]$RepoRoot = "C:\Users\Sohaib\source\Tetherplane"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Development-only owner opt-in; the production package uses its own
# owner-approved browser setup. Never register a PowerShell/Windows Terminal
# supervisor, silently rotate credentials, or replace an existing autorun.
$root = Join-Path $env:LOCALAPPDATA "Tetherplane"
$launcher = Join-Path $RepoRoot "target\release\tetherplane-browserw.exe"
$hostScript = Join-Path $RepoRoot "scripts\browser-extension-host.ts"
$extensionRoot = Join-Path $RepoRoot "extension\browser"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "TetherplaneAuthenticatedBrowserHost"

foreach ($required in @(
    $launcher,
    $hostScript,
    (Join-Path $extensionRoot "manifest.json"),
    (Join-Path $extensionRoot "dist\background.js"),
    (Join-Path $root "browser-bridge.token"),
    (Join-Path $root "browser-extension-launch.token"),
    (Join-Path $root "browser-extension.id")
)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Owner-controlled browser prerequisite missing; no startup changes made"
    }
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    throw "Node.js is required before installing browser autorun"
}
$pin = (Get-Content -LiteralPath (Join-Path $root "browser-extension.id") -Raw).Trim()
if ($pin -cnotmatch '^[a-p]{32}$') {
    throw "Pinned browser extension ID is invalid"
}
$command = '"' + $launcher + '" --browser-host-script "' + $hostScript +
    '" --browser-state-dir "' + $root + '"'
$existingProperty = Get-ItemProperty -LiteralPath $runKey -Name $runName -ErrorAction SilentlyContinue
$existing = if ($existingProperty) { [string]$existingProperty.$runName } else { $null }
if ($existing -and $existing -cne $command) {
    throw "Existing browser autorun may own a live process; explicit owner-approved migration required"
}

New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name $runName -Value $command -PropertyType String -Force | Out-Null
if ((Get-ItemProperty -LiteralPath $runKey -Name $runName).$runName -cne $command) {
    throw "Windowless owner-browser startup registration failed"
}
Write-Output "AUTH_BROWSER_AUTOSTART=WINDOWLESS_NATIVE_OWNER_ONLY"

$running = @(Get-CimInstance Win32_Process -Filter "Name='tetherplane-browserw.exe'" |
    Where-Object { [string]$_.CommandLine -match 'browser-extension-host\.ts' })
if ($running.Count -gt 1) {
    throw "Multiple native browser launchers detected; preserving all for review"
}
if ($running.Count -eq 0) {
    Start-Process -FilePath $launcher -ArgumentList @(
        '--browser-host-script', ('"' + $hostScript + '"'),
        '--browser-state-dir', ('"' + $root + '"')
    ) | Out-Null
}
Write-Output "AUTH_BROWSER_STARTUP_REQUESTED=True"
