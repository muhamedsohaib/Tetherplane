param(
    [Parameter(Mandatory = $true)]
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Destructive actions are limited to synthetic data under a new disposable
# GitHub-hosted Windows runner scratch path. Never run on an owner workstation.
$report = [ordered]@{
    schema = 'tetherplane.windows.clean_install_boundary.v1'
    source_commit = $env:GITHUB_SHA
    branch = $env:GITHUB_HEAD_REF
    runner = $env:RUNNER_ENVIRONMENT
    test_package = 'synthetic and credential-free; not a production client'
    launcher_parse = 'NOT_RUN'
    launcher_param_block = 'NOT_RUN'
    fresh_install_layout = 'NOT_RUN'
    invalid_scheduled_args_rejected = 'NOT_RUN'
    force_preserves_previous_install = 'NOT_RUN'
    no_scheduled_task_registered = 'NOT_RUN'
    isolated_scratch_cleanup = 'NOT_RUN'
    failed_boundary = $null
    disposition = 'NO-GO'
}

$scratch = $null
$failed = $null

try {
    if ($env:GITHUB_ACTIONS -cne 'true' -or
        $env:GITHUB_EVENT_NAME -cne 'pull_request' -or
        $env:RUNNER_OS -cne 'Windows' -or
        $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        [string]::IsNullOrWhiteSpace($env:GITHUB_HEAD_REF) -or
        -not $env:GITHUB_HEAD_REF.StartsWith('test/windows-clean-install-boundary-')) {
        throw 'This test runs only in a disposable GitHub-hosted Windows PR runner.'
    }

    if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
        [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID) -or
        [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT)) {
        throw 'Required ephemeral runner identity is missing.'
    }
    $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
    if (-not (Test-Path -LiteralPath $runnerTemp -PathType Container)) {
        throw 'Runner temporary directory is unavailable.'
    }
    $expectedReport = Join-Path $runnerTemp 'tetherplane-clean-install-boundary-report.json'
    if ([IO.Path]::GetFullPath($ReportPath) -cne [IO.Path]::GetFullPath($expectedReport)) {
        throw 'Evidence report must be confined to the runner temporary directory.'
    }

    if ($null -ne (Get-ScheduledTask -TaskName 'Tetherplane Agent' -ErrorAction SilentlyContinue)) {
        throw 'Pre-existing Tetherplane Agent task detected: refuse test.'
    }

    $repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
    $installer = Join-Path $repo 'scripts\install-windows.ps1'
    $launcher = Join-Path $repo 'packaging\windows\tetherplane-mcp.ps1'
    foreach ($file in @($installer, $launcher)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Expected source file is unavailable: $file"
        }
    }

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile(
        $launcher, [ref]$tokens, [ref]$parseErrors
    )
    $report.launcher_parse = if (@($parseErrors).Count -eq 0) { 'PASS' } else { 'FAIL' }
    $report.launcher_param_block = if ($null -ne $ast.ParamBlock) { 'PASS' } else { 'FAIL' }

    $scratch = Join-Path $runnerTemp (
        'tetherplane-clean-install-boundary-' +
        $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT
    )
    if (Test-Path -LiteralPath $scratch) { throw 'Scratch directory already exists.' }
    [void](New-Item -ItemType Directory -Path $scratch -ErrorAction Stop)

    $package = Join-Path $scratch 'synthetic-package'
    foreach ($relative in @(
        'bin',
        'adapters\compact-mcp\dist',
        'protocol\schemas',
        'launch'
    )) {
        [void](New-Item -ItemType Directory -Path (Join-Path $package $relative) -Force)
    }
    [IO.File]::WriteAllText((Join-Path $package 'bin\tetherd.exe'), 'SYNTHETIC_NOT_EXECUTABLE')
    [IO.File]::WriteAllText((Join-Path $package 'adapters\compact-mcp\dist\stdio-server.js'), 'SYNTHETIC')
    [IO.File]::WriteAllText((Join-Path $package 'protocol\schemas\result.schema.json'), '{}')
    [IO.File]::WriteAllText((Join-Path $package 'launch\tetherplane-mcp.ps1'), 'SYNTHETIC')
    [IO.File]::WriteAllText((Join-Path $package 'manifest.json'), '{"test_only":true}')

    # Only installer layout and receipt mechanics, NEVER actual agent launch.
    $freshInstall = Join-Path $scratch 'fresh-install'
    $freshState = Join-Path $scratch 'fresh-state'
    $freshReturned = $false
    try {
        & $installer -PackagePath $package -InstallPrefix $freshInstall -StateDir $freshState | Out-Null
        $freshReturned = $true
    } catch {
        $report.failed_boundary = "fresh synthetic install: $($_.Exception.Message)"
    }
    $receipt = Join-Path $freshInstall 'config\install.json'
    if ($freshReturned -and
        (Test-Path -LiteralPath $receipt -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $freshInstall 'bin\tetherd.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $freshInstall 'adapters\compact-mcp\dist\stdio-server.js') -PathType Leaf)) {
        $record = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
        if (-not $record.scheduled_task -and
            [IO.Path]::GetFullPath([string]$record.state_dir) -ceq [IO.Path]::GetFullPath($freshState)) {
            $report.fresh_install_layout = 'PASS'
        } else {
            $report.fresh_install_layout = 'FAIL'
        }
    } else {
        $report.fresh_install_layout = 'FAIL'
    }

    # Existing sentinel is deliberately created in temporary test scratch.
    # In vulnerable code -Force deletes it BEFORE invalid args are rejected.
    $previousInstall = Join-Path $scratch 'existing-install'
    [void](New-Item -ItemType Directory -Path $previousInstall -ErrorAction Stop)
    $sentinel = Join-Path $previousInstall 'KEEP_EXISTING_INSTALL.txt'
    [IO.File]::WriteAllText($sentinel, 'MUST_SURVIVE_INVALID_PRECONDITION')
    $invalidArgs = Join-Path $scratch 'invalid-scheduled-args.json'
    [IO.File]::WriteAllText($invalidArgs, '{ not valid JSON !!!')

    $rejected = $false
    try {
        & $installer -PackagePath $package -InstallPrefix $previousInstall -StateDir (Join-Path $scratch 'existing-state') -Force -InstallScheduledTask -AgentArgumentsFile $invalidArgs | Out-Null
    } catch {
        $rejected = $true
    }
    $report.invalid_scheduled_args_rejected = if ($rejected) { 'PASS' } else { 'FAIL' }
    $report.force_preserves_previous_install = if (
        (Test-Path -LiteralPath $sentinel -PathType Leaf) -and
        ([IO.File]::ReadAllText($sentinel) -ceq 'MUST_SURVIVE_INVALID_PRECONDITION')
    ) { 'PASS' } else { 'FAIL' }

    $report.no_scheduled_task_registered = if (
        $null -eq (Get-ScheduledTask -TaskName 'Tetherplane Agent' -ErrorAction SilentlyContinue)
    ) { 'PASS' } else { 'FAIL' }
} catch {
    $failed = $_.Exception.Message
    $report.failed_boundary = $failed
} finally {
    if ($null -ne $scratch) {
        try {
            $tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
            $target = [IO.Path]::GetFullPath($scratch)
            $prefix = $tempRoot.TrimEnd('\') + '\tetherplane-clean-install-boundary-'
            if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Refusing to clean up an unexpected path.'
            }
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
            }
            $report.isolated_scratch_cleanup = 'PASS'
        } catch {
            $report.isolated_scratch_cleanup = 'FAIL'
            $report.failed_boundary = "Scratch cleanup: $($_.Exception.Message)"
        }
    }

    $keys = @(
        'launcher_parse', 'launcher_param_block', 'fresh_install_layout',
        'invalid_scheduled_args_rejected', 'force_preserves_previous_install',
        'no_scheduled_task_registered', 'isolated_scratch_cleanup'
    )
    $allPass = $true
    foreach ($key in $keys) {
        if ($report[$key] -cne 'PASS') { $allPass = $false }
    }
    if ($null -ne $failed) { $allPass = $false }
    $report.disposition = if ($allPass) {
        'BOUNDARIES_PASS; REAL_CLIENT_ONBOARDING_NOT_TESTED'
    } else {
        'NO-GO; REAL_CLIENT_ONBOARDING_NOT_TESTED'
    }

    if ($env:RUNNER_TEMP -and (Test-Path -LiteralPath $env:RUNNER_TEMP)) {
        $dest = Join-Path $env:RUNNER_TEMP 'tetherplane-clean-install-boundary-report.json'
        [IO.File]::WriteAllText(
            $dest, ($report | ConvertTo-Json -Depth 5),
            [System.Text.UTF8Encoding]::new($false)
        )
    }
}

if ($report.disposition -cne 'BOUNDARIES_PASS; REAL_CLIENT_ONBOARDING_NOT_TESTED') {
    Write-Error 'TETHERPLANE_CLEAN_INSTALL_BOUNDARY_NO_GO: review the data-only report'
    exit 1
}
Write-Output 'TETHERPLANE_CLEAN_INSTALL_BOUNDARY_PASS; REAL_CLIENT_ONBOARDING_NOT_TESTED'
