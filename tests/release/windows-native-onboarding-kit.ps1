# Disposable Windows CI-only native onboarding acceptance.
# Never run on a personal workstation or an existing Tetherplane installation.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -cne "true" -or
    $env:RUNNER_OS -cne "Windows" -or
    $env:TETHERPLANE_DISPOSABLE_NATIVE_TEST -cne "1") {
    throw "HALT: this test requires an explicitly opted-in disposable GitHub Windows runner"
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ("tetherplane-native-kit-ci-" + [Guid]::NewGuid().ToString("N"))
$kit = Join-Path $root "kit"
$install = Join-Path $root "installed"
$state = Join-Path $root "isolated-state"
$taskName = "Tetherplane CI-" + [Guid]::NewGuid().ToString("N")
$deviceId = "CIKIT" + [Guid]::NewGuid().ToString("N").Substring(0, 10)
$registered = $false
$agentPid = -1
$native = Join-Path $install "bin\tetherd.exe"
$agentArgsPath = Join-Path $install "config\agent-args.json"

try {
    $outsideAgents = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe'" -ErrorAction Stop)
    if ($outsideAgents.Count -ne 0) { throw "CI runner has an existing tetherd agent: cannot claim isolation" }
    $existing = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
        $_.TaskName -match '(?i)^Tetherplane(?:\s+\S+)*\s+Agent$' -or
        @($_.Actions | Where-Object {
            $_.PSObject.Properties["Execute"] -and [string]$_.Execute -match '(?i)[\\/]tetherd\.exe$'
        }).Count -gt 0
    })
    if ($existing.Count -ne 0) { throw "CI runner has an existing agent task: isolation not proven" }
    if (Test-Path -LiteralPath $root) { throw "GUID staging prefix collision" }
    New-Item -ItemType Directory -Force -Path $root | Out-Null

    $package = Join-Path $repo "scripts\package-windows-device-kit.ps1"
    & $package -OutputPath $kit -SkipBuild
    if (-not (Test-Path -LiteralPath (Join-Path $kit "bin\tetherd.exe"))) {
        throw "node-free test package lacks tetherd.exe"
    }
    if (Test-Path -LiteralPath (Join-Path $kit "adapters")) {
        throw "device-only package unexpectedly requires an adapter or Node runtime"
    }

    . (Join-Path $repo "scripts\setup-windows-device.ps1")
    $verified = Confirm-DevicePackage -PackagePath $kit
    if (-not $verified.ok) { throw "unsigned disposable package integrity check failed" }
    [void](Install-ManagedDeviceFiles -PackagePath $kit -InstallPrefix $install)
    [void](Install-DeviceIdentity -StateDir $state -DeviceId $deviceId)

    $result = Install-DeviceAgentTask -InstallPrefix $install -StateDir $state -DeviceId $deviceId -RelayUrl "wss://127.0.0.1:65534/device" -TaskName $taskName
    $registered = $true
    if (-not $result.native_task -or -not $result.started) {
        throw "native agent task was not registered and started"
    }

    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $actions = @($task.Actions)
    $expectedArguments = '--arguments-file "' + $agentArgsPath + '"'
    if ($actions.Count -ne 1 -or [string]$actions[0].Execute -ine $native -or
        [string]$actions[0].Arguments -cne $expectedArguments) {
        throw "scheduled task does not own the exact native executable and local argument file"
    }
    if ([string]$task.Settings.MultipleInstances -ne "IgnoreNew" -or
        [int]$task.Settings.RestartCount -ne 99) {
        throw "native task single-instance/restart controls are not preserved"
    }
    if ([string]$actions[0].Arguments -match '(?i)credential|principal|bearer|token|relay-url|device-id') {
        throw "native scheduled-task command line leaks identity configuration"
    }

    $args = @(Get-Content -LiteralPath $agentArgsPath -Raw -ErrorAction Stop | ConvertFrom-Json)
    foreach ($mustContain in @("--device-id", $deviceId, "--device-credential-file", "--principal-profile", "--state-dir")) {
        if ($args -notcontains $mustContain) { throw "local argument-file contract is missing $mustContain" }
    }
    $profile = Get-Content -LiteralPath (Join-Path $state "principal.json") -Raw | ConvertFrom-Json
    if (@($profile.allowed_capabilities).Count -ne 1 -or
        @($profile.allowed_capabilities)[0] -cne "device.status" -or
        @($profile.allowed_devices)[0] -cne $deviceId) {
        throw "installer widened launch-bound permissions"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $candidate = @()
    do {
        $candidate = @(Get-CimInstance Win32_Process -Filter "Name='tetherd.exe'" -ErrorAction Stop |
            Where-Object { [string]$_.ExecutablePath -ieq $native })
        if ($candidate.Count -eq 1) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($candidate.Count -ne 1) { throw "native device task failed to own exactly one running agent" }
    $agentPid = [int]$candidate[0].ProcessId

    $adopted = Install-DeviceAgentTask -InstallPrefix $install -StateDir $state -DeviceId $deviceId -RelayUrl "wss://127.0.0.1:65534/device" -TaskName $taskName
    if (-not $adopted.reused -or -not $adopted.native_task) {
        throw "repeat onboarding did not safely adopt its own exact native task"
    }

    $otherName = "Tetherplane CI-" + [Guid]::NewGuid().ToString("N")
    $rejected = $false
    try {
        [void](Install-DeviceAgentTask -InstallPrefix $install -StateDir $state -DeviceId $deviceId -RelayUrl "wss://127.0.0.1:65534/device" -TaskName $otherName)
    }
    catch {
        if ($_.Exception.Message -match "competing|already running|existing agent task") { $rejected = $true }
        else { throw }
    }
    if (-not $rejected) { throw "second agent task registration was not denied" }
    if (Get-ScheduledTask -TaskName $otherName -ErrorAction SilentlyContinue) {
        throw "duplicate task was registered despite a refusal"
    }

    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        if (-not (Get-Process -Id $agentPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (Get-Process -Id $agentPid -ErrorAction SilentlyContinue) {
        throw "stopping the owning Scheduled Task left an orphan process"
    }
    Write-Output "WINDOWS_NATIVE_ONBOARDING_KIT_PASS: agent-only package, native task, least privilege, reuse, duplicate denial and no orphan"
}
finally {
    if ($registered) {
        $owned = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($owned -and @($owned.Actions).Count -eq 1 -and
            [string]$owned.Actions[0].Execute -ieq $native) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
    if ($agentPid -gt 0) {
        $still = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $agentPid) -ErrorAction SilentlyContinue
        if ($still -and [string]$still.ExecutablePath -ieq $native) {
            Stop-Process -Id $agentPid -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $root) {
        $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\") + "\"
        if (-not $root.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "refusing cleanup of a path outside the disposable temp root"
        }
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
    }
}
