$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$packageScript = Join-Path $repo "scripts\package-windows.ps1"
$installScript = Join-Path $repo "scripts\install-windows.ps1"
$uninstallScript = Join-Path $repo "scripts\uninstall-windows.ps1"

foreach ($required in @($packageScript, $installScript, $uninstallScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "required release script is missing: $required"
    }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("tetherplane-release-smoke-" + [guid]::NewGuid().ToString("N"))
$stage = Join-Path $root "package"
$install = Join-Path $root "install"
$state = Join-Path $root "state"
$allow = Join-Path $root "allowed"
$supervisorProcess = $null

try {
    New-Item -ItemType Directory -Force -Path $root,$allow | Out-Null

    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $packageScript -OutputPath $stage -SkipBuild
    if ($LASTEXITCODE -ne 0) {
        throw "package script failed with exit code $LASTEXITCODE"
    }

    foreach ($relative in @(
        "bin\tetherd.exe",
        "adapters\compact-mcp\dist\stdio-server.js",
        "adapters\compact-mcp\node_modules",
        "adapters\model-client\dist\worker-main.js",
        "adapters\model-client\node_modules",
        "adapters\compact-mcp\smoke-six-tools.mjs",
        "protocol\schemas\result.schema.json",
        "launch\tetherplane-mcp.ps1",
        "launch\tetherplane-agent.ps1",
        "install-windows.ps1",
        "install-model-worker-windows.ps1",
        "uninstall-windows.ps1",
        "manifest.json",
        "browser\\host.mjs",
        "browser\\extension\\manifest.json",
        "browser\\extension\\pair.html",
        "browser\\extension\\dist\\background.js",
        "browser\\extension\\dist\\pair.js",
        "launch\\tetherplane-browser.ps1",
        "launch\\tetherplane-browser-setup.ps1"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage $relative))) {
            throw "release package is missing $relative"
        }
    }

    $manifestPath = Join-Path $stage "manifest.json"
    & node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));" $manifestPath
    if ($LASTEXITCODE -ne 0) {
        throw "packaged manifest.json is not directly parseable UTF-8 JSON"
    }

    $stagedInstallScript = Get-Content -LiteralPath (Join-Path $stage "install-windows.ps1") -Raw
    foreach ($requiredArgument in @("-NonInteractive", "-WindowStyle Hidden")) {
        if (-not $stagedInstallScript.Contains($requiredArgument)) {
            throw "scheduled agent action is missing required background argument: $requiredArgument"
        }
    }

    $supervisorRoot = Join-Path $root "supervisor"
    $supervisorLaunch = Join-Path $supervisorRoot "launch"
    $supervisorBin = Join-Path $supervisorRoot "bin"
    $supervisorConfig = Join-Path $supervisorRoot "config"
    New-Item -ItemType Directory -Force -Path $supervisorLaunch,$supervisorBin,$supervisorConfig | Out-Null

    Copy-Item -LiteralPath (Join-Path $stage "launch\tetherplane-agent.ps1") -Destination (Join-Path $supervisorLaunch "tetherplane-agent.ps1")
    Copy-Item -LiteralPath (Join-Path $env:WINDIR "System32\cmd.exe") -Destination (Join-Path $supervisorBin "tetherd.exe")

    $runLog = Join-Path $supervisorRoot "runs.txt"
    $fakeCommand = 'echo tick>>"' + $runLog + '" & exit /b 1'
    @("/d", "/c", $fakeCommand) |
        ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $supervisorConfig "agent-args.json") -Encoding UTF8

    $supervisorProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle", "Hidden",
        "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $supervisorLaunch "tetherplane-agent.ps1")
    ) -PassThru

    $runs = 0
    $restartDeadline = [DateTime]::UtcNow.AddSeconds(30)

    while ($runs -lt 2 -and [DateTime]::UtcNow -lt $restartDeadline) {
        if ($supervisorProcess.HasExited) {
            throw "background agent launcher exited before restart proof; exit_code=$($supervisorProcess.ExitCode) observed_runs=$runs"
        }

        if (Test-Path -LiteralPath $runLog) {
            $runs = @(Get-Content -LiteralPath $runLog).Count
        }

        if ($runs -lt 2) {
            Start-Sleep -Milliseconds 250
        }
    }

    if ($runs -lt 2) {
        throw "background agent launcher did not restart a crashing tetherd within 30 seconds; observed runs=$runs"
    }

    if (-not $supervisorProcess.HasExited) {
        Stop-Process -Id $supervisorProcess.Id -Force -ErrorAction SilentlyContinue
        $supervisorProcess = $null
    }

    & $installScript -PackagePath $stage -InstallPrefix $install -StateDir $state
    if ($LASTEXITCODE -ne 0) {
        throw "install script failed with exit code $LASTEXITCODE"
    }

    $installedTetherd = Join-Path $install "bin\tetherd.exe"
    $installedSmoke = Join-Path $install "adapters\compact-mcp\smoke-six-tools.mjs"
    $installedWorker = Join-Path $install "adapters\model-client\dist\worker-main.js"
    $installedWorkerInstaller = Join-Path $install "install-model-worker-windows.ps1"
    foreach ($relative in @(
        "browser\\host.mjs",
        "browser\\extension\\manifest.json",
        "browser\\extension\\pair.html",
        "browser\\extension\\dist\\background.js",
        "browser\\extension\\dist\\pair.js",
        "launch\\tetherplane-browser.ps1",
        "launch\\tetherplane-browser-setup.ps1"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $install $relative) -PathType Leaf)) {
            throw "installed browser runtime is missing $relative"
        }
    }
    & node --check (Join-Path $install "browser\\host.mjs")
    if ($LASTEXITCODE -ne 0) {
        throw "installed browser host script is not parseable Node.js"
    }
    $browserManifest = Get-Content -LiteralPath (Join-Path $install "browser\\extension\\manifest.json") -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath (Join-Path $install "browser\\extension" $browserManifest.background.service_worker))) {
        throw "installed browser extension manifest points to missing service worker"
    }

    # Run the actual packaged host with isolated synthetic tokens, randomized
    # loopback ports and no real browser attachment. Syntax checks are not
    # sufficient evidence that the bundled runtime starts after installation.
    & node (Join-Path $PSScriptRoot "browser-package-runtime.mjs") $install
    if ($LASTEXITCODE -ne 0) {
        throw "installed browser runtime acceptance failed with exit code $LASTEXITCODE"
    }

    # The operator-controlled setup must generate separate, non-public, scoped
    # local token files and refuse accidental replacement or extension rebind.
    $browserSetup = Join-Path $install "launch\tetherplane-browser-setup.ps1"
    $browserState = Join-Path $root "owner-browser-state"
    & powershell.exe -NoProfile -NonInteractive -File $browserSetup -BrowserStateDir $browserState -ExtensionId "abcdefghijklmnopabcdefghijklmnop"
    if ($LASTEXITCODE -ne 0) { throw "fresh browser setup failed" }
    $tokenNames = @("browser-bridge.token","browser-extension-launch.token")
    $hashes = @{}
    foreach($name in $tokenNames) {
        $tokenPath = Join-Path $browserState $name
        if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw "browser setup missing $name" }
        if ((Get-Item -LiteralPath $tokenPath).Length -lt 32) { throw "browser setup generated short $name" }
        $acl = Get-Acl -LiteralPath $tokenPath
        if (-not $acl.AreAccessRulesProtected) { throw "browser setup token ACL inherited broad parent access" }
        $hashes[$name] = (Get-FileHash -LiteralPath $tokenPath -Algorithm SHA256).Hash
    }
    if ((Get-Content -LiteralPath (Join-Path $browserState "browser-extension.id") -Raw).Trim() -ne "abcdefghijklmnopabcdefghijklmnop") {
        throw "owner extension ID was not pinned"
    }
    & powershell.exe -NoProfile -NonInteractive -File $browserSetup -BrowserStateDir $browserState -ExtensionId "abcdefghijklmnopabcdefghijklmnop"
    if ($LASTEXITCODE -ne 0) { throw "idempotent browser setup failed" }
    foreach($name in $tokenNames) {
        if ((Get-FileHash -LiteralPath (Join-Path $browserState $name) -Algorithm SHA256).Hash -ne $hashes[$name]) {
            throw "browser setup unexpectedly rotated $name"
        }
    }
    Write-Output "BROWSER_OWNER_SETUP_SMOKE_OK"
    if (-not (Test-Path -LiteralPath $installedTetherd)) {
        throw "installed tetherd is missing"
    }
    if (-not (Test-Path -LiteralPath $installedWorker)) {
        throw "installed model worker is missing"
    }
    if (-not (Test-Path -LiteralPath $installedWorkerInstaller)) {
        throw "installed model worker activation script is missing"
    }

    & node $installedSmoke --tetherd $installedTetherd --allow $allow --state-dir $state
    if ($LASTEXITCODE -ne 0) {
        throw "installed six-tool smoke failed with exit code $LASTEXITCODE"
    }

    $sentinel = Join-Path $state "preserve-me.txt"
    Set-Content -LiteralPath $sentinel -Value "preserve" -NoNewline

    & $uninstallScript -InstallPrefix $install
    if ($LASTEXITCODE -ne 0) {
        throw "uninstall script failed with exit code $LASTEXITCODE"
    }
    if (Test-Path -LiteralPath $install) {
        throw "uninstall left installed binaries behind"
    }
    if (-not (Test-Path -LiteralPath $sentinel)) {
        throw "ordinary uninstall deleted preserved state"
    }

    Write-Output "WINDOWS_PACKAGE_SMOKE_OK"
}
finally {
    if ($supervisorProcess -and -not $supervisorProcess.HasExited) {
        Stop-Process -Id $supervisorProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
