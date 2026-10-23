param(
    [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
    [ValidateSet('b6', 'startup')][string]$Scenario = 'b6',
    [ValidateSet(1, 2)][int]$Parallelism = 1
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$bridge = Join-Path $PSScriptRoot '../browser/bridge'
$failed = 0
for ($trial = 1; $trial -le 5; $trial++) {
    Write-Output "CDP_DOWNLOAD_TRIAL=$trial"
    $stdout = Join-Path $EvidenceDirectory "trial-$trial.stdout.log"
    $stderr = Join-Path $EvidenceDirectory "trial-$trial.stderr.log"
    $receipt = Join-Path $EvidenceDirectory "cdp-startup-trial-$trial.jsonl"
    $arguments = if ($Scenario -eq 'b6') { @('--test', '--test-reporter=tap', '--test-name-pattern=B6.*CDP.*operational.*path', 'test/operations-integration.test.ts') } else { @('test-support/startup-contention-probe.ts', [string]$Parallelism) }
    $child = Start-Process -FilePath $nodeExe -WindowStyle Hidden -PassThru -WorkingDirectory $bridge -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $exited = $child.WaitForExit(65000)
    if (-not $exited) {
        # Only this new disposable test process tree; never enumerate/kill browsers.
        & taskkill.exe /PID $child.Id /T /F 1>$null 2>$null
    }
    $text = ''
    if ((Get-Item -LiteralPath $stdout).Length -le 262144) { $text = Get-Content -LiteralPath $stdout -Raw }
    # Persist only allowlisted application diagnostics. Raw TAP/stderr stay local.
    $lines = @($text -split '\r?\n' | Where-Object { $_ -match '^(# )?CDP_STARTUP=\{' })
    $lines | ForEach-Object { ($_ -replace '^# ', '').Substring('CDP_STARTUP='.Length) } | Set-Content -LiteralPath $receipt -Encoding utf8
    $lines | Write-Output
    $executed = $text -match '(?m)^# pass 1\b' -and $text -match 'B6_STAGE=cleanup-complete'
    if ($Scenario -eq 'startup') {
        $resultLine = @($text -split '\r?\n' | Where-Object { $_ -match '^CDP_PROBE_RESULT=\{' })
        $executed = $false
        if ($resultLine.Count -eq 1) {
            $result = $resultLine[0].Substring('CDP_PROBE_RESULT='.Length) | ConvertFrom-Json
            $executed = $result.sessions -eq $Parallelism -and $result.passed -eq $true -and @($result.codes).Count -eq $Parallelism
        }
    }
    $passed = $exited -and $child.ExitCode -eq 0 -and $executed
    $summary = @{ trial=$trial; scenario=$Scenario; parallelism=$Parallelism; exited=$exited; exit_code=$child.ExitCode; passed=[bool]$passed; source_sha=$env:GITHUB_SHA; runner_os=$env:RUNNER_OS; runner_arch=$env:RUNNER_ARCH; image_version=$env:ImageVersion; node_version=(& $nodeExe --version) } | ConvertTo-Json -Compress
    Add-Content -LiteralPath $receipt -Value $summary -Encoding utf8
    Write-Output "CDP_TRIAL_RESULT=$summary"
    if (-not $passed) { $failed++ }
}
# All five are separate measurements, never retries: any failure fails the job.
if ($failed -gt 0) { throw "CDP_DOWNLOAD_RELIABILITY_FAILED=$failed`_OF_5" }
Write-Output 'CDP_DOWNLOAD_RELIABILITY=5_OF_5'
