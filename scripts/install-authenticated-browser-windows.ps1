param(
    [string]$RepoRoot = "C:\Users\Sohaib\source\Tetherplane"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Join-Path $env:LOCALAPPDATA "Tetherplane"
$agentToken = Join-Path $root "browser-bridge.token"
$extensionToken = Join-Path $root "browser-extension-launch.token"
$supervisor = Join-Path $root "browser-extension-host-supervisor.ps1"
$stdout = Join-Path $root "browser-extension-host.stdout.log"
$stderr = Join-Path $root "browser-extension-host.stderr.log"
$hostScript = Join-Path $RepoRoot "scripts\browser-extension-host.ts"
$extensionRoot = Join-Path $RepoRoot "extension\browser"
$taskName = "Tetherplane Authenticated Browser Host"

if (-not (Test-Path -LiteralPath $hostScript -PathType Leaf)) {
    throw "Authenticated browser host script is missing."
}

if (-not (Test-Path -LiteralPath $agentToken -PathType Leaf)) {
    throw "Existing browser bridge token file is missing."
}

New-Item -ItemType Directory -Force -Path $root | Out-Null

if (-not (Test-Path -LiteralPath $extensionToken -PathType Leaf)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }

    $value = [Convert]::ToBase64String($bytes)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($extensionToken, $value, $utf8NoBom)

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity,
        "FullControl",
        "Allow"
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $extensionToken -AclObject $acl
}

Push-Location $RepoRoot
try {
    pnpm --filter @tetherplane/browser-extension build
    if ($LASTEXITCODE -ne 0) {
        throw "Browser extension build failed."
    }
}
finally {
    Pop-Location
}

$supervisorSource = @'
$ErrorActionPreference = "Continue"
$repo = "__REPO__"
$hostScript = Join-Path $repo "scripts\browser-extension-host.ts"
$stdout = "__STDOUT__"
$stderr = "__STDERR__"
$node = (Get-Command node.exe -ErrorAction Stop).Source
Set-Location $repo
while ($true) {
    & $node $hostScript 1>> $stdout 2>> $stderr
    Start-Sleep -Seconds 2
}
'@

$supervisorSource = $supervisorSource.Replace("__REPO__", $RepoRoot)
$supervisorSource = $supervisorSource.Replace("__STDOUT__", $stdout)
$supervisorSource = $supervisorSource.Replace("__STDERR__", $stderr)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($supervisor, $supervisorSource, $utf8NoBom)

$actionArgument =
    '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    $supervisor +
    '"'

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgument
$trigger = New-ScheduledTaskTrigger -AtLogOn

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -RunLevel Limited -Force | Out-Null

Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 6

function Test-LoopbackPort {
    param([int]$Port)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect("127.0.0.1", $Port)
        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

$task = Get-ScheduledTask -TaskName $taskName
$pairingReady = Test-LoopbackPort 17656
$extensionReady = Test-LoopbackPort 17658

Write-Output "AUTH_BROWSER_HOST_TASK_STATE=$($task.State)"
Write-Output "AUTH_PAIRING_PORT_READY=$pairingReady"
Write-Output "AUTH_EXTENSION_WS_READY=$extensionReady"
Write-Output "EXTENSION_UNPACKED_PATH=$extensionRoot"

if (-not $pairingReady -or -not $extensionReady) {
    if (Test-Path -LiteralPath $stderr) {
        Get-Content -LiteralPath $stderr -Tail 30
    }
    throw "Authenticated browser host did not become ready."
}

Write-Output "AUTH_BROWSER_HOST_INSTALL=PASS"
