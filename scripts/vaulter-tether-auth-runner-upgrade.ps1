<#
.SYNOPSIS
  Verified, settings-neutral protected S4U runner file upgrade on Vaulter.
.DESCRIPTION
  Default is read-only. -ApplyV2 replaces only the protected runner file,
  leaving the existing running task and its loaded script alone. -RestoreV1
  restores the exact approved v1 file from the protected backup. Neither mode
  stops a process, restarts a task, changes credentials or touches Funnel.
  Source validation requires a clean, up-to-date feature checkout.
#>
[CmdletBinding()]
param([switch]$ApplyV2, [switch]$RestoreV1)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:taskName = 'Tetherplane-TetherAuth-Startup'
$script:repoRoot = Split-Path -Parent $PSScriptRoot
$script:stateDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:protectedRunner = Join-Path $script:stateDir 'tether-auth-startup-runner.ps1'
$script:v1Backup = Join-Path $script:stateDir 'tether-auth-startup-runner.v1-backup.ps1'
$script:sourceV1 = Join-Path $script:repoRoot 'scripts\vaulter-tether-auth-startup-runner.ps1'
$script:sourceV2 = Join-Path $script:repoRoot 'scripts\vaulter-tether-auth-startup-runner-v2.ps1'
$script:postcheck = Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1'
. (Join-Path $PSScriptRoot 'vaulter-tether-auth-runner-integrity.ps1')

function Assert-Upgrade([bool]$Condition, [string]$Reason) {
    if (-not $Condition) { throw $Reason }
}
function Invoke-RunnerUpgradeTransaction {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][hashtable]$Operations)
    foreach ($name in @('VerifyBaseline','Prepare','Replace','VerifyTarget','Restore','VerifyRestored')) {
        if (-not $Operations.ContainsKey($name) -or
            -not ($Operations[$name] -is [scriptblock])) {
            throw 'Runner upgrade operations are incomplete.'
        }
    }
    # Do not attempt any rollback if no protected file could have changed.
    & $Operations['VerifyBaseline']
    & $Operations['Prepare']
    try {
        & $Operations['Replace']
        & $Operations['VerifyTarget']
        return 'verified'
    } catch {
        # File.Replace can persist its mutation before returning an error.
        try {
            & $Operations['Restore']
            & $Operations['VerifyRestored']
        } catch {
            throw 'RUNNER FILE REPLACEMENT FAILED; ROLLBACK UNVERIFIED. Do not rotate the S4U task. Inspect the protected file.'
        }
        throw 'RUNNER FILE REPLACEMENT FAILED; ROLLED BACK original protected runner. Do not rotate the S4U task.'
    }
}
function Test-FreshV2S4UProof {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$ProofPath,
        [Parameter(Mandatory=$true)][string]$ExpectedV2Hash,
        [Parameter(Mandatory=$true)][datetimeoffset]$NowUtc
    )
    try {
        if (-not (Test-Path -LiteralPath $ProofPath -PathType Leaf) -or
            $ExpectedV2Hash -cnotmatch '^[A-F0-9]{64}$') { return $false }
        $proof = Get-Content -LiteralPath $ProofPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ([string]$proof.v2_source_hash -cne $ExpectedV2Hash -or
            [string]$proof.principal -cne 'S4U' -or
            [string]$proof.task -cne 'Tetherplane-TetherAuth-Startup') { return $false }
        $timestamp = [datetimeoffset]::ParseExact(
            ([string]$proof.verified_utc), 'yyyy-MM-ddTHH:mm:ss.fffffffzzz',
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None
        )
        $age = ($NowUtc.ToUniversalTime() - $timestamp.ToUniversalTime()).TotalMinutes
        return ($age -ge -2 -and $age -le 90)
    } catch { return $false }
}

