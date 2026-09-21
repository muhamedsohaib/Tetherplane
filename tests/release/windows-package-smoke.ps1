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

    & $packageScript -OutputPath $stage -SkipBuild
    if ($LASTEXITCODE -ne 0) {
        throw "package script failed with exit code $LASTEXITCODE"
    }

    foreach ($relative in @(
        "bin\tetherd.exe",
        "adapters\compact-mcp\dist\stdio-server.js",
        "adapters\compact-mcp\node_modules",
        "adapters\compact-mcp\smoke-six-tools.mjs",
        "protocol\schemas\result.schema.json",
        "launch\tetherplane-mcp.ps1",
        "launch\tetherplane-agent.ps1",
        "install-windows.ps1",
        "uninstall-windows.ps1",
        "manifest.json"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage $relative))) {
            throw "release package is missing $relative"
        }
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

    Start-Sleep -Seconds 8

    $runs = if (Test-Path -LiteralPath $runLog) {
        @(Get-Content -LiteralPath $runLog).Count
    }
    else {
        0
    }

    if ($runs -lt 2) {
        throw "background agent launcher did not restart a crashing tetherd; observed runs=$runs"
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
    if (-not (Test-Path -LiteralPath $installedTetherd)) {
        throw "installed tetherd is missing"
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
