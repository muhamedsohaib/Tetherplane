$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Fast, isolated fail-first regression. The package contains only placeholders,
# and the populated foreign directory is created solely under a unique temp root.
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$installer = Join-Path $repo "scripts\install-windows.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("tetherplane-force-owner-ci-" + [guid]::NewGuid().ToString("N"))
$package = Join-Path $root "synthetic-package"
$foreign = Join-Path $root "foreign-app-directory"
$state = Join-Path $root "state"
$marker = Join-Path $foreign "unrelated-owned-data.txt"
try {
    foreach ($relative in @(
        "bin\tetherd.exe",
        "bin\tetherd-agentw.exe",
        "adapters\compact-mcp\dist\stdio-server.js",
        "protocol\schemas\result.schema.json",
        "launch\tetherplane-mcp.ps1",
        "launch\tetherplane-browser.ps1",
        "launch\tetherplane-browser-setup.ps1",
        "browser\host.mjs",
        "browser\extension\manifest.json",
        "browser\extension\dist\background.js",
        "browser\extension\dist\pair.js",
        "manifest.json"
    )) {
        $path = Join-Path $package $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        [IO.File]::WriteAllText($path, "synthetic-ci-only")
    }
    New-Item -ItemType Directory -Force -Path $foreign | Out-Null
    [IO.File]::WriteAllText($marker, "must-preserve")

    $rejected = $false
    try {
        & $installer -PackagePath $package -InstallPrefix $foreign -StateDir $state -Force
    }
    catch {
        if ([string]$_.Exception.Message -match "verified Tetherplane install receipt") {
            $rejected = $true
        }
        else {
            throw
        }
    }
    if (-not $rejected) {
        throw "RELEASE_NO_GO: -Force accepted a populated foreign prefix without an owned Tetherplane receipt"
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw) -ne "must-preserve") {
        throw "RELEASE_NO_GO: -Force modified unrelated files despite rejecting the install"
    }
    if (Test-Path -LiteralPath $state) {
        throw "RELEASE_NO_GO: rejected -Force install still created a state directory"
    }
    Write-Output "WINDOWS_FOREIGN_PREFIX_FORCE_REJECTED_OK"

    # A JSON receipt copied from another directory cannot authorize replacement.
    New-Item -ItemType Directory -Force -Path (Join-Path $foreign "config") | Out-Null
    [ordered]@{
        install_prefix = (Join-Path $root "different-prefix")
        state_dir = $state
        scheduled_task = $null
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $foreign "config\install.json")
    $mismatchDenied = $false
    try {
        & $installer -PackagePath $package -InstallPrefix $foreign -StateDir $state -Force
    }
    catch {
        if ([string]$_.Exception.Message -match "verified Tetherplane install receipt") {
            $mismatchDenied = $true
        }
        else { throw }
    }
    if (-not $mismatchDenied -or -not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw "RELEASE_NO_GO: mismatched install receipt allowed a populated prefix to be replaced"
    }
    Write-Output "WINDOWS_MISMATCHED_RECEIPT_FORCE_REJECTED_OK"

    # Legitimate, task-free installations retain the option to be upgraded,
    # without silently replacing a registered agent or a foreign directory.
    $owned = Join-Path $root "owned-install"
    $ownedState = Join-Path $root "owned-state"
    foreach ($relative in @(
        "config\install.json",
        "bin\tetherd.exe",
        "bin\tetherd-agentw.exe",
        "manifest.json",
        "uninstall-windows.ps1"
    )) {
        $path = Join-Path $owned $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        [IO.File]::WriteAllText($path, "old-owned-test-only")
    }
    $ownedSentinel = Join-Path $owned "previous-owned-file.txt"
    [IO.File]::WriteAllText($ownedSentinel, "replace-this")
    [ordered]@{
        install_prefix = $owned
        state_dir = $ownedState
        state_created_by_installer = $false
        scheduled_task = $null
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $owned "config\install.json")
    & $installer -PackagePath $package -InstallPrefix $owned -StateDir $ownedState -Force
    if (Test-Path -LiteralPath $ownedSentinel -PathType Leaf) {
        throw "RELEASE_NO_GO: installer did not replace a legitimate task-free Tetherplane installation"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $owned "config\install.json") -PathType Leaf)) {
        throw "RELEASE_NO_GO: upgraded owned install did not receive a new receipt"
    }
    Write-Output "WINDOWS_OWNED_PREFIX_FORCE_UPGRADE_OK"

    # A malformed scheduled-agent argument file must be rejected BEFORE the
    # installer deletes an otherwise valid, task-free previous installation.
    $preflightInstall = Join-Path $root "preflight-install"
    $preflightState = Join-Path $root "preflight-state"
    $preflightArgs = Join-Path $root "invalid-agent-args.json"
    $preflightTask = "Tetherplane CI-" + [guid]::NewGuid().ToString("N")
    foreach ($relative in @(
        "config\install.json",
        "bin\tetherd.exe",
        "bin\tetherd-agentw.exe",
        "manifest.json",
        "uninstall-windows.ps1"
    )) {
        $file = Join-Path $preflightInstall $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
        [IO.File]::WriteAllText($file, "owned-before-install")
    }
    $preflightMarker = Join-Path $preflightInstall "previous-content.txt"
    [IO.File]::WriteAllText($preflightMarker, "PRESERVE-UNTIL-VALIDATED")
    [ordered]@{
        install_prefix = $preflightInstall
        state_dir = $preflightState
        state_created_by_installer = $false
        scheduled_task = $null
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $preflightInstall "config\install.json")
    $receiptBefore = Get-Content -LiteralPath (Join-Path $preflightInstall "config\install.json") -Raw
    [IO.File]::WriteAllText($preflightArgs, '["--stdio-rpc"]')
    $preflightRejected = $false
    try {
        & $installer -PackagePath $package -InstallPrefix $preflightInstall -StateDir $preflightState -Force -InstallScheduledTask -AgentTaskName $preflightTask -AgentArgumentsFile $preflightArgs
    }
    catch {
        if ([string]$_.Exception.Message -match "scheduled agent requires relay identity") {
            $preflightRejected = $true
        } else { throw }
    }
    if (-not $preflightRejected) {
        throw "RELEASE_NO_GO: invalid scheduled-agent arguments were accepted"
    }
    if (-not (Test-Path -LiteralPath $preflightMarker -PathType Leaf) -or
        (Get-Content -LiteralPath $preflightMarker -Raw) -ne "PRESERVE-UNTIL-VALIDATED" -or
        (Get-Content -LiteralPath (Join-Path $preflightInstall "config\install.json") -Raw) -cne $receiptBefore -or
        (Test-Path -LiteralPath $preflightState) -or
        (Get-ScheduledTask -TaskName $preflightTask -ErrorAction SilentlyContinue)) {
        throw "RELEASE_NO_GO: invalid scheduled-agent arguments deleted a previous installation before preflight"
    }
    Write-Output "WINDOWS_AGENT_ARGS_FORCE_PREDELETE_REJECTED_OK"
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

