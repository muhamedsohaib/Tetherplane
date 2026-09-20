$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tetherd = Join-Path $root "bin\tetherd.exe"
$argsPath = Join-Path $root "config\agent-args.json"

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
& $tetherd @arguments
exit $LASTEXITCODE