function Get-SourceHash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash
}
function Assert-PrivateFile([string]$Path) {
    Assert-Upgrade (Test-Path -LiteralPath $Path -PathType Leaf) 'Required protected runner file missing.'
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    Assert-Upgrade (-not ([bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) 'Runner path must not be a reparse point.'
    Assert-Upgrade ([IO.Path]::GetFullPath($item.DirectoryName) -ieq
        [IO.Path]::GetFullPath($script:stateDir)) 'Protected runner escaped its private directory.'
}
function Assert-CleanFeatureCheckout {
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $branchName = (& $git -C $script:repoRoot branch --show-current)
    Assert-Upgrade ($LASTEXITCODE -eq 0 -and
        ([string]$branchName).Trim() -ceq 'feature/tether-auth-vaulter-migration-20261009') 'Unexpected Git feature branch.'
    $dirty = @(& $git -C $script:repoRoot status --porcelain --untracked-files=no)
    Assert-Upgrade ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'Uncommitted source changes; refusing runner replacement.'
    $head = [string](& $git -C $script:repoRoot rev-parse HEAD)
    Assert-Upgrade ($LASTEXITCODE -eq 0) 'Cannot validate feature checkout.'
    $remoteHead = [string](& $git -C $script:repoRoot rev-parse 'refs/remotes/origin/feature/tether-auth-vaulter-migration-20261009')
    Assert-Upgrade ($LASTEXITCODE -eq 0 -and $head.Trim() -ceq $remoteHead.Trim()) 'Checkout differs from fetched feature branch.'
}
function Get-TaskSnapshot {
    $task = Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
    Assert-Upgrade ($task.State -eq 'Running' -and
        [bool]$task.Settings.Enabled -and
        ([string]$task.Principal.LogonType) -ceq 'S4U') 'Original S4U task must remain enabled and running.'
    Assert-Upgrade ([int]$task.Settings.RestartCount -eq 10 -and
        ([string]$task.Settings.RestartInterval) -ceq 'PT1M') 'Registered retry policy unexpectedly changed.'
    Assert-Upgrade (@($task.Triggers | Where-Object {
        $_.CimClass.CimClassName -match 'BootTrigger$'
    }).Count -gt 0) 'S4U task has no boot trigger.'
    $actions = @($task.Actions)
    Assert-Upgrade ($actions.Count -eq 1 -and
        ([string]$actions[0].Arguments).Contains(' -File "' + $script:protectedRunner + '"') -and
        ([string]$actions[0].Arguments).EndsWith(' -Serve', [StringComparison]::Ordinal)) 'Task action differs from protected runner.'
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
    Assert-Upgrade ($listeners.Count -eq 1 -and
        $listeners[0].LocalAddress -ceq '127.0.0.1') 'Auth listener missing or does not own loopback exclusively.'
    $listenerId = [int]$listeners[0].OwningProcess
    $node = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerId" -ErrorAction Stop
    Assert-Upgrade ($null -ne $node -and $node.Name -ieq 'node.exe') 'Auth listener process identity changed.'
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($node.ParentProcessId)" -ErrorAction Stop
    Assert-Upgrade ($null -ne $parent -and $parent.Name -ieq 'powershell.exe' -and
        ([string]$parent.CommandLine).Contains($script:protectedRunner)) 'Auth process not owned by protected S4U runner.'
    return [pscustomobject]@{
        TaskXml = [string](Export-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop)
        ListenerPid = $listenerId
        ListenerCreated = $node.CreationDate
        ParentPid = [int]$parent.ProcessId
        ParentCreated = $parent.CreationDate
    }
}
function Verify-UnchangedService {
    $now = Get-TaskSnapshot
    Assert-Upgrade ($now.TaskXml -ceq $script:baseline.TaskXml -and
        $now.ListenerPid -eq $script:baseline.ListenerPid -and
        $now.ListenerCreated -eq $script:baseline.ListenerCreated -and
        $now.ParentPid -eq $script:baseline.ParentPid -and
        $now.ParentCreated -eq $script:baseline.ParentCreated) 'Concurrent task or process change; protected runner file upgrade must stop.'
    & $script:postcheck | Out-Null
}
function Test-PrivateRunnerVersion([string]$Expected) {
    Assert-PrivateFile $script:protectedRunner
    $actual = Get-VerifiedRunnerVersion -V1SourcePath $script:sourceV1 -V2SourcePath $script:sourceV2 -ProtectedRunnerPath $script:protectedRunner
    Assert-Upgrade ($actual -ceq $Expected) 'Protected runner bytes do not match expected trusted version.'
    Assert-PrivateAcl $script:protectedRunner
}
function Test-RunnerAclEquivalent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Expected,
        [Parameter(Mandatory=$true)]$Actual
    )
    try {
        if (([string]$Expected.Owner) -cne ([string]$Actual.Owner) -or
            ([string]$Expected.Group) -cne ([string]$Actual.Group) -or
            [bool]$Expected.AreAccessRulesProtected -ne [bool]$Actual.AreAccessRulesProtected) {
            return $false
        }
        # Windows can reserialize inherited ACE flags when replacing a file,
        # without changing its actual owner, permissions or inheritance policy.
        # Compare effective ACE identities/rights/types/flags, not raw SDDL.
        $beforeRules = @(foreach ($ace in @($Expected.Access)) {
            [string]$ace.IdentityReference.Value + '|' + [string]$ace.FileSystemRights + '|' +
                [string]$ace.AccessControlType + '|' + [string]$ace.InheritanceFlags + '|' +
                [string]$ace.PropagationFlags
        }) | Sort-Object
        $afterRules = @(foreach ($ace in @($Actual.Access)) {
            [string]$ace.IdentityReference.Value + '|' + [string]$ace.FileSystemRights + '|' +
                [string]$ace.AccessControlType + '|' + [string]$ace.InheritanceFlags + '|' +
                [string]$ace.PropagationFlags
        }) | Sort-Object
        return (($beforeRules -join ';') -ceq ($afterRules -join ';'))
    } catch {
        return $false
    }
}

