param(
    [string]$BrowserStateDir = (Join-Path $env:LOCALAPPDATA "Tetherplane")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Manual, per-user browser host. It never provisions new tokens, pairs an
# extension, registers persistence or changes a running tetherd configuration.
# Start only after local owner-approved browser pairing has created the
# two existing secret files. No credential value is printed.
$install = Split-Path -Parent $PSScriptRoot
$hostScript = Join-Path $install "browser\host.mjs"
$extension = Join-Path $install "browser\extension\manifest.json"
$agentToken = Join-Path $BrowserStateDir "browser-bridge.token"
$extensionToken = Join-Path $BrowserStateDir "browser-extension-launch.token"
$pinnedExtensionId = Join-Path $BrowserStateDir "browser-extension.id"

foreach ($required in @($hostScript, $extension, $agentToken, $extensionToken)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Tetherplane browser cannot start: required local file missing: $required"
    }
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$oldAgentToken = [Environment]::GetEnvironmentVariable("TETHERPLANE_BROWSER_BRIDGE_TOKEN_FILE", "Process")
$oldExtensionToken = [Environment]::GetEnvironmentVariable("TETHERPLANE_EXTENSION_LAUNCH_TOKEN_FILE", "Process")
$oldExtensionId = [Environment]::GetEnvironmentVariable("TETHERPLANE_EXTENSION_ID_FILE", "Process")
try {
    $env:TETHERPLANE_BROWSER_BRIDGE_TOKEN_FILE = $agentToken
    $env:TETHERPLANE_EXTENSION_LAUNCH_TOKEN_FILE = $extensionToken
    $env:TETHERPLANE_EXTENSION_ID_FILE = $pinnedExtensionId
    & $node $hostScript
    if ($LASTEXITCODE -ne 0) {
        throw "Tetherplane browser host exited with code $LASTEXITCODE"
    }
}
finally {
    [Environment]::SetEnvironmentVariable("TETHERPLANE_BROWSER_BRIDGE_TOKEN_FILE", $oldAgentToken, "Process")
    [Environment]::SetEnvironmentVariable("TETHERPLANE_EXTENSION_LAUNCH_TOKEN_FILE", $oldExtensionToken, "Process")
    [Environment]::SetEnvironmentVariable("TETHERPLANE_EXTENSION_ID_FILE", $oldExtensionId, "Process")
}
