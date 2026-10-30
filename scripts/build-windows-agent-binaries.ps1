$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "two-mode native executable build requires Windows"
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$consoleExe = Join-Path $repo "target\release\tetherd.exe"
$windowlessExe = Join-Path $repo "target\release\tetherd-agentw.exe"
$browserWindowlessExe = Join-Path $repo "target\release\tetherplane-browserw.exe"
$modelWindowlessExe = Join-Path $repo "target\release\tetherplane-modelw.exe"
$storeSetupWindowlessExe = Join-Path $repo "target\release\tetherplane-setupw.exe"
$storeAutostartWindowlessExe = Join-Path $repo "target\release\tetherplane-autostartw.exe"

Push-Location $repo
try {
    # Never reuse a stale windowless artifact from a different source revision.
    Remove-Item -LiteralPath $windowlessExe -Force -ErrorAction SilentlyContinue

    # Same core policy/transport, but use the Windows GUI subsystem so a
    # scheduled background process does not allocate a visible console.
    & cargo build --release --locked -p tetherd --features windows-headless-agent
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $consoleExe -PathType Leaf)) {
        throw "windowless agent build failed"
    }
    Copy-Item -LiteralPath $consoleExe -Destination $windowlessExe -Force

    # Restore the ordinary Cargo-managed console executable for existing
    # MCP stdin/stdout users and developer commands.
    & cargo build --release --locked -p tetherd
    if ($LASTEXITCODE -ne 0 -or
        -not (Test-Path -LiteralPath $consoleExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $browserWindowlessExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $modelWindowlessExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $storeSetupWindowlessExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $storeAutostartWindowlessExe -PathType Leaf)) {
        throw "stdio agent or native browser launcher build failed"
    }
}
catch {
    Remove-Item -LiteralPath $windowlessExe -Force -ErrorAction SilentlyContinue
    throw
}
finally {
    Pop-Location
}

Write-Output "WINDOWS_DUAL_AGENT_BINARY_BUILD_OK"
Write-Output "WINDOWS_NATIVE_BROWSER_GUI_BUILD_OK"
Write-Output "WINDOWS_NATIVE_MODEL_GUI_BUILD_OK"
Write-Output "WINDOWS_STORE_SETUP_GUI_BUILD_OK"
Write-Output "WINDOWS_STORE_AUTOSTART_GUI_BUILD_OK"

