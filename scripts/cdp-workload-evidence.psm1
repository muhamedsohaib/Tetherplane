# CI-only, read-only observer for a disposable process tree.
# Never emits command lines, executable paths, process IDs or raw exceptions.
Set-StrictMode -Version Latest

function Get-WorkloadScopedSample {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][object[]]$Processes,
        [Parameter(Mandatory=$true)][int]$RootProcessId,
        [Parameter(Mandatory=$true)][datetime]$RootStartedUtc,
        [Parameter(Mandatory=$true)][int]$ElapsedMilliseconds
    )
    $missing = [pscustomobject]@{
        valid=$false; elapsed_ms=$ElapsedMilliseconds; process_count=$null;
        working_set_mib=$null; cpu_time_ms=$null; sampled_read_mib=$null;
        sampled_write_mib=$null
    }
    if ($RootProcessId -le 0 -or $Processes.Count -gt 2048) { return $missing }
    $byPid = @{}
    foreach ($process in $Processes) {
        try {
            $id = [int]$process.ProcessId
            if ($id -le 0 -or $byPid.ContainsKey([string]$id)) { return $missing }
            $byPid[[string]$id] = $process
        } catch { return $missing }
    }
    $rootKey = [string]$RootProcessId
    if (-not $byPid.ContainsKey($rootKey)) { return $missing }
    try {
        $rootBorn = ([datetime]$byPid[$rootKey].CreationDate).ToUniversalTime()
        if ([math]::Abs(($rootBorn - $RootStartedUtc.ToUniversalTime()).TotalMilliseconds) -gt 1500) {
            return $missing
        }
    } catch { return $missing }

    # Accept descendants only through a live and creation-time-validated parent.
    # PID alone never confers membership. Missing parent metadata is unknown, not zero.
    $owned = @{}
    $owned[$rootKey] = $rootBorn
    for ($pass=0; $pass -lt 16; $pass++) {
        $added = 0
        foreach ($process in $Processes) {
            try {
                $key = [string][int]$process.ProcessId
                if ($owned.ContainsKey($key)) { continue }
                $parentKey = [string][int]$process.ParentProcessId
                if (-not $owned.ContainsKey($parentKey) -or -not $byPid.ContainsKey($parentKey)) { continue }
                $parentBorn = ([datetime]$byPid[$parentKey].CreationDate).ToUniversalTime()
                if ($parentBorn -ne $owned[$parentKey]) { continue }
                $born = ([datetime]$process.CreationDate).ToUniversalTime()
                if ($born -lt $parentBorn) { continue }
                $owned[$key] = $born
                $added++
            } catch { return $missing }
        }
        if ($added -eq 0) { break }
        if ($pass -eq 15 -or $owned.Count -gt 128) { return $missing }
    }

    $working = 0.0
    $cpu = 0.0
    $read = 0.0
    $write = 0.0
    $workingKnown = $true
    $cpuKnown = $true
    $ioKnown = $true
    # WMI/CIM observation can throw while retrieving counters. Treat every
    # observer error as unknown instead of printing the exception or succeeding.
    try {
        foreach ($key in $owned.Keys) {
            $p = $byPid[$key]
            if ($null -eq $p.WorkingSetSize) { $workingKnown = $false }
            else { $working += [double]$p.WorkingSetSize }
            if ($null -eq $p.KernelModeTime -or $null -eq $p.UserModeTime) { $cpuKnown = $false }
            else { $cpu += [double]$p.KernelModeTime + [double]$p.UserModeTime }
            if ($null -eq $p.ReadTransferCount -or $null -eq $p.WriteTransferCount) { $ioKnown = $false }
            else {
                $read += [double]$p.ReadTransferCount
                $write += [double]$p.WriteTransferCount
            }
        }
    } catch { return $missing }
    return [pscustomobject]@{
        valid=$true; elapsed_ms=$ElapsedMilliseconds; process_count=$owned.Count;
        working_set_mib=$(if($workingKnown){[math]::Round($working / 1MB, 2)}else{$null});
        cpu_time_ms=$(if($cpuKnown){[math]::Round($cpu / 10000, 1)}else{$null});
        sampled_read_mib=$(if($ioKnown){[math]::Round($read / 1MB, 2)}else{$null});
        sampled_write_mib=$(if($ioKnown){[math]::Round($write / 1MB, 2)}else{$null})
    }
}

function Test-WorkloadOutcome {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][object]$Receipt,
        [Parameter(Mandatory=$true)][string]$ExpectedRunId,
        [Parameter(Mandatory=$true)][string]$ExpectedSourceSha
    )
    try {
        $parsedGuid = [guid]::Empty
        if (-not [guid]::TryParse([string]$Receipt.run_id, [ref]$parsedGuid)) { return $false }
        if ([string]$Receipt.run_id -ne $ExpectedRunId -or
            [string]$Receipt.source_sha -ne $ExpectedSourceSha -or
            $ExpectedSourceSha -notmatch '^[0-9a-fA-F]{40}$' -or
            $Receipt.schema -ne 1 -or
            $Receipt.test_exit_code -ne 0 -or
            $Receipt.guard_expired -ne $false -or
            $Receipt.process_started -ne $true -or
            $Receipt.root_identity_verified -ne $true -or
            $Receipt.samples -lt 2 -or
            $Receipt.observer_errors -ne 0 -or
            $Receipt.owned_cleanup_verified -ne $true -or
            $Receipt.terminal -ne $true) { return $false }
        $started = [datetime]::Parse([string]$Receipt.started_utc).ToUniversalTime()
        $ended = [datetime]::Parse([string]$Receipt.ended_utc).ToUniversalTime()
        if ($ended -lt $started -or ($ended-$started).TotalSeconds -gt 900) { return $false }
        return $true
    } catch { return $false }
}
Export-ModuleMember -Function Get-WorkloadScopedSample,Test-WorkloadOutcome
