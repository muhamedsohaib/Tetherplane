$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../../scripts/cdp-workload-evidence.psm1') -Force

function Should($condition, $message) {
    if (-not $condition) { throw $message }
}

$time = [datetime]'2026-10-24T00:00:00Z'
$root = [pscustomobject]@{
    ProcessId=20001; ParentProcessId=10; CreationDate=$time;
    WorkingSetSize=10485760; KernelModeTime=1000000; UserModeTime=2000000;
    ReadTransferCount=1048576; WriteTransferCount=2097152
}
$child = [pscustomobject]@{
    ProcessId=20002; ParentProcessId=20001; CreationDate=$time.AddSeconds(1);
    WorkingSetSize=5242880; KernelModeTime=500000; UserModeTime=500000;
    ReadTransferCount=524288; WriteTransferCount=1048576
}
$sample = Get-WorkloadScopedSample -Processes @($root,$child) -RootProcessId 20001 -RootStartedUtc $time -ElapsedMilliseconds 2000
Should ($sample.valid -eq $true -and $sample.process_count -eq 2) 'Correct tree rejected'
Should ($sample.working_set_mib -eq 15) 'Resource aggregation incorrect'
# Real Windows Win32_Process snapshots include pseudo PID 0. Unrelated idle
# processes must not invalidate a fully bound positive process tree.
$idle = [pscustomobject]@{
    ProcessId=0; ParentProcessId=0; CreationDate=$time;
    WorkingSetSize=0; KernelModeTime=0; UserModeTime=0;
    ReadTransferCount=0; WriteTransferCount=0
}
$withIdle = Get-WorkloadScopedSample -Processes @($idle,$root,$child) -RootProcessId 20001 -RootStartedUtc $time -ElapsedMilliseconds 2000
Should ($withIdle.valid -eq $true -and $withIdle.process_count -eq 2) 'Unrelated PID zero falsely invalidated the owned process tree'
Should (-not ($sample.PSObject.Properties.Name -contains 'identities')) 'Successful observer exposed process identities'

$reuse = Get-WorkloadScopedSample -Processes @($root,$child) -RootProcessId 20001 -RootStartedUtc $time.AddSeconds(-30) -ElapsedMilliseconds 2000
Should ($reuse.valid -eq $false) 'Reused root PID accepted'

$before = $child.PSObject.Copy()
$before.CreationDate = $time.AddMinutes(-1)
$older = Get-WorkloadScopedSample -Processes @($root,$before) -RootProcessId 20001 -RootStartedUtc $time -ElapsedMilliseconds 2000
Should ($older.valid -eq $true -and $older.process_count -eq 1) 'Older unrelated PID treated as descendant'

$orphan = Get-WorkloadScopedSample -Processes @($child) -RootProcessId 20001 -RootStartedUtc $time -ElapsedMilliseconds 2000
Should ($orphan.valid -eq $false) 'Missing root treated as valid'
Should (-not ($orphan.PSObject.Properties.Name -contains 'identities')) 'Unknown observer sample exposed process identities'

$missing = $root.PSObject.Copy()
$missing.KernelModeTime = $null
$sampleMissing = Get-WorkloadScopedSample -Processes @($missing) -RootProcessId 20001 -RootStartedUtc $time -ElapsedMilliseconds 2000
Should ($sampleMissing.valid -eq $true -and $null -eq $sampleMissing.cpu_time_ms) 'Missing CPU metric silently reported as zero'

# A broken WMI metric getter must not bubble private exception text or crash the sampler.
$broken = $root.PSObject.Copy()
$broken.PSObject.Properties.Remove('WorkingSetSize')
Add-Member -InputObject $broken -MemberType ScriptProperty -Name WorkingSetSize -Value { throw 'private-process-marker' }
Should ($broken.PSObject.Properties['WorkingSetSize'].MemberType -eq [System.Management.Automation.PSMemberTypes]::ScriptProperty) 'Fixture failed to create a script-property getter'
$observerError = Get-WorkloadScopedSample -Processes @($broken) -RootProcessId 20001 -RootStartedUtc $time -ElapsedMilliseconds 2000
Should ($observerError.valid -eq $false) 'Throwing process observer falsely returned success'

$run = [guid]::NewGuid().ToString()
$sha = '506cae4ad96a893210e6c095f433431dd87fdc88'
$receipt = [pscustomobject]@{
    schema=1; run_id=$run; source_sha=$sha; test_exit_code=0;
    guard_expired=$false; process_started=$true; root_identity_verified=$true;
    samples=3; observer_errors=0; owned_cleanup_verified=$true; terminal=$true;
    started_utc='2026-10-24T00:00:00Z'; ended_utc='2026-10-24T00:00:03Z'
}
Should (Test-WorkloadOutcome -Receipt $receipt -ExpectedRunId $run -ExpectedSourceSha $sha) 'Valid receipt rejected'
foreach ($field in @('run_id','source_sha','test_exit_code','guard_expired','process_started','root_identity_verified','samples','observer_errors','owned_cleanup_verified','terminal')) {
    $r = $receipt.PSObject.Copy()
    switch ($field) {
        'run_id' {$r.$field = [guid]::NewGuid().ToString()}
        'source_sha' {$r.$field = '0000000000000000000000000000000000000000'}
        'test_exit_code' {$r.$field = 1}
        'guard_expired' {$r.$field = $true}
        'process_started' {$r.$field = $false}
        'root_identity_verified' {$r.$field = $false}
        'samples' {$r.$field = 0}
        'observer_errors' {$r.$field = 1}
        'owned_cleanup_verified' {$r.$field = $null}
        'terminal' {$r.$field = $false}
    }
    Should (-not (Test-WorkloadOutcome -Receipt $r -ExpectedRunId $run -ExpectedSourceSha $sha)) "Invalid receipt field accepted: $field"
}
$old = $receipt.PSObject.Copy()
$old.ended_utc='2026-10-24T01:00:00Z'
Should (-not (Test-WorkloadOutcome -Receipt $old -ExpectedRunId $run -ExpectedSourceSha $sha)) 'Overlong stale receipt accepted'
Write-Output 'CDP_WORKLOAD_FAIL_CLOSED_CONTRACT=PASS'
