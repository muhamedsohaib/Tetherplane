param(
    [string]$RepoRoot = "C:\Users\Sohaib\source\Tetherplane"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Join-Path $env:LOCALAPPDATA "Tetherplane"

$agentToken =
    Join-Path $root "browser-bridge.token"

$extensionToken =
    Join-Path $root "browser-extension-launch.token"

$supervisor =
    Join-Path $root "browser-extension-host-supervisor.ps1"

$stdout =
    Join-Path $root "browser-extension-host.stdout.log"

$stderr =
    Join-Path $root "browser-extension-host.stderr.log"

$hostScript =
    Join-Path $RepoRoot "scripts\browser-extension-host.ts"

$extensionRoot =
    Join-Path $RepoRoot "extension\browser"

$legacyTaskName =
    "Tetherplane Authenticated Browser Host"

$runKey =
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

$runValueName =
    "TetherplaneAuthenticatedBrowserHost"


function Test-LoopbackPort {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $client =
        New-Object System.Net.Sockets.TcpClient

    try {
        $client.Connect(
            "127.0.0.1",
            $Port
        )

        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}


function Stop-AuthenticatedBrowserProcesses {
    $processes =
        @(
            Get-CimInstance Win32_Process |
            Where-Object {
                $name =
                    [string]$_.Name

                $commandLine =
                    [string]$_.CommandLine

                $isSupervisor =
                    (
                        $name -in @(
                            "powershell.exe",
                            "pwsh.exe"
                        )
                    ) -and
                    (
                        $commandLine.IndexOf(
                            $supervisor,
                            [System.StringComparison]::OrdinalIgnoreCase
                        ) -ge 0
                    )

                $isHost =
                    (
                        $name -eq "node.exe"
                    ) -and
                    (
                        $commandLine.IndexOf(
                            $hostScript,
                            [System.StringComparison]::OrdinalIgnoreCase
                        ) -ge 0
                    )

                $isSupervisor -or $isHost
            }
        )

    foreach ($process in $processes) {
        Stop-Process `
            -Id $process.ProcessId `
            -Force `
            -ErrorAction SilentlyContinue
    }

    if ($processes.Count -gt 0) {
        Start-Sleep -Seconds 2
    }

    return $processes.Count
}


if (
    -not (
        Test-Path `
            -LiteralPath $hostScript `
            -PathType Leaf
    )
) {
    throw "Authenticated browser host script is missing."
}


if (
    -not (
        Test-Path `
            -LiteralPath $agentToken `
            -PathType Leaf
    )
) {
    throw "Existing browser bridge token file is missing."
}


New-Item `
    -ItemType Directory `
    -Force `
    -Path $root |
    Out-Null


if (
    -not (
        Test-Path `
            -LiteralPath $extensionToken `
            -PathType Leaf
    )
) {
    $bytes =
        New-Object byte[] 32

    $rng =
        [System.Security.Cryptography.RandomNumberGenerator]::Create()

    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }

    $value =
        [Convert]::ToBase64String($bytes)

    $utf8NoBom =
        New-Object System.Text.UTF8Encoding($false)

    [IO.File]::WriteAllText(
        $extensionToken,
        $value,
        $utf8NoBom
    )

    $identity =
        [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

    $acl =
        New-Object System.Security.AccessControl.FileSecurity

    $acl.SetAccessRuleProtection(
        $true,
        $false
    )

    $rule =
        New-Object `
            System.Security.AccessControl.FileSystemAccessRule(
                $identity,
                "FullControl",
                "Allow"
            )

    $acl.AddAccessRule($rule)

    Set-Acl `
        -LiteralPath $extensionToken `
        -AclObject $acl
}


Write-Output "=== BUILD BROWSER EXTENSION ==="

Push-Location $RepoRoot

try {
    $pnpm =
        (Get-Command pnpm.cmd -ErrorAction Stop).Source

    & $pnpm `
        --filter `
        "@tetherplane/browser-extension" `
        build

    if ($LASTEXITCODE -ne 0) {
        throw "Browser extension build failed."
    }
}
finally {
    Pop-Location
}


Write-Output "=== WRITE AUTHENTICATED BROWSER SUPERVISOR ==="

$supervisorLines =
    @(
        '$ErrorActionPreference = "Continue"'
        'Set-StrictMode -Version Latest'
        ''
        '$repo = "__REPO__"'
        '$hostScript = Join-Path $repo "scripts\browser-extension-host.ts"'
        '$stdout = "__STDOUT__"'
        '$stderr = "__STDERR__"'
        '$node = (Get-Command node.exe -ErrorAction Stop).Source'
        ''
        'Set-Location $repo'
        ''
        'while ($true) {'
        '    & $node $hostScript 1>> $stdout 2>> $stderr'
        '    Start-Sleep -Seconds 2'
        '}'
    )

$supervisorSource =
    $supervisorLines -join [Environment]::NewLine

$supervisorSource =
    $supervisorSource.Replace(
        "__REPO__",
        $RepoRoot
    )

$supervisorSource =
    $supervisorSource.Replace(
        "__STDOUT__",
        $stdout
    )

$supervisorSource =
    $supervisorSource.Replace(
        "__STDERR__",
        $stderr
    )

$utf8NoBom =
    New-Object System.Text.UTF8Encoding($false)

[IO.File]::WriteAllText(
    $supervisor,
    $supervisorSource,
    $utf8NoBom
)


Write-Output "=== REMOVE LEGACY COMPANION PERSISTENCE ==="

$legacyTask =
    Get-ScheduledTask `
        -TaskName $legacyTaskName `
        -ErrorAction SilentlyContinue

$legacyTaskFound =
    $null -ne $legacyTask

if ($legacyTaskFound) {
    Stop-ScheduledTask `
        -TaskName $legacyTaskName `
        -ErrorAction SilentlyContinue

    $oldPreference =
        $ErrorActionPreference

    try {
        $ErrorActionPreference =
            "Continue"

        & schtasks.exe `
            /Delete `
            /TN $legacyTaskName `
            /F `
            2>$null |
            Out-Null

        $deleteExit =
            $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference =
            $oldPreference
    }

    if ($deleteExit -ne 0) {
        throw "Failed to remove legacy authenticated-browser task."
    }
}

Write-Output "LEGACY_BROWSER_TASK_REMOVED=$legacyTaskFound"


Write-Output "=== STOP EXISTING AUTHENTICATED BROWSER HOST ==="

$stoppedProcessCount =
    Stop-AuthenticatedBrowserProcesses

Write-Output "OLD_AUTH_BROWSER_PROCESS_COUNT=$stoppedProcessCount"


Write-Output "=== CONFIGURE PER-USER STARTUP ==="

$actionArgument =
    '-NoProfile ' +
    '-NonInteractive ' +
    '-WindowStyle Hidden ' +
    '-ExecutionPolicy Bypass ' +
    '-File "' +
    $supervisor +
    '"'

$runCommand =
    'powershell.exe ' +
    $actionArgument

New-Item `
    -Path $runKey `
    -Force |
    Out-Null

New-ItemProperty `
    -Path $runKey `
    -Name $runValueName `
    -Value $runCommand `
    -PropertyType String `
    -Force |
    Out-Null

$persistedRunCommand =
    (
        Get-ItemProperty `
            -Path $runKey `
            -Name $runValueName
    ).$runValueName

if ($persistedRunCommand -ne $runCommand) {
    throw "Authenticated browser HKCU Run persistence verification failed."
}

Write-Output "AUTH_BROWSER_PERSISTENCE=HKCU_RUN"


Write-Output "=== START AUTHENTICATED BROWSER HOST ==="

Remove-Item `
    $stdout,
    $stderr `
    -Force `
    -ErrorAction SilentlyContinue

Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $actionArgument `
    -WindowStyle Hidden |
    Out-Null

Start-Sleep -Seconds 6


Write-Output "=== VERIFY AUTHENTICATED BROWSER HOST ==="

$pairingReady =
    Test-LoopbackPort 17656

$extensionReady =
    Test-LoopbackPort 17658

$hostProcesses =
    @(
        Get-CimInstance Win32_Process |
        Where-Object {
            $name =
                [string]$_.Name

            $commandLine =
                [string]$_.CommandLine

            (
                $name -in @(
                    "powershell.exe",
                    "pwsh.exe"
                )
            ) -and
            (
                $commandLine.IndexOf(
                    $supervisor,
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -ge 0
            )
        }
    )

Write-Output "AUTH_BROWSER_HOST_PROCESS_COUNT=$($hostProcesses.Count)"
Write-Output "AUTH_PAIRING_PORT_READY=$pairingReady"
Write-Output "AUTH_EXTENSION_WS_READY=$extensionReady"
Write-Output "EXTENSION_UNPACKED_PATH=$extensionRoot"

if ($hostProcesses.Count -ne 1) {
    throw "Expected exactly one authenticated browser supervisor."
}

if (
    -not $pairingReady -or
    -not $extensionReady
) {
    if (
        Test-Path `
            -LiteralPath $stderr `
            -PathType Leaf
    ) {
        Write-Output "=== AUTHENTICATED BROWSER STDERR ==="

        Get-Content `
            -LiteralPath $stderr `
            -Tail 30
    }

    throw "Authenticated browser host did not become ready."
}


Write-Output ""
Write-Output "AUTH_BROWSER_HOST_INSTALL=PASS"