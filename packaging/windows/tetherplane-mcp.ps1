param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tetherd = Join-Path $root "bin\tetherd.exe"
$server = Join-Path $root "adapters\compact-mcp\dist\stdio-server.js"
$config = Join-Path $root "config\install.json"

# Prefer an existing native executable. Some MCP clients strip PATHEXT
# before spawning PowerShell; Get-Command can then fail to resolve "node".
# Inspect only the invoking process PATH without installing or modifying Node.
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
$nodeExecutable = if ($nodeCommand) { [string]$nodeCommand.Source } else { $null }
if (-not $nodeExecutable) {
    foreach ($pathEntry in ($env:PATH -split ";")) {
        $directory = $pathEntry.Trim().Trim('"')
        if (-not [IO.Path]::IsPathRooted($directory)) { continue }
        $candidate = Join-Path $directory "node.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $nodeExecutable = $candidate
            break
        }
    }
}
if (-not $nodeExecutable) {
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

# Connect native child stdio with explicit binary streams. Inheriting console
# handles via Start-Process -NoNewWindow differs between interactive Windows
# sessions and hosted CI; MCP requires three real, persistent pipes.
# UseShellExecute=false and redirection are local to this child only.
# Explicit CRT argv quoting preserves spaces and trailing backslashes.
function Quote-NativeArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }

    $quoted = New-Object System.Text.StringBuilder
    [void]$quoted.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) {
            $slashes += 1
            continue
        }
        if ($character -eq [char]34) {
            [void]$quoted.Append(('\' * (2 * $slashes + 1)))
            [void]$quoted.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) {
            [void]$quoted.Append(('\' * $slashes))
            $slashes = 0
        }
        [void]$quoted.Append($character)
    }
    if ($slashes -gt 0) {
        [void]$quoted.Append(('\' * (2 * $slashes)))
    }
    [void]$quoted.Append('"')
    return $quoted.ToString()
}

$nativeArgs = @($server, "--tetherd", $tetherd) + $forward
$argumentLine = (@($nativeArgs) | ForEach-Object { Quote-NativeArgument ([string]$_) }) -join " "

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodeExecutable
$startInfo.Arguments = $argumentLine
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$nativeProcess = New-Object System.Diagnostics.Process
$nativeProcess.StartInfo = $startInfo
try {
    if (-not $nativeProcess.Start()) {
        throw "failed to start installed Compact MCP server"
    }

    # Copy outgoing MCP bytes on CLR thread-pool tasks. No PowerShell pipeline
    # parsing or text encoding ever touches the JSON-RPC stdio frames.
    $output = [Console]::OpenStandardOutput()
    $errors = [Console]::OpenStandardError()
    $outputTask = $nativeProcess.StandardOutput.BaseStream.CopyToAsync($output)
    $errorsTask = $nativeProcess.StandardError.BaseStream.CopyToAsync($errors)

    # The foreground read exits only on actual MCP client stdin EOF. This
    # preserves a live, bidirectional connection for sequential requests.
    $sourceStream = [Console]::OpenStandardInput()
    $buffer = New-Object byte[] 8192
    try {
        while (($count = $sourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $nativeProcess.StandardInput.BaseStream.Write($buffer, 0, $count)
            $nativeProcess.StandardInput.BaseStream.Flush()
        }
    }
    finally {
        $nativeProcess.StandardInput.Close()
    }

    $nativeProcess.WaitForExit()
    $outputTask.GetAwaiter().GetResult()
    $errorsTask.GetAwaiter().GetResult()
    exit $nativeProcess.ExitCode
}
finally {
    $nativeProcess.Dispose()
}
