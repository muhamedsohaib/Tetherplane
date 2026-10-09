<#
.SYNOPSIS
  Offline, rollback-safe v1 rescue for the named Vaulter auth Scheduled Task.
.DESCRIPTION
  Read-only by default. -RestoreV1 changes ONLY protected runner bytes while
  the named task is Ready and port 8790 has no listener. -StartV1Task separately
  starts ONLY that existing task after v1 has been independently restored.
  No command stops a process, changes task registration, secrets or Funnel.
  The original protected v1 backup is never overwritten or deleted.
#>
[CmdletBinding()]
param([switch]$RestoreV1, [switch]$StartV1Task)

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

function Assert-Offline([bool]$Allowed, [string]$Reason) {
    if (-not $Allowed) { throw $Reason }
}
function Assert-OfflineTaskShape {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Task,
        [Parameter(Mandatory=$true)][string]$ProtectedRunnerPath,
        [switch]$AllowRunning
    )
    $allowedStates = if ($AllowRunning) { @('Ready','Running') } else { @('Ready') }
    if (@($allowedStates) -cnotcontains ([string]$Task.State)) {
        throw 'Named S4U task is not in the required non-running Ready state.'
    }
    if (-not [bool]$Task.Settings.Enabled -or
        [int]$Task.Settings.RestartCount -ne 10 -or
        [string]$Task.Settings.RestartInterval -cne 'PT1M' -or
        [string]$Task.Principal.LogonType -cne 'S4U') {
        throw 'Named task supervision policy or S4U principal differs from the verified baseline.'
    }
    if (@($Task.Triggers | Where-Object {
        $_.CimClass.CimClassName -match 'BootTrigger$'
    }).Count -eq 0) {
        throw 'Named task no longer has its required boot trigger.'
    }
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1 -or
        -not ([string]$actions[0].Arguments).Contains(' -File "' + $ProtectedRunnerPath + '"') -or
        -not ([string]$actions[0].Arguments).EndsWith(' -Serve',[StringComparison]::Ordinal)) {
        throw 'Named task action does not target the protected runner.'
    }
}
function Test-OfflinePrincipal {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][Security.Principal.WindowsIdentity]$Identity,
        [Parameter(Mandatory=$true)][string]$TaskUserId
    )
    try {
        if ($null -eq $Identity.User) { return $false }
        $taskSid = if ($TaskUserId -match '^S-\d+(?:-\d+)+$') {
            ([Security.Principal.SecurityIdentifier]::new($TaskUserId)).Value
        } else {
            ([Security.Principal.NTAccount]::new($TaskUserId)).Translate(
                [Security.Principal.SecurityIdentifier]
            ).Value
        }
        return ($taskSid -ceq $Identity.User.Value)
    } catch { return $false }
}
function Test-OfflineAclEquivalent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Expected,
        [Parameter(Mandatory=$true)]$Actual
    )
    try {
        if ([string]$Expected.Owner -cne [string]$Actual.Owner -or
            [string]$Expected.Group -cne [string]$Actual.Group -or
            [bool]$Expected.AreAccessRulesProtected -ne [bool]$Actual.AreAccessRulesProtected) {
            return $false
        }
        $before = @(foreach ($ace in @($Expected.Access)) {
            [string]$ace.IdentityReference.Value + '|' + [string]$ace.FileSystemRights + '|' +
                [string]$ace.AccessControlType + '|' + [string]$ace.InheritanceFlags + '|' +
                [string]$ace.PropagationFlags
        }) | Sort-Object
        $after = @(foreach ($ace in @($Actual.Access)) {
            [string]$ace.IdentityReference.Value + '|' + [string]$ace.FileSystemRights + '|' +
                [string]$ace.AccessControlType + '|' + [string]$ace.InheritanceFlags + '|' +
                [string]$ace.PropagationFlags
        }) | Sort-Object
        return (($before -join ';') -ceq ($after -join ';'))
    } catch { return $false }
}
function Invoke-OfflineFileSwap {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$StagedPath,
        [Parameter(Mandatory=$true)][string]$TargetPath,
        [Parameter(Mandatory=$true)][string]$EvidencePath
    )
    $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($TargetPath))
    foreach ($candidate in @($StagedPath,$EvidencePath)) {
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($candidate)) -ine $directory) {
            throw 'Offline replacement files must all share the protected directory.'
        }
    }
    if (Test-Path -LiteralPath $EvidencePath) {
        throw 'Offline evidence file already exists; refusing overwrite.'
    }
    foreach ($file in @($StagedPath,$TargetPath)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw 'Offline replacement target or staged file missing.'
        }
        if ([bool]((Get-Item -LiteralPath $file -ErrorAction Stop).Attributes -band
            [IO.FileAttributes]::ReparsePoint)) {
            throw 'Offline replacement cannot follow reparse points.'
        }
    }
    $acl = Get-Acl -LiteralPath $TargetPath -ErrorAction Stop
    Set-Acl -LiteralPath $StagedPath -AclObject $acl -ErrorAction Stop
    [IO.File]::Replace($StagedPath,$TargetPath,$EvidencePath)
    foreach ($file in @($TargetPath,$EvidencePath)) {
        $current = Get-Acl -LiteralPath $file -ErrorAction Stop
        if (-not (Test-OfflineAclEquivalent -Expected $acl -Actual $current)) {
            Set-Acl -LiteralPath $file -AclObject $acl -ErrorAction Stop
        }
        if (-not (Test-OfflineAclEquivalent -Expected $acl -Actual (Get-Acl -LiteralPath $file -ErrorAction Stop))) {
            throw 'Offline replacement did not preserve protected owner and effective ACL.'
        }
    }
}
function Invoke-OfflineRestoreTransaction {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][hashtable]$Operations)
    foreach ($name in @('VerifyBaseline','Prepare','Replace','VerifyV1','RestoreV2','VerifyV2')) {
        if (-not $Operations.ContainsKey($name) -or
            -not ($Operations[$name] -is [scriptblock])) {
            throw 'Offline restoration operations are incomplete.'
        }
    }
    & $Operations['VerifyBaseline']
    & $Operations['Prepare']
    try {
        & $Operations['Replace']
        & $Operations['VerifyV1']
        return 'restored'
    } catch {
        try {
            & $Operations['RestoreV2']
            & $Operations['VerifyV2']
        } catch {
            throw 'OFFLINE RESTORE FAILED; ROLLBACK UNVERIFIED. Preserve private evidence and do not start the task.'
        }
        throw 'OFFLINE RESTORE FAILED; ROLLED BACK verified original v2 runner. Do not start the task.'
    }
}
function Invoke-OfflineStartTransaction {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][hashtable]$Operations)
    foreach ($name in @('VerifyReady','StartNamedTask','VerifyHealthy')) {
        if (-not $Operations.ContainsKey($name) -or
            -not ($Operations[$name] -is [scriptblock])) {
            throw 'Offline task start operations are incomplete.'
        }
    }
    & $Operations['VerifyReady']
    & $Operations['StartNamedTask']
    & $Operations['VerifyHealthy']
    return 'healthy'
}
function Assert-PrivateRunnerFile([string]$File) {
    Assert-Offline (Test-Path -LiteralPath $File -PathType Leaf) 'Protected runner or original backup missing.'
    $info = Get-Item -LiteralPath $File -ErrorAction Stop
    Assert-Offline (-not ([bool]($info.Attributes -band [IO.FileAttributes]::ReparsePoint))) 'Protected runner may not be a reparse point.'
    Assert-Offline ([IO.Path]::GetFullPath($info.DirectoryName) -ieq
        [IO.Path]::GetFullPath($script:stateDir)) 'Runner file escaped its protected directory.'
}
function Get-TrustedRunnerVersion {
    Assert-PrivateRunnerFile $script:protectedRunner
    Assert-PrivateRunnerFile $script:v1Backup
    Assert-Offline (Test-Path -LiteralPath $script:sourceV1 -PathType Leaf) 'Trusted v1 source missing.'
    Assert-Offline (Test-Path -LiteralPath $script:sourceV2 -PathType Leaf) 'Trusted v2 source missing.'
    $backupHash = (Get-FileHash -LiteralPath $script:v1Backup -Algorithm SHA256 -ErrorAction Stop).Hash
    $sourceHash = (Get-FileHash -LiteralPath $script:sourceV1 -Algorithm SHA256 -ErrorAction Stop).Hash
    Assert-Offline ($backupHash -ceq $sourceHash) 'Private v1 backup no longer matches the trusted source.'
    $acl = Get-Acl -LiteralPath $script:protectedRunner -ErrorAction Stop
    $backupAcl = Get-Acl -LiteralPath $script:v1Backup -ErrorAction Stop
    $aclMatches = Test-OfflineAclEquivalent -Expected $acl -Actual $backupAcl
    Assert-Offline $aclMatches 'Private v1 backup ACL differs from installed runner.'
    return (Get-VerifiedRunnerVersion -V1SourcePath $script:sourceV1 -V2SourcePath $script:sourceV2 -ProtectedRunnerPath $script:protectedRunner)
}
function Assert-CheckoutSafe {
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $currentBranch = [string](& $git -C $script:repoRoot branch --show-current)
    Assert-Offline ($LASTEXITCODE -eq 0 -and $currentBranch.Trim() -ceq
        'feature/tether-auth-vaulter-migration-20261009') 'Offline recovery requires the approved feature branch.'
    $status = @(& $git -C $script:repoRoot status --porcelain)
    Assert-Offline ($LASTEXITCODE -eq 0 -and $status.Count -eq 0) 'Offline recovery requires a clean local checkout.'
    # No network access is required to restore a verified private backup.
    $head = [string](& $git -C $script:repoRoot rev-parse HEAD)
    $fetched = [string](& $git -C $script:repoRoot rev-parse 'refs/remotes/origin/feature/tether-auth-vaulter-migration-20261009')
    Assert-Offline ($LASTEXITCODE -eq 0 -and $head.Trim() -ceq $fetched.Trim()) 'Checkout and fetched feature branch differ.'
}
function Get-OfflineTaskSnapshot([switch]$AllowRunning) {
    $task = Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
    Assert-OfflineTaskShape -Task $task -ProtectedRunnerPath $script:protectedRunner -AllowRunning:$AllowRunning
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    Assert-Offline (Test-OfflinePrincipal -Identity $current -TaskUserId ([string]$task.Principal.UserId)) 'Task S4U principal differs from current authorized operator.'
    return [pscustomobject]@{
        State = [string]$task.State
        TaskXml = [string](Export-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop)
    }
}
function Assert-PortVacant {
    # Enumerate with terminating errors, then filter the port. No matches
    # means vacant; an enumeration failure is NOT interpreted as vacant.
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq 8790 })
    Assert-Offline ($listeners.Count -eq 0) 'Auth listener is present; offline recovery cannot touch a running service.'
}
function Assert-OfflineBaseline([string]$Version) {
    $now = Get-OfflineTaskSnapshot
    Assert-Offline ($now.TaskXml -ceq $script:baseline.TaskXml -and
        $now.State -ceq 'Ready') 'Named S4U task changed during offline restoration.'
    Assert-PortVacant
    $actual = Get-TrustedRunnerVersion
    Assert-Offline ($actual -ceq $Version) 'Protected runner version changed concurrently.'
}
function New-OfflinePrivatePath {
    return Join-Path $script:stateDir ('tether-auth-offline-' + [guid]::NewGuid().ToString('N') + '.tmp')
}
function Prepare-OfflineStaging([string]$Source) {
    $script:prepared = New-OfflinePrivatePath
    Copy-Item -LiteralPath $Source -Destination $script:prepared -ErrorAction Stop
    Set-Acl -LiteralPath $script:prepared -AclObject $script:originalAcl -ErrorAction Stop
    Assert-PrivateRunnerFile $script:prepared
    Assert-Offline ((Get-FileHash -LiteralPath $script:prepared -Algorithm SHA256).Hash -ceq
        (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash) 'Private staged runner differs from its verified source.'
}
function Restore-OriginalV2 {
    # If File.Replace was partially applied, restore exact verified v2 bytes.
    # Never overwrite or delete the canonical protected v1 backup.
    $current = $null
    try { $current = Get-TrustedRunnerVersion } catch { }
    if ($current -ceq 'v2') { return }
    $snapshot = Get-OfflineTaskSnapshot
    Assert-Offline ($snapshot.TaskXml -ceq $script:baseline.TaskXml) 'Task changed; offline rollback requires manual review.'
    Assert-PortVacant
    $script:rollbackStage = New-OfflinePrivatePath
    $trustedV2 = $script:sourceV2
    if ($script:replacedV2 -and (Test-Path -LiteralPath $script:replacedV2 -PathType Leaf)) {
        if ((Get-FileHash -LiteralPath $script:replacedV2 -Algorithm SHA256).Hash -ceq
            (Get-FileHash -LiteralPath $script:sourceV2 -Algorithm SHA256).Hash) {
            $trustedV2 = $script:replacedV2
        }
    }
    Copy-Item -LiteralPath $trustedV2 -Destination $script:rollbackStage -ErrorAction Stop
    Set-Acl -LiteralPath $script:rollbackStage -AclObject $script:originalAcl -ErrorAction Stop
    $script:rollbackEvidence = New-OfflinePrivatePath
    Invoke-OfflineFileSwap -StagedPath $script:rollbackStage -TargetPath $script:protectedRunner -EvidencePath $script:rollbackEvidence
}
if ($RestoreV1 -and $StartV1Task) {
    throw 'Select only one explicit offline operation: -RestoreV1 or -StartV1Task.'
}
Assert-Offline ($env:OS -ceq 'Windows_NT' -and
    $env:COMPUTERNAME -ieq 'vaulter') 'Offline auth restoration is restricted to Vaulter.'
Assert-Offline (Test-Path -LiteralPath $script:stateDir -PathType Container) 'Protected auth directory unavailable.'
$privateRoot = Get-Item -LiteralPath $script:stateDir -ErrorAction Stop
Assert-Offline (-not ([bool]($privateRoot.Attributes -band [IO.FileAttributes]::ReparsePoint))) 'Protected auth directory may not be a reparse point.'
Assert-Offline ((Get-Acl -LiteralPath $script:stateDir -ErrorAction Stop).AreAccessRulesProtected) 'Protected auth directory ACL is not isolated.'
Assert-CheckoutSafe
$installedVersion = Get-TrustedRunnerVersion
$script:originalAcl = Get-Acl -LiteralPath $script:protectedRunner -ErrorAction Stop

if (-not $RestoreV1 -and -not $StartV1Task) {
    $snapshot = Get-OfflineTaskSnapshot -AllowRunning
    Write-Output ("OFFLINE V1 PREFLIGHT: installed_runner={0}; task={1}; backup=verified." -f $installedVersion,$snapshot.State)
    Write-Output 'No changes made. Offline v1 file restoration requires task Ready with no listener; explicit -StartV1Task is separate.'
    return
}

$script:baseline = Get-OfflineTaskSnapshot
Assert-PortVacant
if ($RestoreV1) {
    Assert-Offline ($installedVersion -ceq 'v2') 'Offline restore requires the installed, exact v2 runner.'
    $script:prepared = $null
    $script:replacedV2 = New-OfflinePrivatePath
    $script:rollbackStage = $null
    $script:rollbackEvidence = $null
    $script:cleanupApproved = $false
    $ops = @{
        VerifyBaseline = { Assert-OfflineBaseline 'v2' }
        Prepare = { Prepare-OfflineStaging $script:v1Backup }
        Replace = {
            Assert-OfflineBaseline 'v2'
            Invoke-OfflineFileSwap -StagedPath $script:prepared -TargetPath $script:protectedRunner -EvidencePath $script:replacedV2
        }
        VerifyV1 = {
            $now = Get-OfflineTaskSnapshot
            Assert-Offline ($now.TaskXml -ceq $script:baseline.TaskXml) 'Task changed during v1 restoration.'
            Assert-PortVacant
            Assert-Offline ((Get-TrustedRunnerVersion) -ceq 'v1') 'Offline v1 runner or protected backup failed verification.'
        }
        RestoreV2 = { Restore-OriginalV2 }
        VerifyV2 = { Assert-OfflineBaseline 'v2' }
    }
    try {
        $result = Invoke-OfflineRestoreTransaction -Operations $ops
        Assert-Offline ($result -ceq 'restored') 'Unexpected offline restore transaction result.'
        $script:cleanupApproved = $true
        Write-Output 'OFFLINE V1 RESTORE VERIFIED: exact v1 bytes installed; original v1 backup preserved; named task still Ready.'
        Write-Output 'No task was started. Run -StartV1Task separately only after reviewing restoration evidence.'
    } catch {
        if ($_.Exception.Message -match 'ROLLED BACK') { $script:cleanupApproved = $true }
        throw
    } finally {
        if ($script:cleanupApproved) {
            foreach ($temp in @($script:prepared,$script:replacedV2,$script:rollbackStage,$script:rollbackEvidence)) {
                if ($temp -and (Test-Path -LiteralPath $temp -PathType Leaf)) {
                    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
    return
}

# Separate explicit recovery operation: only the existing, verified named
# S4U task may be started, and only after its v1 bytes are already installed.
Assert-Offline ($installedVersion -ceq 'v1') 'StartV1Task requires previously verified v1 bytes on disk.'
Assert-Offline (Test-Path -LiteralPath $script:postcheck -PathType Leaf) 'Independent auth postcheck unavailable.'
$startOps = @{
    VerifyReady = { Assert-OfflineBaseline 'v1' }
    StartNamedTask = {
        Assert-OfflineBaseline 'v1'
        Start-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
    }
    VerifyHealthy = {
        $healthy = $false
        for ($attempt = 0; $attempt -lt 45; $attempt++) {
            try {
                $task = Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
                if ($task.State -eq 'Running') {
                    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
                    if ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') {
                        & $script:postcheck | Out-Null
                        $healthy = $true
                        break
                    }
                }
            } catch { }
            Start-Sleep -Seconds 2
        }
        Assert-Offline $healthy 'Original v1 task failed independent readiness or S4U ownership verification after explicit start.'
    }
}
$started = Invoke-OfflineStartTransaction -Operations $startOps
Assert-Offline ($started -ceq 'healthy') 'Offline named-task start did not return verified health.'
Write-Output 'OFFLINE V1 TASK START VERIFIED: exact original S4U task and independent auth postcheck passed.'
