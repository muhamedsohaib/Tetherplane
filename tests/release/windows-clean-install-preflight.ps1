param(
    [Parameter(Mandatory = $true)]
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# GitHub-hosted Windows CI only. No production Tetherplane identities,
# scheduled tasks, OAuth endpoints, credentials, or agent processes are touched.
$report = [ordered]@{
    schema = 'tetherplane.windows.clean_install_preflight.v1'
    source_commit = $env:GITHUB_SHA
    runner_environment = $env:RUNNER_ENVIRONMENT
    synthetic_fixture_only = $true
    installed_real_agent = $false
    production_agent_touched = $false
    invalid_args_preserve_prior_install = 'NOT_RUN'
    force_replacement_denied = 'NOT_RUN'
    overlapping_paths_denied = 'NOT_RUN'
    malformed_args_leave_no_partial_install = 'NOT_RUN'
    clean_isolated_install = 'NOT_RUN'
    repeated_install_denied = 'NOT_RUN'
    launcher_param_block = 'NOT_RUN'
    no_scheduled_task_registered = 'NOT_RUN'
    cleanup = 'NOT_RUN'
    error = $null
    disposition = 'NO-GO'
}

$failed = $null
$scratch = $null

# Use the platform .NET implementation to avoid accidental PowerShell
# module-path collisions between Windows PowerShell 5.1 and pwsh.
function Get-LocalSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}
$reportFull = [IO.Path]::GetFullPath($ReportPath)
try {
    if ($env:GITHUB_ACTIONS -cne 'true' -or
        $env:GITHUB_EVENT_NAME -cne 'pull_request' -or
        $env:RUNNER_OS -cne 'Windows' -or
        $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
        throw 'This source-only installer preflight runs only on a disposable GitHub-hosted Windows pull-request runner'
    }

    $tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
    if (-not (Test-Path -LiteralPath $tempRoot -PathType Container) -or
        -not $reportFull.StartsWith(($tempRoot.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Report path must be inside the GitHub runner temporary directory'
    }
    $repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
    $installer = Join-Path $repo 'scripts\install-windows.ps1'
    $launcher = Join-Path $repo 'packaging\windows\tetherplane-mcp.ps1'
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count -gt 0 -or $null -eq $ast.ParamBlock) {
        throw 'Compact MCP launcher does not start with a real PowerShell parameter block'
    }
    $report.launcher_param_block = 'PASS'

    if (Get-ScheduledTask -TaskName 'Tetherplane Agent' -ErrorAction SilentlyContinue) {
        throw 'Disposable CI runner unexpectedly contains a production Tetherplane Agent task'
    }

    $scratch = Join-Path $tempRoot ('tetherplane-cold-preflight-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $scratch) { throw 'Refusing existing test scratch directory' }
    $pkg = Join-Path $scratch 'synthetic-package'
    $prior = Join-Path $scratch 'prior-install'
    $state = Join-Path $scratch 'prior-state'
    $fresh = Join-Path $scratch 'fresh-install'
    $freshState = Join-Path $scratch 'fresh-state'

    foreach ($sub in @('bin','adapters\compact-mcp\dist','protocol\schemas','launch')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $pkg $sub) | Out-Null
    }
    New-Item -ItemType Directory -Force -Path $prior | Out-Null
    $utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $pkg 'bin\tetherd.exe'), 'synthetic CI fixture, not executable', $utf8)
    [IO.File]::WriteAllText((Join-Path $pkg 'adapters\compact-mcp\dist\stdio-server.js'), '// synthetic CI fixture', $utf8)
    [IO.File]::WriteAllText((Join-Path $pkg 'protocol\schemas\result.schema.json'), '{}', $utf8)
    [IO.File]::WriteAllText((Join-Path $pkg 'manifest.json'), '{"version":"synthetic-ci-only"}', $utf8)
    Copy-Item -LiteralPath $launcher -Destination (Join-Path $pkg 'launch\tetherplane-mcp.ps1')

    $sentinel = Join-Path $prior 'sentinel-preserve.txt'
    [IO.File]::WriteAllText($sentinel, 'preserve exact bytes', $utf8)
    $sentinelSha = Get-LocalSha256 -Path $sentinel

    function Assert-Fails {
        param([scriptblock]$Action, [string]$ExpectedMessage)
        $rejected = $false
        try { & $Action | Out-Null }
        catch {
            if ($_.Exception.Message -notlike ('*' + $ExpectedMessage + '*')) { throw }
            $rejected = $true
        }
        if (-not $rejected) { throw ('Expected rejection not observed: ' + $ExpectedMessage) }
    }
    function Assert-Sentinel {
        if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) { throw 'Prior install sentinel vanished' }
        if ((Get-LocalSha256 -Path $sentinel) -cne $sentinelSha) {
            throw 'Prior installation sentinel changed'
        }
    }

    $badArgs = Join-Path $scratch 'invalid-agent-args.json'
    [IO.File]::WriteAllText($badArgs, '{not valid JSON', $utf8)
    Assert-Fails { & $installer -PackagePath $pkg -InstallPrefix $prior -StateDir $state -Force -InstallScheduledTask -AgentArgumentsFile $badArgs } 'must contain valid JSON'
    Assert-Sentinel
    if (Test-Path -LiteralPath $state) { throw 'Invalid input created durable state' }
    $report.invalid_args_preserve_prior_install = 'PASS'

    Assert-Fails { & $installer -PackagePath $pkg -InstallPrefix $prior -StateDir $state -Force } 'refusing to replace a populated install prefix'
    Assert-Sentinel
    $report.force_replacement_denied = 'PASS'

    $overlap = Join-Path $scratch 'overlap'
    Assert-Fails { & $installer -PackagePath $pkg -InstallPrefix $overlap -StateDir $overlap } 'must not overlap'
    if (Test-Path -LiteralPath $overlap) { throw 'Overlapping path created unexpectedly' }
    $report.overlapping_paths_denied = 'PASS'

    Assert-Fails { & $installer -PackagePath $pkg -InstallPrefix $fresh -StateDir $freshState -InstallScheduledTask -AgentArgumentsFile $badArgs } 'must contain valid JSON'
    if ((Test-Path -LiteralPath $fresh) -or (Test-Path -LiteralPath $freshState)) {
        throw 'Invalid agent args left a partial installation'
    }
    $report.malformed_args_leave_no_partial_install = 'PASS'

    & $installer -PackagePath $pkg -InstallPrefix $fresh -StateDir $freshState | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $fresh 'bin\tetherd.exe') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $fresh 'adapters\compact-mcp\dist\stdio-server.js') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $fresh 'config\install.json') -PathType Leaf)) {
        throw 'Clean isolated file install is incomplete'
    }
    $receipt = Get-Content -LiteralPath (Join-Path $fresh 'config\install.json') -Raw | ConvertFrom-Json
    if (-not $receipt.state_created_by_installer -or $null -ne $receipt.scheduled_task) {
        throw 'Clean isolated install receipt is inconsistent'
    }
    $report.clean_isolated_install = 'PASS'

    Assert-Fails { & $installer -PackagePath $pkg -InstallPrefix $fresh -StateDir $freshState } 'refusing to replace a populated install prefix'
    $report.repeated_install_denied = 'PASS'

    if (Get-ScheduledTask -TaskName 'Tetherplane Agent' -ErrorAction SilentlyContinue) {
        throw 'Clean file install unexpectedly registered a global scheduled task'
    }
    $report.no_scheduled_task_registered = 'PASS'
    $report.disposition = 'SYNTHETIC_COLD_INSTALL_PREFLIGHT_PASS; OAUTH/SIGNING/REAL_AGENT NOT TESTED'
}
catch {
    $failed = $_.Exception.Message
    $report.error = $failed
}
finally {
    if ($null -ne $scratch -and (Test-Path -LiteralPath $scratch)) {
        $prefix = $tempRoot.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
        if (-not $scratch.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([IO.Path]::GetFileName($scratch)).StartsWith('tetherplane-cold-preflight-')) {
            $report.cleanup = 'FAILED_PATH_GUARD'
        } else {
            try {
                Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction Stop
                $report.cleanup = 'PASS'
            } catch {
                $report.cleanup = 'FAILED'
                $report.error = $report.error + '; cleanup: ' + $_.Exception.Message
            }
        }
    } else {
        $report.cleanup = 'NOT_CREATED'
    }
    [IO.File]::WriteAllText($reportFull, ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}

if ($null -ne $failed -or $report.cleanup -notin @('PASS','NOT_CREATED')) {
    throw ('WINDOWS_CLEAN_INSTALL_NO_GO: ' + $report.error)
}
Write-Output 'WINDOWS_SYNTHETIC_COLD_INSTALL_PREFLIGHT_PASS; NO PUBLIC RELEASE'
