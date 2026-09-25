param(
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [Parameter(Mandatory = $true)]
    [string]$Device,
    [Parameter(Mandatory = $true)]
    [string]$ModelEndpoint,
    [Parameter(Mandatory = $true)]
    [string]$Model,
    [Parameter(Mandatory = $true)]
    [string]$PrincipalProfile,
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
$workerMain = Join-Path $install "adapters\model-client\dist\worker-main.js"
$tetherd = Join-Path $install "bin\tetherd.exe"
$configDir = Join-Path $install "config"
$argsFile = Join-Path $configDir "model-worker-args.json"
$supervisor = Join-Path $configDir "model-worker-supervisor.ps1"
$stdout = Join-Path $configDir "model-worker.stdout.log"
$stderr = Join-Path $configDir "model-worker.stderr.log"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "TetherplaneModelWorker"

foreach ($required in @($workerMain, $tetherd, $PrincipalProfile)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "model worker required file is missing: $required"
    }
}

$node = (Get-Command node.exe -ErrorAction Stop).Source

if (-not $Device.Trim()) { throw "-Device must not be empty" }
if (-not $Model.Trim()) { throw "-Model must not be empty" }

$endpoint = $null
if (-not [Uri]::TryCreate($ModelEndpoint, [UriKind]::Absolute, [ref]$endpoint)) {
    throw "-ModelEndpoint must be an absolute URL"
}
if ($endpoint.Scheme -notin @("http", "https")) {
    throw "-ModelEndpoint must use http or https"
}
if ($endpoint.UserInfo) {
    throw "-ModelEndpoint must not contain credentials"
}

if ($PollMs -lt 100 -or $PollMs -gt 300000) {
    throw "-PollMs must be between 100 and 300000"
}
if ($MaxActions -lt 1 -or $MaxActions -gt 1000) {
    throw "-MaxActions must be between 1 and 1000"
}
if ($LeaseTtlMs -lt 1 -or $LeaseTtlMs -gt 3600000) {
    throw "-LeaseTtlMs must be between 1 and 3600000"
}

if ($ApiKeyEnv) {
    if ($ApiKeyEnv -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
        throw "-ApiKeyEnv must be a valid environment variable name"
    }
    $apiKeyPresent =
        [Environment]::GetEnvironmentVariable($ApiKeyEnv, "Process") -or
        [Environment]::GetEnvironmentVariable($ApiKeyEnv, "User") -or
        [Environment]::GetEnvironmentVariable($ApiKeyEnv, "Machine")
    if (-not $apiKeyPresent) {
        throw "configured model credential environment variable is not set"
    }
}

New-Item -ItemType Directory -Force -Path $configDir,$state | Out-Null

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

foreach ($root in $AllowRoots) {
    if (-not $root.Trim()) {
        throw "-AllowRoots cannot contain empty values"
    }
    $workerArgs += @("--allow", ([IO.Path]::GetFullPath($root)))
}

if ($ApiKeyEnv) {
    $workerArgs += @("--api-key-env", $ApiKeyEnv)
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($argsFile, ($workerArgs | ConvertTo-Json -Depth 4), $utf8NoBom)

$supervisorLines = @(
    '$ErrorActionPreference = "Continue"'
    'Set-StrictMode -Version Latest'
    ''
    '$node = "__NODE__"'
    '$worker = "__WORKER__"'
    '$argsFile = "__ARGS__"'
    '$stdout = "__STDOUT__"'
    '$stderr = "__STDERR__"'
    ''
    'while ($true) {'
    '    try {'
    '        $workerArgs = @(Get-Content -LiteralPath $argsFile -Raw | ConvertFrom-Json)'
    '        & $node $worker @workerArgs 1>> $stdout 2>> $stderr'
    '    }'
    '    catch {'
    '        ("model worker supervisor error: " + $_.Exception.Message) | Add-Content -LiteralPath $stderr'
    '    }'
    '    Start-Sleep -Seconds 2'
    '}'
)

$supervisorSource = $supervisorLines -join [Environment]::NewLine
$supervisorSource = $supervisorSource.Replace("__NODE__", $node)
$supervisorSource = $supervisorSource.Replace("__WORKER__", $workerMain)
$supervisorSource = $supervisorSource.Replace("__ARGS__", $argsFile)
$supervisorSource = $supervisorSource.Replace("__STDOUT__", $stdout)
$supervisorSource = $supervisorSource.Replace("__STDERR__", $stderr)
[IO.File]::WriteAllText($supervisor, $supervisorSource, $utf8NoBom)

function Get-WorkerProcesses {
    @(
        Get-CimInstance Win32_Process |
        Where-Object {
            $name = [string]$_.Name
            $commandLine = [string]$_.CommandLine
            (
                ($name -in @("powershell.exe", "pwsh.exe")) -and
                ($commandLine.IndexOf($supervisor, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
            ) -or (
                ($name -eq "node.exe") -and
                ($commandLine.IndexOf($workerMain, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
            )
        }
    )
}

$existingRunValue = $null
if (Test-Path -LiteralPath $runKey) {
    $property = Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue
    if ($property) {
        $existingRunValue = $property.$runValueName
    }
}
$existingProcesses = @(Get-WorkerProcesses)

if (($existingRunValue -or $existingProcesses.Count -gt 0) -and -not $Force) {
    throw "model worker is already installed; use -Force to replace it"
}

if ($Force) {
    foreach ($process in $existingProcesses) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$actionArgument =
    '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    $supervisor +
    '"'
$runCommand = "powershell.exe " + $actionArgument

New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name $runValueName -Value $runCommand -PropertyType String -Force | Out-Null

$persisted = (Get-ItemProperty -Path $runKey -Name $runValueName).$runValueName
if ($persisted -ne $runCommand) {
    throw "model worker HKCU Run persistence verification failed"
}

Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue
Start-Process -FilePath "powershell.exe" -ArgumentList $actionArgument -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 3

$running = @(Get-WorkerProcesses)
$supervisorCount =
    @(
        $running |
        Where-Object {
            [string]$_.Name -in @("powershell.exe", "pwsh.exe")
        }
    ).Count

if ($supervisorCount -ne 1) {
    throw "expected exactly one Tetherplane model worker supervisor"
}

Write-Output "MODEL_WORKER_PERSISTENCE=HKCU_RUN"
Write-Output "MODEL_WORKER_INSTALL=PASS"