function Invoke-RunnerAtomicReplace {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$StagedPath,
        [Parameter(Mandatory=$true)][string]$TargetPath,
        [Parameter(Mandatory=$true)][string]$BackupPath
    )
    # All three paths must share one directory on a single local volume.
    # Existing backups are NEVER overwritten or silently discarded.
    $folder = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($TargetPath))
    foreach ($path in @($StagedPath,$BackupPath)) {
        $other = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path))
        if ($other -ine $folder) { throw 'Runner swap paths must share one directory.' }
    }
    if (Test-Path -LiteralPath $BackupPath) { throw 'Protected runner backup already exists.' }
    foreach ($path in @($StagedPath,$TargetPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'Atomic replacement source or target file missing.'
        }
        $attributes = (Get-Item -LiteralPath $path -ErrorAction Stop).Attributes
        if ([bool]($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Runner file may not be a reparse point.'
        }
    }
    $beforeAcl = Get-Acl -LiteralPath $TargetPath -ErrorAction Stop
    # Ensure staged bytes start with the same effective ACL as the trusted
    # original. File.Replace is atomic for content, not ACL representation.
    Set-Acl -LiteralPath $StagedPath -AclObject $beforeAcl -ErrorAction Stop
    [IO.File]::Replace($StagedPath,$TargetPath,$BackupPath)
    foreach ($path in @($TargetPath,$BackupPath)) {
        $after = Get-Acl -LiteralPath $path -ErrorAction Stop
        if (-not (Test-RunnerAclEquivalent -Expected $beforeAcl -Actual $after)) {
            Set-Acl -LiteralPath $path -AclObject $beforeAcl -ErrorAction Stop
        }
        if (-not (Test-RunnerAclEquivalent -Expected $beforeAcl -Actual (Get-Acl -LiteralPath $path -ErrorAction Stop))) {
            throw 'Protected runner effective permissions or ownership changed during replacement.'
        }
    }
}

