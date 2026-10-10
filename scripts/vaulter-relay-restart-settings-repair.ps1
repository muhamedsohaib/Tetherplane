<#
.SYNOPSIS
  Inspect or correct the registered retry count for Vaulter's Interactive Tetherplane Relay task.
.DESCRIPTION
  Read-only by default. -Apply changes only RestartCount from 999 to 10,
  retaining the PT1M interval, task action, principal, logon trigger, 
  running Node process, device registry and original Auth0 configuration.
  Backups are stored in protected local auth state. Recovery remains unproven
  until a separate controlled crash/restart rehearsal.
#>
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:taskName = 'Tetherplane Relay'
$script:taskPath = '\'
$script:stateDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:expectedRunnerHash='5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8'
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
            throw 'Restart settings REPAIR FAILED; ROLLBACK UNVERIFIED. Do not repeat or reboot. Inspect live relay and saved private task definition.'
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
$script:baselineNodeCreated=$null
$script:baselineParentCreated=$null
function Get-RelayPid {
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue)
    Assert-Repair ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1') 'Relay must have one loopback-only listener.'
    $child=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$listeners[0].OwningProcess) -ErrorAction Stop
    Assert-Repair ($null -ne $child -and $child.Name -ieq 'node.exe') 'Relay listener is not owned by the expected Node process.'
    $parent=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$child.ParentProcessId) -ErrorAction Stop
    Assert-Repair ($null -ne $parent -and $parent.Name -ieq 'powershell.exe') 'Relay Node parent must be PowerShell.'
    $task=Get-Task
    Assert-Repair (@($task.Actions).Count -eq 1 -and
        ([IO.Path]::GetFileName([string]$task.Actions[0].Execute) -ieq 'powershell.exe')) 'Relay task action differs.'
    $m=[regex]::Match([string]$task.Actions[0].Arguments,
        '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
    Assert-Repair ($m.Success) 'Relay task launcher path missing.'
    $runner=@($m.Groups[1].Value,$m.Groups[2].Value,$m.Groups[3].Value) |
        Where-Object { -not [string]::IsNullOrEmpty($_) } | Select-Object -First 1
    $runner=[Environment]::ExpandEnvironmentVariables([string]$runner)
    Assert-Repair (Test-Path -LiteralPath $runner -PathType Leaf) 'Relay launcher path unavailable.'
    Assert-Repair ((Get-FileHash -LiteralPath $runner -Algorithm SHA256 -ErrorAction Stop).Hash -ceq $script:expectedRunnerHash) 'Relay launcher hash unexpectedly changed.'
    Assert-Repair ([string]$parent.CommandLine -like ('*' + $runner + '*')) 'Relay child parent does not match the registered task launcher.'
    if ($null -eq $script:baselineNodeCreated) {
        $script:baselineNodeCreated=[string]$child.CreationDate
        $script:baselineParentCreated=[string]$parent.CreationDate
    } else {
        Assert-Repair ([string]$child.CreationDate -ceq $script:baselineNodeCreated -and
            [string]$parent.CreationDate -ceq $script:baselineParentCreated) 'Relay process identity changed during settings-only inspection.'
    }
    return [int]$listeners[0].OwningProcess
}
function Verify-TaskHealthy {
    $task=Get-Task
    Assert-Repair ($task.State -eq 'Running' -and [bool]$task.Settings.Enabled -and
        [string]$task.Principal.LogonType -ceq 'Interactive') 'Original interactive relay task is not running.'
    Assert-Repair ((Get-RelayPid) -eq $script:baselinePid) 'Relay task settings must not replace its running Node child.'
    $health=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 10 -ErrorAction Stop
    Assert-Repair ($health.status -ceq 'ok') 'Local relay health failed.'
    $metadata=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/.well-known/oauth-protected-resource/mcp' -TimeoutSec 10 -ErrorAction Stop
    Assert-Repair (@($metadata.authorization_servers).Count -eq 1 -and
        @($metadata.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Auth0-backed MCP protected resource changed.'
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
Assert-Repair (Test-Path -LiteralPath $script:stateDir -PathType Container) 'Protected rollback state missing.'
Assert-Repair ((Get-Acl -LiteralPath $script:stateDir).AreAccessRulesProtected) 'Protected rollback directory ACL is not protected.'
$task = Get-Task
$beforeSettings = $task.Settings
$beforeXml = Get-TaskXml
$before = Read-RestartValues
Assert-Repair ($task.State -eq 'Running' -and
    [string]$task.Principal.LogonType -ceq 'Interactive') 'Interactive relay task must be running.'
Assert-Repair ($before.Interval -ceq 'PT1M') 'Restart interval changed unexpectedly.'
Assert-Repair ([int]$beforeSettings.RestartCount -eq $before.Count) 'Task XML and CIM restart counts disagree.'
Assert-Repair ([string]$beforeSettings.RestartInterval -ceq $before.Interval) 'Task XML and CIM restart intervals disagree.'
$script:baselinePid = Get-RelayPid
Verify-TaskHealthy

if (Test-RestartCountRange -Count $before.Count) {
    Write-Output "RELAY RESTART SETTINGS ALREADY VALID: count=$($before.Count); interval=$($before.Interval); listener PID unchanged."
    Write-Output 'No changes made. Automatic restart still needs a separate live test.'
    return
}
Assert-Repair ($before.Count -eq $script:expectedOldCount) 'Unexpected invalid restart count; no changes made.'
Assert-Repair (Test-RestartCountRange -Count $script:desiredCount) 'Desired restart count outside schema.'

if (-not $Apply) {
    Write-Output "RELAY RESTART SETTINGS PREFLIGHT PASS: current=$($before.Count); desired=$script:desiredCount; interval=$($before.Interval); task=Running."
    Write-Output 'No changes made. Use -Apply separately to change only the task retry count.'
    return
}

$script:baselineXml = $beforeXml
$script:baselineCount = [int]$before.Count
$script:backupFile = Join-Path $script:stateDir ("relay-task-restart-before-{0}.xml" -f [Guid]::NewGuid().ToString('N'))
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
        # flags and do not re-register or touch the running relay instance.
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
Write-Output "RELAY RESTART SETTINGS CORRECTED: count=$script:desiredCount; interval=PT1M; relay PID=$script:baselinePid unchanged."
Write-Output 'No task actions, principals or triggers changed. Original task definition backed up privately.'
Write-Output 'Automatic restart UNVERIFIED pending a separate controlled recovery exercise.'
