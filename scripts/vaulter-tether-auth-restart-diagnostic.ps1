<#
.SYNOPSIS
  Read-only Task Scheduler restart failure diagnosis on Vaulter.
.DESCRIPTION
  Requires the independently verified running S4U auth task. Reports only
  restart settings, a numeric last-task result, and a redacted recent
  TaskScheduler/Operational event timeline. It never displays EventXml,
  raw task event messages, process command lines, TaskUserId, or credentials.
  Never changes a process, service, task or Tailscale configuration.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Diagnostic([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Format-SchedulerResult {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][long]$Code)
    $unsigned = [uint32]($Code -band 4294967295)
    return ('0x{0:X8}' -f $unsigned)
}

function Convert-TaskSchedulerEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Record,
        [Parameter(Mandatory=$true)][string]$ExactTaskName
    )
    try {
        # Full XML stays local in memory. Only the exact TaskName field is
        # inspected; neither task action nor user/account data is returned.
        [xml]$xml = $Record.ToXml()
        $nameNode = $xml.SelectSingleNode(
            "//*[local-name()='EventData']/*[local-name()='Data' and @Name='TaskName']"
        )
        if ($null -eq $nameNode -or
            $nameNode.InnerText -ine $ExactTaskName) {
            return $null
        }
        $code = 'not-present'
        $codeNode = $xml.SelectSingleNode(
            "//*[local-name()='EventData']/*[local-name()='Data' and (@Name='ResultCode' or @Name='ErrorCode')]"
        )
        if ($null -ne $codeNode) {
            $raw = ([string]$codeNode.InnerText).Trim()
            if ($raw -match '^0[xX]([0-9a-fA-F]{1,8})$') {
                $code = Format-SchedulerResult -Code ([Convert]::ToInt64($matches[1], 16))
            } elseif ($raw -match '^[0-9]{1,10}$') {
                $code = Format-SchedulerResult -Code ([long]::Parse($raw))
            }
        }
        return [pscustomobject]@{
            EventId = [int]$Record.Id
            SeenAt = ([datetime]$Record.TimeCreated).ToString('yyyy-MM-dd HH:mm:ss')
            ResultCode = $code
        }
    } catch {
        # Never print raw Task Scheduler event messages or event XML.
        return $null
    }
}

Assert-Diagnostic (
    $env:OS -eq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'vaulter'
) 'Restart diagnostics are restricted to Vaulter.'
$scriptDir = $PSScriptRoot
$postcheck = Join-Path $scriptDir 'vaulter-tether-auth-supervised-postcheck.ps1'
Assert-Diagnostic (Test-Path -LiteralPath $postcheck -PathType Leaf) 'Independent supervisor postcheck missing.'

# Fail closed before inspecting event history: only diagnose the previously
# verified S4U-owned auth process. The postcheck itself is read-only.
& $postcheck | Out-Null

$taskName = 'Tetherplane-TetherAuth-Startup'
$task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
$taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\' -ErrorAction Stop

Assert-Diagnostic (
    $task.State -eq 'Running' -and
    [string]$task.Principal.LogonType -ceq 'S4U'
) 'Auth task is not running under the registered S4U logon.'

$restartCount = [int]$task.Settings.RestartCount
$restartInterval = [string]$task.Settings.RestartInterval
$lastResult = Format-SchedulerResult -Code ([long]$taskInfo.LastTaskResult)
$lastRun = if ($null -ne $taskInfo.LastRunTime) {
    ([datetime]$taskInfo.LastRunTime).ToString('yyyy-MM-dd HH:mm:ss')
} else {
    'unknown'
}

Write-Output 'AUTH RESTART DIAGNOSTIC: supervised auth currently healthy.'
Write-Output ("Task state=Running; logon=S4U; restart_count={0}; restart_interval={1}" -f
    $restartCount, $restartInterval)
Write-Output ("Task last_result={0}; last_run_local={1}" -f $lastResult, $lastRun)
if ($restartCount -gt 255) {
    Write-Output 'Restart count: out-of-schema-range (>255); inspect registered XML / Task Scheduler implementation before treating this as the cause.'
} elseif ($restartCount -le 0 -or [string]::IsNullOrWhiteSpace($restartInterval)) {
    Write-Output 'Restart policy: missing count or interval; automatic restart is not configured.'
} else {
    Write-Output 'Restart policy: numeric count is within documented schema range; outcome still requires scheduler event evidence.'
}

$logName = 'Microsoft-Windows-TaskScheduler/Operational'
$events = @()
$historyAvailable = $false
try {
    $logInfo = Get-WinEvent -ListLog $logName -ErrorAction Stop
    if ($logInfo.IsEnabled) {
        $historyAvailable = $true
        # Bound both lookback and number of records; do not read whole log.
        $records = @(Get-WinEvent -FilterHashtable @{
            LogName = $logName
            StartTime = (Get-Date).AddHours(-6)
        } -MaxEvents 1500 -ErrorAction Stop)
        foreach ($record in $records) {
            $safe = Convert-TaskSchedulerEvent -Record $record -ExactTaskName "\$taskName"
            if ($null -ne $safe) { $events += $safe }
        }
    }
} catch {
    # Lack of event logging access is a diagnostic limitation, not a reason
    # to dump privileged logs, change ACLs or enable operational history.
    $historyAvailable = $false
}
if (-not $historyAvailable) {
    Write-Output 'Task Scheduler history unavailable (disabled, empty or inaccessible).'
} elseif ($events.Count -eq 0) {
    Write-Output 'Task Scheduler history unavailable for this task in the bounded lookback.'
} else {
    $ordered = @($events | Sort-Object SeenAt)
    Write-Output ("Matching task history events (6h, bounded): {0}" -f $ordered.Count)
    foreach ($event in @($ordered | Select-Object -Last 24)) {
        Write-Output ("  at={0}; event_id={1}; result_code={2}" -f
            $event.SeenAt, $event.EventId, $event.ResultCode)
    }
}
Write-Output 'No changes made. No identities, action arguments, signing material or bridge credentials printed.'
