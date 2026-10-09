<#
.SYNOPSIS
  Read-only scheduled-task and process supervision assessment on Vaulter.
.DESCRIPTION
  Reports only coarse task classifications, enabled trigger types, login
  requirements and restart settings. Does not display task action arguments,
  service account names, command lines, environment variables or secrets.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-TaskRole($Task) {
    # Never return or print action data: these may include credentials.
    $actionText = (@($Task.Actions | ForEach-Object {
        ([string]$_.Execute + ' ' + [string]$_.Arguments)
    }) -join ' ')
    $auth = $actionText -match '(?i)(?:\btether-auth\b|[\\/]auth[\\/]dist[\\/]cli\.js)'
    $relay = $actionText -match '(?i)(?:\btether-relay\b|[\\/]relay[\\/]dist[\\/]cli\.js)'
    if ($auth -and $relay) { return 'mixed' }
    if ($auth) { return 'auth' }
    if ($relay) { return 'relay' }
    return 'unclassified'
}

function Get-TaskTriggerSummary($Task) {
    $types = @(
        foreach ($trigger in @($Task.Triggers)) {
            if ($null -eq $trigger) { continue }
            $enabled = $trigger.PSObject.Properties['Enabled']
            if ($null -ne $enabled -and $enabled.Value -eq $false) { continue }
            $cim = $trigger.PSObject.Properties['CimClass']
            $type = ''
            if ($null -ne $cim -and $null -ne $cim.Value) {
                $className = $cim.Value.PSObject.Properties['CimClassName']
                if ($null -ne $className) { $type = [string]$className.Value }
            }
            if ($type -match 'BootTrigger$') { 'startup' }
            elseif ($type -match 'LogonTrigger$') { 'logon' }
            elseif ($type -match 'RegistrationTrigger$') { 'registration' }
            else { 'other' }
        }
    )
    if ($types.Count -eq 0) { return 'none' }
    return (($types | Sort-Object -Unique) -join ',')
}

function Get-TaskLogonSummary($Task) {
    if ($null -eq $Task -or $null -eq $Task.Principal) { return 'unknown' }
    $logon = [string]$Task.Principal.LogonType
    switch ($logon) {
        'InteractiveToken' { return 'requires-user-session' }
        'InteractiveTokenOrPassword' { return 'may-require-user-session' }
        'ServiceAccount' { return 'service-logon' }
        'S4U' { return 'noninteractive-s4u' }
        'Password' { return 'noninteractive-stored-logon' }
        default { return 'unknown' }
    }
}

function Get-ListenerProcess([int]$Port) {
    $sockets = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($sockets.Count -ne 1 -or $sockets[0].LocalAddress -cne '127.0.0.1') {
        throw "Listener port $Port is not exclusively bound to 127.0.0.1."
    }
    $observedProcessId = [int]$sockets[0].OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$observedProcessId" -ErrorAction Stop
    if ($null -eq $process -or $process.Name -ine 'node.exe') {
        throw "Listener port $Port is not owned by a Node.js process."
    }
    return $process
}

if ($env:OS -ne 'Windows_NT' -or $env:COMPUTERNAME -ine 'vaulter') {
    throw 'Read-only task supervision inspection runs only on Vaulter.'
}
$relayProcess = Get-ListenerProcess 8788
$authProcess = Get-ListenerProcess 8790
Write-Output "Listener processes: relay PID $($relayProcess.ProcessId), auth PID $($authProcess.ProcessId)."

$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $_.TaskName -match '(?i)tetherplane|tether-auth|tether-relay'
})
Write-Output "Named Tetherplane scheduled-task candidates: $($tasks.Count)"

$index = 0
foreach ($task in $tasks) {
    $index += 1
    $kind = Get-TaskRole $task
    $triggers = Get-TaskTriggerSummary $task
    $logon = Get-TaskLogonSummary $task
    $isEnabled = [string]($task.State -ne 'Disabled')
    $state = [string]$task.State
    $settings = $task.Settings

    $startWhenAvailable = 'unknown'
    $restartCount = 'unknown'
    $executionLimit = 'unknown'
    if ($null -ne $settings) {
        $available = $settings.PSObject.Properties['StartWhenAvailable']
        if ($null -ne $available) { $startWhenAvailable = [string][bool]$available.Value }
        $restarts = $settings.PSObject.Properties['RestartCount']
        if ($null -ne $restarts) { $restartCount = [string]$restarts.Value }
        $limit = $settings.PSObject.Properties['ExecutionTimeLimit']
        if ($null -ne $limit) {
            $rawLimit = [string]$limit.Value
            $executionLimit = if ($rawLimit -in @('PT0S', '00:00:00')) {
                'unlimited'
            } elseif (-not $rawLimit) {
                'not-set'
            } else {
                'limited'
            }
        }
    }

    $lastResult = 'unavailable'
    try {
        $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
        $lastResult = if ([int64]$info.LastTaskResult -eq 0) { 'success-or-never-run' }
                      else { 'nonzero' }
    } catch {
        $lastResult = 'unavailable'
    }

    # No task names, action strings, command lines or user identities are shown.
    Write-Output ("Candidate {0}: role={1}; state={2}; enabled={3}; triggers={4}; logon={5}" -f
        $index, $kind, $state, $isEnabled, $triggers, $logon)
    Write-Output ("Candidate {0}: restartCount={1}; startWhenAvailable={2}; executionTimeLimit={3}; lastResult={4}" -f
        $index, $restartCount, $startWhenAvailable, $executionLimit, $lastResult)
}
Write-Output 'Task settings are not proof that either running Node process is supervised or will survive reboot.'
Write-Output 'This is not proof that paired devices are online; verify device-assisted login separately.'
Write-Output 'No changes made. Do not print scheduled-task action arguments or process command lines.'
