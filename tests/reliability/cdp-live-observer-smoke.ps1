param(
    [Parameter(Mandatory=$true)][string]$EvidenceDirectory
)
# CI-only: execute exactly one non-forking, disposable Node fixture and sample
# its own process identity. No user browser, full command line, PID, profile
# path, arbitrary process name or raw exception is ever written to receipts.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../../scripts/cdp-workload-evidence.psm1') -Force

$runId = [guid]::NewGuid().ToString()
$started = [datetime]::UtcNow
$child = $null
$childStarted = $null
$rootVerified = $false
$scopeExclusive = $true
$observerErrors = 0
$metricUnknown = 0
$guardExpired = $false
$exitCode = $null
$cleanupVerified = $false
$terminal = $false
$failureStage = 'none'
$sampleRows = [System.Collections.Generic.List[object]]::new()
$expectedSha = [string]$env:GITHUB_SHA
$sourceSha = ''
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$receiptPath = $null

try {
    # Ownership and finalization begin before creating the evidence directory.
    if ($expectedSha -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'invalid_source_identity'
    }
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    $sourceSha = ((& git -C $repoRoot rev-parse HEAD 2>$null) | Select-Object -First 1).Trim()
    if ($sourceSha -ne $expectedSha) { throw 'source_mismatch' }
    New-Item -ItemType Directory -Force -Path $EvidenceDirectory -ErrorAction Stop | Out-Null
    $receiptPath = Join-Path $EvidenceDirectory ("scoped-observer-" + $runId + ".json")
    if (Test-Path -LiteralPath $receiptPath) { throw 'receipt_collision' }

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $fixture = (Resolve-Path (Join-Path $PSScriptRoot 'fixtures/cdp-owned-idle.cjs')).Path
    $child = Start-Process -FilePath $node -ArgumentList ('"' + $fixture + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    $childStarted = $child.StartTime.ToUniversalTime()

    # Fail closed on first identity observation; no metric is accepted before
    # Get-WorkloadScopedSample checks both PID and exact process creation time.
    while ($sampleRows.Count -lt 12 -and $stopwatch.ElapsedMilliseconds -lt 6500) {
        if ($child.HasExited) { break }
        try {
            $snapshot = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
            $sample = Get-WorkloadScopedSample -Processes $snapshot -RootProcessId $child.Id -RootStartedUtc $childStarted -ElapsedMilliseconds ([int]$stopwatch.ElapsedMilliseconds)
            if (-not $sample.valid) {
                # A valid root may exit between the process-handle check and
                # the CIM snapshot; this is terminal, not an invented zero.
                if ($child.HasExited -and $rootVerified) { break }
                throw 'invalid_process_identity'
            }
            $rootVerified = $true
            if ($sample.process_count -ne 1) {
                $scopeExclusive = $false
                throw 'unexpected_descendant'
            }
            if ($null -eq $sample.cpu_time_ms -or $null -eq $sample.sampled_read_mib -or $null -eq $sample.sampled_write_mib) {
                $metricUnknown++
            }
            $sampleRows.Add($sample)
        } catch {
            $observerErrors++
            # Preserve only fixed diagnostic categories. Never copy observer
            # exception messages or paths into the evidence or CI output.
            if ($_.Exception.Message -eq 'unexpected_descendant') { throw 'observer_scope' }
            if ($_.Exception.Message -eq 'invalid_process_identity') { throw 'observer_identity' }
            throw 'observer_failed'
        }
        Start-Sleep -Milliseconds 300
    }
    if ($sampleRows.Count -lt 2) { throw 'insufficient_observations' }
    # The fixture exits by itself. Never extend Chromium's separate 12s limit.
    if (-not $child.WaitForExit(6000)) {
        $guardExpired = $true
        throw 'fixture_guard_expired'
    }
    $exitCode = $child.ExitCode
    if ($exitCode -ne 0) { throw 'fixture_nonzero_exit' }
} catch {
    if ($failureStage -eq 'none') {
        # Only fixed safe categories may cross into the receipt.
        switch ([string]$_.Exception.Message) {
            'invalid_source_identity' { $failureStage = 'source' }
            'source_mismatch' { $failureStage = 'source' }
            'receipt_collision' { $failureStage = 'receipt' }
            'observer_failed' { $failureStage = 'observer' }
            'observer_scope' { $failureStage = 'observer_scope' }
            'observer_identity' { $failureStage = 'observer_identity' }
            'insufficient_observations' { $failureStage = 'observer' }
            'fixture_guard_expired' { $failureStage = 'guard' }
            'fixture_nonzero_exit' { $failureStage = 'fixture' }
            default { $failureStage = 'setup_or_cleanup' }
        }
    }
} finally {
    # Touch only the process handle created by this test, after validating its
    # start identity against the live CIM record. Never kill by a reused PID.
    if ($null -ne $child) {
        try {
            if (-not $child.HasExited) {
                $currentlyOwned = $false
                if ($null -ne $childStarted) {
                    $match = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + [int]$child.Id) -ErrorAction Stop
                    if ($null -ne $match) {
                        $birth = ([datetime]$match.CreationDate).ToUniversalTime()
                        $currentlyOwned = [math]::Abs(($birth - $childStarted).TotalMilliseconds) -le 1500
                    }
                }
                if ($currentlyOwned) {
                    $child.Kill()
                    [void]$child.WaitForExit(3000)
                } else {
                    $failureStage = 'cleanup_identity_unverified'
                }
            }
            $cleanupVerified = $child.HasExited -and $rootVerified -and $scopeExclusive
            if ($child.HasExited -and $null -eq $exitCode) {
                $exitCode = $child.ExitCode
            }
            $terminal = $child.HasExited
        } catch {
            $cleanupVerified = $false
            $failureStage = 'cleanup_unverified'
        } finally {
            $child.Dispose()
        }
    }
    $ended = [datetime]::UtcNow
    $receipt = [ordered]@{
        schema = 1
        run_id = $runId
        source_sha = $sourceSha
        workload = 'single_owned_nonforking_fixture'
        started_utc = $started.ToString('o')
        ended_utc = $ended.ToString('o')
        process_started = $null -ne $childStarted
        root_identity_verified = [bool]$rootVerified
        only_owned_fixture_process = [bool]$scopeExclusive
        samples = $sampleRows.Count
        observer_errors = $observerErrors
        unknown_metric_samples = $metricUnknown
        guard_expired = [bool]$guardExpired
        test_exit_code = $exitCode
        owned_cleanup_verified = [bool]$cleanupVerified
        terminal = [bool]$terminal
        failure_stage = $failureStage
        sample_data = @($sampleRows.ToArray())
    }
    if ($null -ne $receiptPath) {
        try {
            $json = ConvertTo-Json -InputObject $receipt -Depth 8 -Compress
            Set-Content -LiteralPath $receiptPath -Value $json -Encoding utf8 -NoNewline -ErrorAction Stop
            $parsed = Get-Content -LiteralPath $receiptPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $accepted = Test-WorkloadOutcome -Receipt $parsed -ExpectedRunId $runId -ExpectedSourceSha $expectedSha
            if (-not $accepted) {
                Write-Output ('CDP_LIVE_SCOPE_VERIFIED=FAIL;STAGE=' + $receipt.failure_stage + ';SAMPLES=' + $receipt.samples + ';ROOT_VERIFIED=' + $receipt.root_identity_verified + ';SCOPE_SINGLE=' + $receipt.only_owned_fixture_process)
                exit 1
            }
            Write-Output ('CDP_LIVE_SCOPE_VERIFIED=PASS;SAMPLES=' + $sampleRows.Count)
        } catch {
            Write-Output 'CDP_LIVE_SCOPE_VERIFIED=FAIL'
            exit 1
        }
    } else {
        Write-Output 'CDP_LIVE_SCOPE_VERIFIED=FAIL'
        exit 1
    }
}
