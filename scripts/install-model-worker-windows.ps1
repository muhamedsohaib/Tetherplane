param(
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [Parameter(Mandatory = $true)][string]$Device,
    [Parameter(Mandatory = $true)][string]$ModelEndpoint,
    [Parameter(Mandatory = $true)][string]$Model,
    [Parameter(Mandatory = $true)][string]$PrincipalProfile,
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA "Tetherplane\state"),
    [string[]]$AllowRoots = @(),
    [string]$ApiKeyEnv,
    [int]$PollMs = 1000,
    [int]$MaxActions = 32,
    [int]$LeaseTtlMs = 600000,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$install = [IO.Path]::GetFullPath($InstallPrefix)
$state = [IO.Path]::GetFullPath($StateDir)
$configDir = Join-Path $install "config"
$workerMain = Join-Path $install "adapters\model-client\dist\worker-main.js"
$tetherd = Join-Path $install "bin\tetherd.exe"
$nativeLauncher = Join-Path $install "bin\tetherplane-modelw.exe"
$argsFile = Join-Path $configDir "model-worker-args.json"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "TetherplaneModelWorker"

foreach ($required in @($workerMain, $tetherd, $nativeLauncher, $PrincipalProfile)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "model worker required file missing; no startup changes made"
    }
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node.js unavailable" }
if (-not $Device.Trim() -or -not $Model.Trim()) { throw "model worker device/model cannot be empty" }

$endpoint = $null
if (-not [Uri]::TryCreate($ModelEndpoint, [UriKind]::Absolute, [ref]$endpoint) -or
    $endpoint.Scheme -notin @("http", "https") -or $endpoint.UserInfo) {
    throw "model endpoint must be http(s) without embedded credentials"
}
if ($PollMs -lt 100 -or $PollMs -gt 300000 -or
    $MaxActions -lt 1 -or $MaxActions -gt 1000 -or
    $LeaseTtlMs -lt 1 -or $LeaseTtlMs -gt 3600000) {
    throw "invalid bounded model-worker limits"
}
if ($ApiKeyEnv) {
    if ($ApiKeyEnv -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        throw "API key environment name is invalid"
    }
    $present = [Environment]::GetEnvironmentVariable($ApiKeyEnv,"Process") -or
        [Environment]::GetEnvironmentVariable($ApiKeyEnv,"User") -or
        [Environment]::GetEnvironmentVariable($ApiKeyEnv,"Machine")
    if (-not $present) { throw "configured model credential environment name is unavailable" }
}

$runCommand = '"' + $nativeLauncher + '" --arguments-file "' + $argsFile + '"'
$registration = Get-ItemProperty -LiteralPath $runKey -Name $runName -ErrorAction SilentlyContinue
$existing = if ($registration) { [string]$registration.$runName } else { $null }
if ($existing -and $existing -cne $runCommand) {
    throw "existing model worker autorun must be migrated with separate owner approval"
}
$running = @(Get-CimInstance Win32_Process -Filter "Name='tetherplane-modelw.exe'" -ErrorAction Stop |
    Where-Object { [string]$_.ExecutablePath -ieq $nativeLauncher })
if ($running.Count -gt 0) {
    throw "native model worker is running; stop it in a controlled maintenance window"
}
if ($existing -and -not $Force) {
    throw "model worker already registered; -Force requires a stopped owned worker"
}

$workerArgs = @(
    "--device", $Device,
    "--model-endpoint", $ModelEndpoint,
    "--model", $Model,
    "--tetherd", $tetherd,
    "--principal-profile", ([IO.Path]::GetFullPath($PrincipalProfile)),
    "--state-dir", $state,
    "--poll-ms", ([string]$PollMs),
    "--max-actions", ([string]$MaxActions),
    "--lease-ttl-ms", ([string]$LeaseTtlMs)
)
foreach ($allowedRoot in $AllowRoots) {
    if (-not $allowedRoot.Trim()) { throw "empty allowed root" }
    $workerArgs += @("--allow", ([IO.Path]::GetFullPath($allowedRoot)))
}
if ($ApiKeyEnv) { $workerArgs += @("--api-key-env", $ApiKeyEnv) }

New-Item -ItemType Directory -Force -Path $configDir,$state | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$json = ConvertTo-Json -InputObject ([string[]]$workerArgs) -Depth 4 -Compress
# Preserve the old configuration until validation is complete and never write
# tokens or API-key values into arguments or process command lines.
if ((ConvertFrom-Json -InputObject $json) -isnot [array]) { throw "model arguments serialization failed" }
[IO.File]::WriteAllText($argsFile, $json, $utf8NoBom)

New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name $runName -Value $runCommand -PropertyType String -Force | Out-Null
if ((Get-ItemProperty -LiteralPath $runKey -Name $runName).$runName -cne $runCommand) {
    throw "native model-worker autorun registration failed"
}

Start-Process -FilePath $nativeLauncher -ArgumentList ('--arguments-file "' + $argsFile + '"') | Out-Null
Write-Output "MODEL_WORKER_PERSISTENCE=HKCU_RUN_NATIVE_GUI"
Write-Output "MODEL_WORKER_INSTALL=WINDOWLESS_START_REQUESTED"