function Assert-PrivateAcl([string]$Path) {
    $actual = Get-Acl -LiteralPath $Path -ErrorAction Stop
    Assert-Upgrade (Test-RunnerAclEquivalent -Expected $script:originalAcl -Actual $actual) 'Protected runner effective ACL or owner differs from original.'
}
function New-PrivateTemporaryPath {
    return (Join-Path $script:stateDir ('tether-auth-upgrade-' + [guid]::NewGuid().ToString('N') + '.tmp'))
}
function Prepare-PrivateReplacement([string]$Source) {
    $script:prepared = New-PrivateTemporaryPath
    Copy-Item -LiteralPath $Source -Destination $script:prepared -ErrorAction Stop
    # Maintain existing file-level access controls inside the protected state.
    Set-Acl -LiteralPath $script:prepared -AclObject $script:originalAcl -ErrorAction Stop
    Assert-PrivateFile $script:prepared
    Assert-Upgrade ((Get-SourceHash $script:prepared) -ceq (Get-SourceHash $Source)) 'Candidate file hash changed during private copy.'
}
function Restore-BaselineFile {
    # A failed File.Replace may or may not have mutated the destination.
    $current = $null
    try {
        $current = Get-VerifiedRunnerVersion -V1SourcePath $script:sourceV1 -V2SourcePath $script:sourceV2 -ProtectedRunnerPath $script:protectedRunner
    } catch { }
    if ($current -ceq $script:baselineVersion) { return }
    $trustedSource = if ($script:baselineVersion -ceq 'v1') {
        Assert-Upgrade (Test-Path -LiteralPath $script:v1Backup -PathType Leaf) 'Cannot roll back v1 without its verified protected backup.'
        Assert-Upgrade ((Get-SourceHash $script:v1Backup) -ceq (Get-SourceHash $script:sourceV1)) 'Protected v1 backup changed; refusing rollback.'
        $script:v1Backup
    } else {
        $script:sourceV2
    }
    $script:restoreTemp = New-PrivateTemporaryPath
    Copy-Item -LiteralPath $trustedSource -Destination $script:restoreTemp -ErrorAction Stop
    Set-Acl -LiteralPath $script:restoreTemp -AclObject $script:originalAcl -ErrorAction Stop
    Assert-Upgrade ((Get-SourceHash $script:restoreTemp) -ceq (Get-SourceHash $trustedSource)) 'Recovery candidate differs from trusted source.'
    $script:restoreEvidence = New-PrivateTemporaryPath
    Invoke-RunnerAtomicReplace -StagedPath $script:restoreTemp -TargetPath $script:protectedRunner -BackupPath $script:restoreEvidence
}

if ($ApplyV2 -and $RestoreV1) {
    throw 'Select only one protected-runner operation: -ApplyV2 or -RestoreV1.'
}
Assert-Upgrade ($env:OS -eq 'Windows_NT' -and
    $env:COMPUTERNAME -ieq 'vaulter') 'Protected runner changes are restricted to Vaulter.'
Assert-Upgrade (Test-Path -LiteralPath $script:stateDir -PathType Container) 'Protected auth state unavailable.'
Assert-Upgrade ((Get-Acl -LiteralPath $script:stateDir).AreAccessRulesProtected) 'Auth state ACL must be protected.'
Assert-PrivateFile $script:protectedRunner
Assert-CleanFeatureCheckout
Assert-Upgrade (Test-Path -LiteralPath $script:postcheck -PathType Leaf) 'Independent auth postcheck unavailable.'
$script:baselineVersion = Get-VerifiedRunnerVersion -V1SourcePath $script:sourceV1 -V2SourcePath $script:sourceV2 -ProtectedRunnerPath $script:protectedRunner
& $script:postcheck | Out-Null
$script:baseline = Get-TaskSnapshot
$script:originalAcl = Get-Acl -LiteralPath $script:protectedRunner -ErrorAction Stop

if (-not $ApplyV2 -and -not $RestoreV1) {
    Write-Output ("UPGRADE PREFLIGHT PASS: protected_runner={0}; task=Running; config=unchanged." -f $script:baselineVersion)
    Write-Output 'No changes made. -ApplyV2 installs a protected runner file without restarting the task; -RestoreV1 uses its verified private backup.'
    return
}

