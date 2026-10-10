<#
.SYNOPSIS
  Read-only Tetherplane Relay Task Scheduler recovery forensics on Vaulter.
.DESCRIPTION
  Reads only currently running task metadata, a sanitized 6-hour Scheduler
  Operational history and its numeric action exit codes. Requires the existing
  independent postcheck. No event XML, event descriptions, process arguments,
  identities, or credentials are printed or saved.
#>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Assert-Forensics([bool]$Condition,[string]$Reason){
  if(-not $Condition){throw $Reason}
}
function Format-SchedulerResult {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][long]$Code)
  $unsigned=[uint32]($Code -band 4294967295)
  return ('0x{0:X8}' -f $unsigned)
}
function Convert-RelayTaskEvent {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)]$Record,
    [Parameter(Mandatory=$true)][string]$ExactTaskName
  )
  try {
    [xml]$xml=$Record.ToXml()
    # Exact task name is mandatory: never confuse with human-owned tasks.
    $name=$xml.SelectSingleNode(
      "//*[local-name()='EventData']/*[local-name()='Data' and @Name='TaskName']"
    )
    if($null -eq $name -or $name.InnerText -ine $ExactTaskName){
      return $null
    }
    $code='not-present'
    $codeNode=$xml.SelectSingleNode(
      "//*[local-name()='EventData']/*[local-name()='Data' and (@Name='ResultCode' or @Name='ErrorCode')]"
    )
    if($null -ne $codeNode){
      $raw=([string]$codeNode.InnerText).Trim()
      if($raw -match '^0[xX]([0-9a-fA-F]{1,8})$'){
        $code=Format-SchedulerResult -Code ([Convert]::ToInt64($matches[1],16))
      }elseif($raw -match '^-?[0-9]{1,11}$'){
        $code=Format-SchedulerResult -Code ([long]::Parse($raw))
      }
    }
    $tag='none'
    $instanceNode=$xml.SelectSingleNode(
      "//*[local-name()='EventData']/*[local-name()='Data' and (@Name='TaskInstanceId' or @Name='InstanceId')]"
    )
    if($null -ne $instanceNode){
      $raw=([string]$instanceNode.InnerText).Trim()
      if($raw -match '^\{?([0-9a-fA-F]{8})-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$'){
        $tag=$matches[1].ToLowerInvariant()
      }
    }
    return [pscustomobject]@{
      SeenAt=([datetime]$Record.TimeCreated).ToString('yyyy-MM-dd HH:mm:ss')
      EventId=[int]$Record.Id
      ResultCode=$code
      InstanceTag=$tag
    }
  }catch{
    # Never disclose event payloads when an unfamiliar schema is encountered.
    return $null
  }
}

Assert-Forensics ($env:OS -eq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'VAULTER') 'Vaulter only.'
$postcheck=Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1'
Assert-Forensics (Test-Path -LiteralPath $postcheck -PathType Leaf) 'Independent postcheck script missing.'
& $postcheck | Out-Null

$taskName='Tetherplane Relay'
$task=Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction Stop
$info=Get-ScheduledTaskInfo -TaskPath '\' -TaskName $taskName -ErrorAction Stop
Assert-Forensics ($task.State -eq 'Running' -and [bool]$task.Settings.Enabled -and
  [string]$task.Principal.LogonType -ceq 'Interactive') 'Registered relay task baseline not running or unexpected.'
Assert-Forensics ([int]$task.Settings.RestartCount -eq 10 -and
  [string]$task.Settings.RestartInterval -ceq 'PT1M') 'Corrected relay restart policy changed.'
$lastResult=Format-SchedulerResult -Code ([long]$info.LastTaskResult)
$lastRun='unknown'
if($null -ne $info.LastRunTime){
  $lastRun=([datetime]$info.LastRunTime).ToString('yyyy-MM-dd HH:mm:ss')
}
Write-Output 'RELAY RESTART FORENSICS: current task and independent health verification PASSED.'
Write-Output ('Task=Running; principal=Interactive; restart_count={0}; restart_interval={1}' -f
  [int]$task.Settings.RestartCount,[string]$task.Settings.RestartInterval)
Write-Output ('Current task last_result={0}; current last_run_local={1}' -f $lastResult,$lastRun)
Write-Output 'Current result describes the latest task instance, not necessarily the failed rehearsal.'

$logName='Microsoft-Windows-TaskScheduler/Operational'
$history='history unavailable'
$matched=New-Object 'System.Collections.Generic.List[object]'
try {
  $logInfo=Get-WinEvent -ListLog $logName -ErrorAction Stop
  if([bool]$logInfo.IsEnabled){
    $history='enabled'
    # Bound read and output; no raw task data is emitted.
    $records=@(Get-WinEvent -FilterHashtable @{
      LogName=$logName
      StartTime=(Get-Date).AddHours(-6)
    } -MaxEvents 1800 -ErrorAction Stop)
    foreach($rec in $records){
      $safe=Convert-RelayTaskEvent -Record $rec -ExactTaskName '\Tetherplane Relay'
      if($null -ne $safe){$matched.Add($safe)}
    }
  }
}catch{
  $history='history unavailable'
}
Write-Output ('Task Scheduler Operational event channel: {0}' -f $history)
if($matched.Count -eq 0){
  Write-Output 'No attributable Task Scheduler history in the bounded lookback; cause cannot be determined from this log.'
}else{
  Write-Output ('Attributed task history events: {0} (6 hours, last 36 shown, scanned at most 1800 records).' -f $matched.Count)
  foreach($evt in @($matched | Sort-Object SeenAt | Select-Object -Last 36)){
    Write-Output ('  at={0}; event_id={1}; result_code={2}; instance={3}' -f
      $evt.SeenAt,$evt.EventId,$evt.ResultCode,$evt.InstanceTag)
  }
}
Write-Output 'No changes made. EventXml, user identities, task action arguments and credentials not printed.'
