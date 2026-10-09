<#
.SYNOPSIS
  Inspect or repair only the RestartOnFailure/Count for Vaulter's S4U auth task.
.DESCRIPTION
  Default is read-only. -Apply changes RestartCount 999 to 10, preserving the
  existing PT1M interval, action, principal, trigger, state, and running service.
  A private copy of the prior task XML is kept under protected auth state.
  Automatic recovery is not verified until a separate live restart rehearsal.
#>
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:taskName = 'Tetherplane-TetherAuth-Startup'
$script:taskPath = '\'
$script:stateDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:postcheck = Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1'
$script:desiredCount = 10
$script:expectedOldCount = 999

function Assert-Repair([bool]$Condition,[string]$Reason) {
    if (-not $Condition) { throw $Reason }
}
function Test-RestartCountRange {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][int]$Count)
    return ($Count -ge 1 -and $Count -le 255)
}
function Get-RestartNode([xml]$Xml) {
    $node = $Xml.SelectSingleNode(
        "//*[local-name()='Settings']/*[local-name()='RestartOnFailure']"
    )
    if ($null -eq $node) { return $null }
    return $node.SelectSingleNode("*[local-name()='Count']")
}
function Test-OnlyRestartCountChanged {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$BeforeXml,
        [Parameter(Mandatory=$true)][string]$AfterXml,
        [Parameter(Mandatory=$true)][int]$OldCount,
        [Parameter(Mandatory=$true)][int]$NewCount
    )
    try {
        [xml]$before = $BeforeXml
        [xml]$after = $AfterXml
        $priorNode = Get-RestartNode $before
        $laterNode = Get-RestartNode $after
        if ($null -eq $priorNode -or $null -eq $laterNode -or
            [string]$priorNode.InnerText -cne [string]$OldCount -or
            [string]$laterNode.InnerText -cne [string]$NewCount) {
            return $false
        }
        # Compare settings, action paths, owner, triggers, and other metadata
        # in memory without ever outputting the stored task XML.
        $laterNode.InnerText = $priorNode.InnerText
        return ($before.DocumentElement.OuterXml -ceq $after.DocumentElement.OuterXml)
    } catch { return $false }
}
function Invoke-GuardedSettingsCorrection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][hashtable]$Operations,
        [Parameter(Mandatory=$true)][int]$OriginalCount
    )
    foreach ($name in @(
        'VerifyBefore','BackupTask','ApplyCount','VerifyAfter',
        'RestorePrior','VerifyRestored'
    )) {
        if (-not $Operations.ContainsKey($name) -or
            -not ($Operations[$name] -is [scriptblock])) {
            throw 'Missing restart settings repair operation.'
        }
    }
    # Never modify the task if the baseline or private backup fails.
    & $Operations['VerifyBefore']
    & $Operations['BackupTask']
    try {
        & $Operations['ApplyCount']
        & $Operations['VerifyAfter']
        return 'corrected'
    } catch {
        # An invalid original count cannot safely be written back. Verify
        # unchanged state read-only instead; if it changed, stop for recovery.
        if (-not (Test-RestartCountRange -Count $OriginalCount)) {
            try {
                & $Operations['VerifyRestored']
            } catch {
                throw 'Restart settings REPAIR FAILED; ROLLBACK UNAVAILABLE for invalid original count. State unverified. Do not repeat or reboot.'
            }
            throw 'Restart settings REPAIR FAILED; NO CHANGE VERIFIED. Invalid original definition remains. Do not repeat or reboot.'
        }
        try {
            & $Operations['RestorePrior']
            & $Operations['VerifyRestored']
        } catch {
            throw 'Restart settings REPAIR FAILED; ROLLBACK UNVERIFIED. Do not repeat or reboot. Inspect live auth and saved private task definition.'
        }
        throw 'Restart settings REPAIR FAILED; ROLLED BACK original task definition. Do not repeat or reboot.'
    }
}
function Get-Task {
    Get-ScheduledTask -TaskName $script:taskName -TaskPath $script:taskPath -ErrorAction Stop
}
function Get-TaskXml {
    [string](Export-ScheduledTask -TaskName $script:taskName -TaskPath $script:taskPath -ErrorAction Stop)
}
function Get-AuthPid {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
    Assert-Repair ($listeners.Count -eq 1 -and
        $listeners[0].LocalAddress -ceq '127.0.0.1') 'Auth must have one loopback-only listener.'
    return [int]$listeners[0].OwningProcess
}
function Verify-TaskHealthy {
    # Independent test covers S4U identity, protected runner hash, child
    # ownership, OAuth health, public keys, Auth0 and all private Tailscale ports.
    & $script:postcheck | Out-Null
    Assert-Repair ((Get-Task).State -eq 'Running') 'S4U auth task must remain running.'
    Assert-Repair ((Get-AuthPid) -eq $script:baselinePid) 'Task settings must not replace the running auth process.'
}
function Read-RestartValues {
    [xml]$taskXml = Get-TaskXml
    $restart = $taskXml.SelectSingleNode(
        "//*[local-name()='Settings']/*[local-name()='RestartOnFailure']"
    )
    Assert-Repair ($null -ne $restart) 'Registered restart policy is missing.'
    $countNode = Get-RestartNode $taskXml
    $intervalNode = $restart.SelectSingleNode("*[local-name()='Interval']")
    Assert-Repair ($null -ne $countNode -and $null -ne $intervalNode) 'Task restart count or interval missing.'
    return [pscustomobject]@{
        Count = [int]$countNode.InnerText
        Interval = [string]$intervalNode.InnerText
    }
}