$script:prepared = $null
$script:restoreTemp = $null
$script:restoreEvidence = $null
$script:replaceEvidence = $null
if ($ApplyV2) {
    Assert-Upgrade ($script:baselineVersion -ceq 'v1') 'Upgrade requires the original installed v1 runner.'
    $v2ProbeProof = Join-Path $script:stateDir 'tether-auth-runner-v2-probe.json'
    Assert-Upgrade (Test-FreshV2S4UProof -ProofPath $v2ProbeProof -ExpectedV2Hash (Get-SourceHash $script:sourceV2) -NowUtc ([datetimeoffset]::UtcNow)) 'Recent matching S4U v2 proof required before protected runner replacement.'
    Assert-Upgrade (-not (Test-Path -LiteralPath $script:v1Backup)) 'Private v1 backup already exists; refusing to overwrite it.'
    $source = $script:sourceV2
    $targetVersion = 'v2'
    $backupTarget = $script:v1Backup
} else {
    Assert-Upgrade ($script:baselineVersion -ceq 'v2') 'Restore requires an installed v2 runner.'
    Assert-PrivateFile $script:v1Backup
    Assert-Upgrade ((Get-SourceHash $script:v1Backup) -ceq (Get-SourceHash $script:sourceV1)) 'Private v1 backup does not match the trusted original.'
    $source = $script:v1Backup
    $targetVersion = 'v1'
    $backupTarget = New-PrivateTemporaryPath
    $script:replaceEvidence = $backupTarget
}
$ops = @{
    VerifyBaseline = {
        Test-PrivateRunnerVersion $script:baselineVersion
        Verify-UnchangedService
    }
    Prepare = {
        Prepare-PrivateReplacement $source
    }
    Replace = {
        Test-PrivateRunnerVersion $script:baselineVersion
        $snapshot = Get-TaskSnapshot
        Assert-Upgrade ($snapshot.TaskXml -ceq $script:baseline.TaskXml -and
            $snapshot.ListenerPid -eq $script:baseline.ListenerPid -and
            $snapshot.ListenerCreated -eq $script:baseline.ListenerCreated) 'Task or auth listener changed before atomic replacement.'
        # Same-directory atomic replacement, with v1 source retained
        # under the existing ACL-protected auth-state directory.
        Invoke-RunnerAtomicReplace -StagedPath $script:prepared -TargetPath $script:protectedRunner -BackupPath $backupTarget
    }
    VerifyTarget = {
        Test-PrivateRunnerVersion $targetVersion
        if ($ApplyV2) {
            Assert-PrivateFile $script:v1Backup
            Assert-Upgrade ((Get-SourceHash $script:v1Backup) -ceq
                (Get-SourceHash $script:sourceV1)) 'Protected v1 backup could not be verified.'
            Assert-PrivateAcl $script:v1Backup
        }
        Verify-UnchangedService
    }
    Restore = {
        Restore-BaselineFile
    }
    VerifyRestored = {
        Test-PrivateRunnerVersion $script:baselineVersion
        Verify-UnchangedService
    }
}
$script:cleanupApproved = $false
try {
    $result = Invoke-RunnerUpgradeTransaction -Operations $ops
    Assert-Upgrade ($result -ceq 'verified') 'Unexpected protected-runner upgrade result.'
    $script:cleanupApproved = $true
    if ($ApplyV2) {
        Write-Output 'RUNNER FILE UPGRADE VERIFIED: exact v2 bytes installed, v1 privately backed up, live task/PID unchanged.'
    } else {
        Write-Output 'RUNNER FILE RESTORE VERIFIED: exact v1 bytes installed; live task/PID unchanged.'
    }
    Write-Output 'Running supervisor version and child restart behavior are UNVERIFIED until a separate controlled task refresh.'
} catch {
    # Preserve all private candidate and replacement evidence if actual
    # rollback was not independently verified.
    if ($_.Exception.Message -match 'ROLLED BACK') { $script:cleanupApproved = $true }
    throw
} finally {
    if ($script:cleanupApproved) {
        foreach ($temp in @($script:prepared, $script:restoreTemp, $script:replaceEvidence, $script:restoreEvidence)) {
            if ($temp -and (Test-Path -LiteralPath $temp -PathType Leaf)) {
                Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
