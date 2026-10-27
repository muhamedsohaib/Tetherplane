# Read-only syntax preflight for all MSIX G2 Windows PowerShell scripts.
# Use Windows PowerShell 5.1 to match the exact hosted subprocess parser.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$files = @(
    'scripts\msix-store\Test-PackagedAppActivation.ps1',
    'scripts\msix-store\Test-TetherplaneStoreRuntime.ps1'
)
foreach ($relative in $files) {
    $path = Join-Path $root $relative
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(
        $path, [ref]$tokens, [ref]$parseErrors
    )
    if (@($parseErrors).Count -ne 0) {
        $first = $parseErrors[0]
        throw ('MSIX_PS51_PARSE_FAIL ' + $relative + ' line=' +
            [string]$first.Extent.StartLineNumber + ': ' + $first.Message)
    }
}
Write-Output 'MSIX_PS51_SYNTAX_PASS'
