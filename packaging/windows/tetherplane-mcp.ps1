$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tetherd = Join-Path $root "bin\tetherd.exe"
$server = Join-Path $root "adapters\compact-mcp\dist\stdio-server.js"
$config = Join-Path $root "config\install.json"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required to run the Compact MCP edge"
}
if (-not (Test-Path -LiteralPath $tetherd -PathType Leaf)) {
    throw "installed tetherd is missing: $tetherd"
}
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
    throw "installed Compact MCP server is missing: $server"
}

$forward = @()
if ((Test-Path -LiteralPath $config -PathType Leaf) -and ($RemainingArgs -notcontains "--state-dir")) {
    $install = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    if ($install.state_dir) {
        $forward += @("--state-dir", [string]$install.state_dir)
    }
}
$forward += $RemainingArgs

& node $server --tetherd $tetherd @forward
exit $LASTEXITCODE
