$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tetherd = Join-Path $root "bin\tetherd.exe"
$argsPath = Join-Path $root "config\agent-args.json"

# One supervisor per install: a second copy exits instead of starting a
# duplicate agent that would fight the first for the same device identity.
$instanceKey = ([BitConverter]::ToString(
    [Security.Cryptography.SHA256]::Create().ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())
    )
) -replace "-", "").Substring(0, 16)
$instanceMutex = New-Object System.Threading.Mutex($false, "Local\TetherplaneAgent-$instanceKey")
$ownsInstance = $false
try {
    $ownsInstance = $instanceMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $ownsInstance = $true
}
if (-not $ownsInstance) {
    Write-Output "another Tetherplane agent supervisor already owns this install; exiting without starting a second agent"
    exit 0
}

if (-not (Test-Path -LiteralPath $tetherd -PathType Leaf)) {
    throw "installed tetherd is missing: $tetherd"
}
if (-not (Test-Path -LiteralPath $argsPath -PathType Leaf)) {
    throw "background agent arguments are not configured: $argsPath"
}

$arguments = @(Get-Content -LiteralPath $argsPath -Raw | ConvertFrom-Json)
if ($arguments.Count -eq 0) {
    throw "background agent arguments are empty"
}

$minimumDelaySeconds = 2
$maximumDelaySeconds = 60
$restartDelaySeconds = $minimumDelaySeconds

while ($true) {
    $startedAt = Get-Date

    & $tetherd @arguments

    $runtimeSeconds = ((Get-Date) - $startedAt).TotalSeconds

    Start-Sleep -Seconds $restartDelaySeconds

    if ($runtimeSeconds -ge 60) {
        $restartDelaySeconds = $minimumDelaySeconds
    }
    else {
        $restartDelaySeconds = [Math]::Min(
            $restartDelaySeconds * 2,
            $maximumDelaySeconds
        )
    }
}
