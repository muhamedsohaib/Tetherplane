# Read-only post-reboot startup classification. Never emits task arguments,
# credential references, local paths, endpoints, user IDs or event messages.
# This is NOT a signed-release, local-execution, or authenticated-MCP test.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$record = [ordered]@{
    schema = 'tetherplane-leno-reboot-admission-v1'
    evidence = 'LOCAL_READ_ONLY_NOT_REMOTE_ACCEPTANCE'
    agent_process_count = 'UNAVAILABLE'
    task_state = 'UNAVAILABLE'
    task_last_result = 'UNAVAILABLE'
    action_class = 'UNAVAILABLE'
    relay_argument = 'UNAVAILABLE'
    device_argument = 'UNAVAILABLE'
    credential_argument = 'UNAVAILABLE'
    device_id_class = 'UNAVAILABLE'
    executable_signature = 'UNAVAILABLE'
    sac_policy_raw = 'UNAVAILABLE'
    code_integrity_query = 'UNAVAILABLE'
    post_boot_block_count = 'UNAVAILABLE'
    verdict = 'INCONCLUSIVE'
    findings = @()
    note = 'No local task, process, credentials or Windows security settings changed. Remote authorization and SAC execution remain unverified.'
}
$findings = New-Object System.Collections.Generic.List[string]

try {
    $agents = @(Get-CimInstance Win32_Process -Filter "Name = 'tetherd.exe'" -ErrorAction Stop)
    $record.agent_process_count = [string]$agents.Count
} catch {}

try {
    $task = Get-ScheduledTask -TaskName 'Tetherplane Leno Canary' -ErrorAction Stop
    if ($null -eq $task) { throw 'missing task' }
    $record.task_state = [string]$task.State
    try {
        $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
        $record.task_last_result = [string]$info.LastTaskResult
    } catch {}
    $actions = @($task.Actions)
    if ($actions.Count -eq 1) {
        $action = $actions[0]
        $exe = ([string]$action.Execute).Trim('"')
        if ([IO.Path]::GetFileName($exe) -ieq 'tetherd.exe') {
            $record.action_class = 'TETHERD_DIRECT'
            $argsText = [string]$action.Arguments
            foreach ($item in @(
                @{ name='--relay-url'; key='relay_argument' },
                @{ name='--device-id'; key='device_argument' },
                @{ name='--device-credential-file'; key='credential_argument' }
            )) {
                $pattern = '(?i)(?:^|\s)' + [regex]::Escape([string]$item.name) + '(?=\s|=)'
                $record[$item.key] = if ($argsText -match $pattern) { 'PRESENT' } else { 'MISSING' }
            }
            $idMatch = [regex]::Match($argsText, '(?i)(?:^|\s)--device-id(?:\s+|=)(?:"([^"]+)"|([^\s]+))')
            $idText = if ($idMatch.Groups[1].Success) { $idMatch.Groups[1].Value } else { $idMatch.Groups[2].Value }
            $record.device_id_class = if ($record.device_argument -ne 'PRESENT') { 'MISSING' }
                elseif ($idText -ceq 'Leno') { 'EXACT_LENO' }
                elseif ($idText -ieq 'Leno') { 'CASE_ONLY_MISMATCH' }
                else { 'OTHER_OR_UNKNOWN_REDACTED' }
            try {
                $record.executable_signature = [string](Get-AuthenticodeSignature -LiteralPath $exe -ErrorAction Stop).Status
            } catch { $record.executable_signature = 'UNREADABLE_OR_NOT_FOUND' }
        } else { $record.action_class = 'WRAPPER_OR_OTHER' }
    } else { $record.action_class = 'NON_SINGLE_ACTION' }
} catch { $record.task_state = 'MISSING_OR_NOT_READABLE' }

try {
    $policy = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name 'VerifiedAndReputablePolicyState' -ErrorAction Stop
    $record.sac_policy_raw = [string]$policy.VerifiedAndReputablePolicyState
} catch {}

try {
    $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
    $events = @(Get-WinEvent -FilterHashtable @{
        LogName = 'Microsoft-Windows-CodeIntegrity/Operational'
        Id = 3077
        StartTime = $boot
    } -MaxEvents 100 -ErrorAction Stop)
    $record.post_boot_block_count = [string]@($events | Where-Object {
        [string]$_.Message -match '(?i)tetherd[.]exe'
    }).Count
    $record.code_integrity_query = 'BOUNDED_100_SINCE_BOOT'
} catch {
    $record.code_integrity_query = 'NO_EVENTS_OR_ACCESS_DENIED'
}

if ($record.agent_process_count -eq '0') { $findings.Add('AGENT_NOT_RUNNING') }
if ($record.agent_process_count -eq 'UNAVAILABLE') { $findings.Add('AGENT_PROCESS_QUERY_UNAVAILABLE') }
if ($record.task_state -eq 'MISSING_OR_NOT_READABLE') { $findings.Add('CANARY_TASK_NOT_READABLE') }
if ($record.action_class -eq 'TETHERD_DIRECT') {
    if ($record.relay_argument -ne 'PRESENT' -or
        $record.device_argument -ne 'PRESENT' -or
        $record.credential_argument -ne 'PRESENT') {
        $findings.Add('CANARY_REMOTE_ARGUMENTS_MISSING')
    }
    if ($record.device_id_class -ne 'EXACT_LENO' -and
        $record.device_id_class -ne 'MISSING') {
        $findings.Add('CANARY_DEVICE_ID_UNVERIFIED')
    }
}
if ($record.sac_policy_raw -eq '1' -and
    $record.executable_signature -ne 'Valid') {
    $findings.Add('SAC_ON_NATIVE_TRUST_NOT_VERIFIED')
}
if ($record.task_last_result -ne '0' -and
    $record.task_last_result -ne 'UNAVAILABLE') {
    $findings.Add('CANARY_LAST_EXECUTION_NONZERO')
}
if ($findings.Count -gt 0) { $record.verdict = 'NO_GO' }
$record.findings = @($findings.ToArray())
[pscustomobject]$record | ConvertTo-Json -Compress -Depth 5
