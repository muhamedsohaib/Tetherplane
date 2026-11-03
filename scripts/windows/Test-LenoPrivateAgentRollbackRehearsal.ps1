# Isolated exact-version recovery rehearsal for the November 1 protected Leno agent.
# Does NOT stop/start agents, mutate scheduled tasks, read private argument contents,
# reuse credentials, or start a second device session.
[CmdletBinding()]
param(
    [string]$ExpectedInstalledAgentSHA256 = '411E0F07F32CA3E6CF69A5CA53F3995E268946DF419600BF0C807D737D00895C',
    [switch]$CreateOfflineBinaryBackup
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'Tetherplane Private Agent NoConsole 20261101'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$actions = @($task.Actions)
if ($actions.Count -ne 1 -or [string]$task.State -cne 'Running') {
    throw 'PROTECTED_AGENT_TASK_BASELINE_MISMATCH'
}
$action = $actions[0]
$liveExe = [Environment]::ExpandEnvironmentVariables(([string]$action.Execute).Trim('"'))
if (-not [IO.Path]::IsPathRooted($liveExe) -or
    [IO.Path]::GetFileName($liveExe) -cne 'tetherd-agentw.exe' -or
    -not (Test-Path -LiteralPath $liveExe -PathType Leaf)) {
    throw 'PROTECTED_AGENT_EXECUTABLE_BASELINE_MISMATCH'
}
$liveItem = Get-Item -LiteralPath $liveExe
if (($liveItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'PROTECTED_AGENT_EXECUTABLE_REPARSE_REJECTED'
}
$argMatch = [regex]::Match([string]$action.Arguments, '^--arguments-file\s+(?:"([^"]+)"|([^\s]+))$')
if (-not $argMatch.Success) { throw 'PROTECTED_ARGUMENTS_SWITCH_BASELINE_MISMATCH' }
$privateArgFile = if ($argMatch.Groups[1].Success) { $argMatch.Groups[1].Value } else { $argMatch.Groups[2].Value }
if (-not [IO.Path]::IsPathRooted($privateArgFile) -or
    -not (Test-Path -LiteralPath $privateArgFile -PathType Leaf)) {
    throw 'PROTECTED_ARGUMENTS_FILE_BASELINE_MISMATCH'
}
if (((Get-Item -LiteralPath $privateArgFile).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'PROTECTED_ARGUMENTS_FILE_REPARSE_REJECTED'
}
# The private arguments file contents are never opened.
$originalHash = (Get-FileHash -LiteralPath $liveExe -Algorithm SHA256).Hash
if ($originalHash -ine $ExpectedInstalledAgentSHA256) {
    throw 'PROTECTED_AGENT_SHA256_BASELINE_MISMATCH'
}
$before = @(Get-CimInstance Win32_Process -Filter "Name='tetherd-agentw.exe'" |
    Where-Object { $_.ExecutablePath -ieq $liveExe })
if ($before.Count -ne 1) { throw 'PROTECTED_AGENT_PROCESS_COUNT_MISMATCH' }
$originalPid = [int]$before[0].ProcessId
$originalAction = [string]$action.Execute
$originalArguments = [string]$action.Arguments
$originalTriggerCount = @($task.Triggers).Count
$temporaryRoot = Join-Path $env:TEMP ('TP-LenoRollback-Rehearsal-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot -ErrorAction Stop | Out-Null
$testCompleted = $false
$backupPrepared = $false

function Assert-SandboxChild {
    param([string]$Path, [string]$Root)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'RECOVERY_TARGET_OUTSIDE_SYNTHETIC_SANDBOX'
    }
}

function Restore-VerifiedSandboxBinary {
    param([string]$Source, [string]$Destination, [string]$Root, [string]$Expected)
    Assert-SandboxChild -Path $Source -Root $Root
    Assert-SandboxChild -Path $Destination -Root $Root
    $sourceItem = Get-Item -LiteralPath $Source -ErrorAction Stop
    if ($sourceItem.PSIsContainer -or
        ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'RECOVERY_SOURCE_INVALID'
    }
    if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -ine $Expected) {
        throw 'RECOVERY_SOURCE_HASH_REJECTED'
    }
    if (Test-Path -LiteralPath $Destination) {
        $destItem = Get-Item -LiteralPath $Destination
        if ($destItem.PSIsContainer -or
            ($destItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'RECOVERY_DESTINATION_INVALID'
        }
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ine $Expected) {
        throw 'RECOVERY_DESTINATION_HASH_MISMATCH'
    }
}

try {
    $isolatedBaseline = Join-Path $temporaryRoot 'verified-original.exe'
    $isolatedDestination = Join-Path $temporaryRoot 'synthetic-installed.exe'
    $tamperedBackup = Join-Path $temporaryRoot 'corrupt-backup.exe'
    Copy-Item -LiteralPath $liveExe -Destination $isolatedBaseline -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $isolatedBaseline -Algorithm SHA256).Hash -ine $ExpectedInstalledAgentSHA256) {
        throw 'ISOLATED_BACKUP_INTEGRITY_FAILURE'
    }
    [IO.File]::WriteAllBytes($isolatedDestination, [Text.Encoding]::ASCII.GetBytes('SYNTHETIC_BETA_BINARY_NOT_EXECUTABLE'))
    [IO.File]::WriteAllBytes($tamperedBackup, [Text.Encoding]::ASCII.GetBytes('CORRUPT_ROLLBACK_BACKUP_NOT_EXECUTABLE'))
    $syntheticBefore = (Get-FileHash -LiteralPath $isolatedDestination -Algorithm SHA256).Hash
    $hashRejectionObserved = $false
    try {
        Restore-VerifiedSandboxBinary -Source $tamperedBackup -Destination $isolatedDestination -Root $temporaryRoot -Expected $ExpectedInstalledAgentSHA256
    } catch {
        if ($_.Exception.Message -cne 'RECOVERY_SOURCE_HASH_REJECTED') { throw }
        $hashRejectionObserved = $true
    }
    if (-not $hashRejectionObserved -or
        (Get-FileHash -LiteralPath $isolatedDestination -Algorithm SHA256).Hash -ine $syntheticBefore) {
        throw 'CORRUPT_BACKUP_NOT_REJECTED_FAIL_CLOSED'
    }
    Restore-VerifiedSandboxBinary -Source $isolatedBaseline -Destination $isolatedDestination -Root $temporaryRoot -Expected $ExpectedInstalledAgentSHA256

    $afterTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $afterAction = @($afterTask.Actions)
    $afterAgent = @(Get-CimInstance Win32_Process -Filter "Name='tetherd-agentw.exe'" |
        Where-Object { $_.ExecutablePath -ieq $liveExe })
    if ($afterAction.Count -ne 1 -or
        $afterAction[0].Execute -cne $originalAction -or
        $afterAction[0].Arguments -cne $originalArguments -or
        @($afterTask.Triggers).Count -ne $originalTriggerCount -or
        [string]$afterTask.State -cne 'Running' -or
        $afterAgent.Count -ne 1 -or
        [int]$afterAgent[0].ProcessId -ne $originalPid -or
        (Get-FileHash -LiteralPath $liveExe -Algorithm SHA256).Hash -ine $ExpectedInstalledAgentSHA256) {
        throw 'PROTECTED_AGENT_CHANGED_DURING_REHEARSAL'
    }
    if ($CreateOfflineBinaryBackup) {
        # A binary-only recovery copy. Does not include private identity or credentials.
        $recoveryDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\Recovery\Leno-20261101'
        foreach ($parent in @((Join-Path $env:LOCALAPPDATA 'Tetherplane'), (Join-Path $env:LOCALAPPDATA 'Tetherplane\Recovery'), $recoveryDir)) {
            if (Test-Path -LiteralPath $parent) {
                if (((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw 'OFFLINE_BACKUP_REPARSE_DIRECTORY_REJECTED'
                }
            }
        }
        New-Item -ItemType Directory -Path $recoveryDir -Force | Out-Null
        $offlineCopy = Join-Path $recoveryDir 'tetherd-agentw.exe'
        if (Test-Path -LiteralPath $offlineCopy) {
            $existing = Get-Item -LiteralPath $offlineCopy
            if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'OFFLINE_BACKUP_REPARSE_FILE_REJECTED'
            }
            if ((Get-FileHash -LiteralPath $offlineCopy -Algorithm SHA256).Hash -ine $ExpectedInstalledAgentSHA256) {
                throw 'OFFLINE_BACKUP_CONFLICT_NO_OVERWRITE'
            }
        } else {
            Copy-Item -LiteralPath $isolatedBaseline -Destination $offlineCopy -ErrorAction Stop
        }
        if ((Get-FileHash -LiteralPath $offlineCopy -Algorithm SHA256).Hash -ine $ExpectedInstalledAgentSHA256) {
            throw 'OFFLINE_BACKUP_SHA256_MISMATCH'
        }
        $backupPrepared = $true
    }
    $testCompleted = $true
    [pscustomobject]@{
        Rehearsal = 'ISOLATED_EXACT_VERSION_RESTORE_PASSED'
        Source = 'protected-November-1-binary-read-only'
        InstalledSHA256 = $originalHash
        TamperedBackupRejectedBeforeMutation = $hashRejectionObserved
        SyntheticRestoreSHA256Matched = $true
        OriginalTaskUnchanged = $true
        OriginalAgentProcessIdUnchanged = $true
        PrivateArgumentsFileContentsRead = $false
        TestAgentSessionCreated = $false
        OfflineBinaryBackupPrepared = $backupPrepared
        IndependentRemoteRecoveryTested = $false
        ProtectedAgentReplacementAllowed = $false
    } | ConvertTo-Json -Compress
} finally {
    # Only delete the directory created by this invocation.
    $expectedParent = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $candidate = [IO.Path]::GetFullPath($temporaryRoot)
    if ($candidate.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($candidate).StartsWith('TP-LenoRollback-Rehearsal-')) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction Stop
    }
}
if (-not $testCompleted) { throw 'ISOLATED_REHEARSAL_INCOMPLETE' }
