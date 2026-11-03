# READ-ONLY check for whether the November 1 live Leno agent can be preserved.
# No task action, credential, service, binary, login or Windows security changes.
# No raw task XML, command line, arguments-file contents, paths or credentials printed.
[CmdletBinding()]
param(
  [string]$ExpectedInstalledAgentSHA256 = '411E0F07F32CA3E6CF69A5CA53F3995E268946DF419600BF0C807D737D00895C'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$taskName='Tetherplane Private Agent NoConsole 20261101'
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$taskInfo=Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
$actions=@($task.Actions)
if($actions.Count -ne 1){throw 'ACTIVE_AGENT_TASK_ACTION_COUNT_UNEXPECTED'}
$action=$actions[0]
$target=[Environment]::ExpandEnvironmentVariables($action.Execute.Trim('"'))
$targetName=Split-Path -Leaf $target
$binaryExists=(Test-Path -LiteralPath $target -PathType Leaf)
$binaryHashOK=$false
$binaryRegular=$false
if($binaryExists) {
    $meta=Get-Item -LiteralPath $target
    $binaryRegular=(($meta.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
    $binaryHashOK=((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ieq $ExpectedInstalledAgentSHA256)
}
$launcherArguments=$action.Arguments
# Match only the current private launcher contract; never emit the path.
$match=[regex]::Match($launcherArguments, '^--arguments-file\s+(?:"([^"]+)"|([^\s]+))$')
$singleArgumentFile=$match.Success
$argumentsFileExists=$false
$argumentsFileRegular=$false
$argumentsFileShapeKnown=$false
if($singleArgumentFile) {
    $argumentsPath=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
    if([IO.Path]::IsPathRooted($argumentsPath) -and
       (Test-Path -LiteralPath $argumentsPath -PathType Leaf)){
        $info=Get-Item -LiteralPath $argumentsPath
        $argumentsFileExists=$true
        $argumentsFileRegular=(($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
        # The user's protected file contents are neither read nor copied.
        $argumentsFileShapeKnown=$false
    }
}
$agentProcesses=@(Get-CimInstance Win32_Process -Filter "Name='tetherd-agentw.exe'" |
    Where-Object {$_.ExecutablePath -ieq $target})
$processCount=$agentProcesses.Count
$taskState=[string]$task.State
$activeReady=($binaryExists -and $binaryRegular -and $binaryHashOK -and $singleArgumentFile -and
    $argumentsFileExists -and $argumentsFileRegular -and $processCount -eq 1 -and
    $taskState -eq 'Running')
$tasks=@('Tetherplane Leno Canary Rollback','Tetherplane Leno Canary Rollback V2')
$oldRollbackTasks=@($tasks|Where-Object{Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue})
$rollbackProven=$false
# A task named 'Rollback' is NOT evidence of restoring the currently active agent.
$report=[ordered]@{
    AuditType='read-only'
    ActiveTask=$taskName
    TaskState=$taskState
    LastTaskResult=$taskInfo.LastTaskResult
    AgentBinaryName=$targetName
    MatchingLiveAgentProcesses=$processCount
    OriginalBinaryPresent=$binaryExists
    OriginalBinaryNonReparsePoint=$binaryRegular
    OriginalBinarySha256Verified=$binaryHashOK
    SinglePrivateArgumentsFileSwitch=$singleArgumentFile
    ProtectedArgumentsFilePresent=$argumentsFileExists
    ProtectedArgumentsFileNonReparsePoint=$argumentsFileRegular
    ProtectedArgumentsFileContentsRead=$false
    ProtectedArgumentsFileShapeVerified=$argumentsFileShapeKnown
    CurrentAgentBaselinePreserved=$activeReady
    LegacyRollbackTaskCount=$oldRollbackTasks.Count
    IndependentRollbackExercisePassed=$rollbackProven
    IndependentSecondaryControlPathVerified=$false
    ProtectedAgentReplacementApproved=$false
    SafeToReplaceLiveAgent=$false
}
$report|ConvertTo-Json -Compress
if(-not $activeReady){throw 'ACTIVE_AGENT_BASELINE_NOT_READY: no protected changes made'}
Write-Output 'READ_ONLY_LENO_AGENT_BASELINE_PASSED'
Write-Output 'REAL_DEVICE_REPLACEMENT_NO_GO_UNTIL_INDEPENDENT_ROLLBACK_VERIFIED'
