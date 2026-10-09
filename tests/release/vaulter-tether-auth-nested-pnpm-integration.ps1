# Integration regression: simulate a competing globally installed pnpm 11 while
# executing the real relay pretest. Only the test process PATH is modified.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$stagePath = Join-Path $repo 'scripts\vaulter-tether-auth-stage.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $stagePath, [ref]$tokens, [ref]$errors
)
if (@($errors).Count -ne 0) {
    throw 'Cannot load Vaulter staging helper: PowerShell syntax errors.'
}
$shimAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'New-PnpmCorepackShim'
}, $true)
if ($null -eq $shimAst) { throw 'Missing nested pnpm Corepack helper.' }
Invoke-Expression $shimAst.Extent.Text

$corepack = Get-Command corepack.cmd -ErrorAction Stop
$version = ( & $corepack.Source pnpm --version )
if ($LASTEXITCODE -ne 0 -or (([string]$version).Trim() -ne '10.34.5')) {
    throw 'Corepack failed to resolve repository-pinned pnpm 10.34.5.'
}

$oldPath = $env:PATH
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('tp-nested-pnpm-ci-' + [Guid]::NewGuid().ToString('N'))
$shimDirectory = $null
New-Item -ItemType Directory -Path $fixture -ErrorAction Stop | Out-Null

try {
    # A fake global executable represents Vaulter's pnpm 11.17.0 installation.
    $fakeGlobal = Join-Path $fixture 'pnpm.cmd'
    [IO.File]::WriteAllText(
        $fakeGlobal,
        ('@echo off' + [Environment]::NewLine + 'echo 11.17.0' + [Environment]::NewLine)
    )
    $env:PATH = "$fixture;$oldPath"
    $wrong = @(& cmd.exe /d /c pnpm --version)
    if ((($wrong -join ' ').Trim()) -ne '11.17.0') {
        throw 'Fixture did not expose the competing package manager.'
    }

    $shimDirectory = New-PnpmCorepackShim -CorepackPath $corepack.Source
    $env:PATH = "$shimDirectory;$fixture;$oldPath"
    $resolved = @(& cmd.exe /d /c pnpm --version)
    if ($LASTEXITCODE -ne 0 -or (($resolved -join ' ').Trim()) -ne '10.34.5') {
        throw 'Nested pnpm did not resolve to project-pinned version.'
    }

    Push-Location $repo
    try {
        $commands = @(
            @('install', '--frozen-lockfile'),
            @('--filter', '@tetherplane/protocol', 'build'),
            @('--filter', '@tetherplane/auth', 'build'),
            @('--filter', '@tetherplane/relay', 'test')
        )
        foreach ($argsList in $commands) {
            & $corepack.Source pnpm @argsList
            if ($LASTEXITCODE -ne 0) {
                throw 'Real pnpm workspace/relay integration command failed.'
            }
        }
    } finally {
        Pop-Location
    }
    Write-Output 'Real Windows nested-pnpm relay pretest passed with competing pnpm 11.'
} finally {
    $env:PATH = $oldPath
    if ($shimDirectory -and (Test-Path -LiteralPath $shimDirectory)) {
        Remove-Item -LiteralPath $shimDirectory -Recurse -Force
    }
    if (Test-Path -LiteralPath $fixture) {
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
