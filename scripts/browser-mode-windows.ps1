param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("isolated", "authenticated")]
    [string]$Mode
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$install = Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"
$argsPath = Join-Path $install "config\agent-args.json"
$tetherd = Join-Path $install "bin\tetherd.exe"
$tokenPath = Join-Path $env:LOCALAPPDATA "Tetherplane\browser-bridge.token"
$taskName = "Tetherplane Agent"

$targetPort =
    if ($Mode -eq "authenticated") { 17657 } else { 17655 }

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

if (-not (Test-LoopbackPort $targetPort)) {
    throw "Requested browser backend is not ready on loopback port $targetPort."
}

if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw "Browser bridge token file is missing."
}

$agentArgs = Get-Content -LiteralPath $argsPath -Raw | ConvertFrom-Json

if (-not ($agentArgs -is [System.Array])) {
    throw "agent-args.json is not a JSON array."
}

$newArgs = New-Object System.Collections.Generic.List[string]

for ($i = 0; $i -lt $agentArgs.Count; $i++) {
    $arg = [string]$agentArgs[$i]

    if (
        $arg -in @(
            "--browser-bridge",
            "--browser-bridge-token-file"
        )
    ) {
        $i++
        continue
    }

    $newArgs.Add($arg)
}

$newArgs.Add("--browser-bridge")
$newArgs.Add("127.0.0.1:$targetPort")
$newArgs.Add("--browser-bridge-token-file")
$newArgs.Add($tokenPath)

$json = ConvertTo-Json -InputObject $newArgs.ToArray() -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($argsPath, $json, $utf8NoBom)

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$oldAgents =
    @(
        Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq "tetherd.exe" -and
            $_.ExecutablePath -eq $tetherd
        }
    )

foreach ($agent in $oldAgents) {
    Stop-Process -Id $agent.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 8

$task = Get-ScheduledTask -TaskName $taskName
$agents =
    @(
        Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq "tetherd.exe" -and
            $_.ExecutablePath -eq $tetherd
        }
    )

Write-Output "BROWSER_MODE=$Mode"
Write-Output "BROWSER_RPC_PORT=$targetPort"
Write-Output "AGENT_TASK_STATE=$($task.State)"
Write-Output "TETHERD_PROCESS_COUNT=$($agents.Count)"

if ($task.State -ne "Running") {
    throw "Tetherplane Agent did not remain running."
}

if ($agents.Count -ne 1) {
    throw "Expected exactly one persistent tetherd."
}

Write-Output "TETHERPLANE_BROWSER_MODE_SWITCH=PASS"