Assert-Repair ($env:OS -eq 'Windows_NT' -and
    $env:COMPUTERNAME -ieq 'vaulter') 'Task repair is restricted to Vaulter.'
Assert-Repair (Test-Path -LiteralPath $script:postcheck -PathType Leaf) 'Independent auth postcheck missing.'
Assert-Repair (Test-Path -LiteralPath $script:stateDir -PathType Container) 'Protected auth state missing.'
Assert-Repair ((Get-Acl -LiteralPath $script:stateDir).AreAccessRulesProtected) 'Auth-state ACL is not protected.'
$task = Get-Task
$beforeSettings = $task.Settings
$beforeXml = Get-TaskXml
$before = Read-RestartValues
Assert-Repair ($task.State -eq 'Running' -and
    [string]$task.Principal.LogonType -ceq 'S4U') 'S4U task must be running.'
Assert-Repair ($before.Interval -ceq 'PT1M') 'Restart interval changed unexpectedly.'
Assert-Repair ([int]$beforeSettings.RestartCount -eq $before.Count) 'Task XML and CIM restart counts disagree.'
Assert-Repair ([string]$beforeSettings.RestartInterval -ceq $before.Interval) 'Task XML and CIM restart intervals disagree.'
$script:baselinePid = Get-AuthPid
Verify-TaskHealthy

if (Test-RestartCountRange -Count $before.Count) {
    Write-Output "RESTART SETTINGS ALREADY VALID: count=$($before.Count); interval=$($before.Interval); listener PID unchanged."
    Write-Output 'No changes made. Automatic restart still needs a separate live test.'
    return
}
Assert-Repair ($before.Count -eq $script:expectedOldCount) 'Unexpected invalid restart count; no changes made.'
Assert-Repair (Test-RestartCountRange -Count $script:desiredCount) 'Desired restart count outside schema.'

if (-not $Apply) {
    Write-Output "RESTART SETTINGS PREFLIGHT PASS: current=$($before.Count); desired=$script:desiredCount; interval=$($before.Interval); task=Running."
    Write-Output 'No changes made. Use -Apply separately to change only the task retry count.'
    return
}

$script:baselineXml = $beforeXml
$script:baselineCount = [int]$before.Count
$script:backupFile = Join-Path $script:stateDir ("auth-task-restart-before-{0}.xml" -f [Guid]::NewGuid().ToString('N'))
$operations = @{
    VerifyBefore = {
        Verify-TaskHealthy
        $latest = Read-RestartValues
        Assert-Repair ($latest.Count -eq $script:baselineCount -and
            $latest.Interval -ceq 'PT1M' -and
            (Get-TaskXml) -ceq $script:baselineXml) 'Task changed since preflight.'
    }
    BackupTask = {
        Assert-Repair (-not (Test-Path -LiteralPath $script:backupFile)) 'Backup collision, refusing overwrite.'
        # The XML may contain protected task action paths and account IDs.
        # Store it only under the existing private directory; never print it.
        [IO.File]::WriteAllText(
            $script:backupFile, $script:baselineXml, [System.Text.UTF8Encoding]::new($false)
        )
        Assert-Repair ([IO.File]::ReadAllText($script:backupFile) -ceq $script:baselineXml) 'Private backup could not be verified.'
    }
    ApplyCount = {
        # Edit only the original CIM settings object; preserve all other
        # flags and do not re-register or touch the running auth instance.
        $current = Get-Task
        $current.Settings.RestartCount = $script:desiredCount
        Set-ScheduledTask -TaskName $script:taskName -TaskPath $script:taskPath `
            -Settings $current.Settings -ErrorAction Stop | Out-Null
    }
    VerifyAfter = {
        $latest = Read-RestartValues
        Assert-Repair (
            $latest.Count -eq $script:desiredCount -and
            $latest.Interval -ceq 'PT1M' -and
            (Test-OnlyRestartCountChanged -BeforeXml $script:baselineXml `
                -AfterXml (Get-TaskXml) -OldCount $script:baselineCount `
                -NewCount $script:desiredCount)
        ) 'Task changed beyond the approved restart count.'
        Verify-TaskHealthy
    }
    RestorePrior = {
        $current = Get-Task
        $current.Settings.RestartCount = $script:baselineCount
        Set-ScheduledTask -TaskName $script:taskName -TaskPath $script:taskPath `
            -Settings $current.Settings -ErrorAction Stop | Out-Null
    }
    VerifyRestored = {
        $latest = Read-RestartValues
        Assert-Repair ($latest.Count -eq $script:baselineCount -and
            $latest.Interval -ceq 'PT1M' -and
            (Get-TaskXml) -ceq $script:baselineXml) 'Original task settings not restored.'
        Verify-TaskHealthy
    }
}
$status = Invoke-GuardedSettingsCorrection -Operations $operations -OriginalCount $script:baselineCount
Assert-Repair ($status -ceq 'corrected') 'Unexpected repair status.'
Write-Output "RESTART SETTINGS CORRECTED: count=$script:desiredCount; interval=PT1M; original auth PID=$script:baselinePid unchanged."
Write-Output 'No task actions, principals or triggers changed. Original task definition backed up privately.'
Write-Output 'Automatic restart UNVERIFIED pending a separate controlled recovery exercise.'
