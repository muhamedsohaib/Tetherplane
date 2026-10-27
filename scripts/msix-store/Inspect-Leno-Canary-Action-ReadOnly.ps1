# Tetherplane Leno canary: sanitized SAVED TASK configuration, read-only.
# This is NOT proof of arguments used by the already running October 24 PID.
# Does not print credentials, file paths, hostnames, URLs, or raw task arguments.
$ErrorActionPreference = 'Stop'
function Get-SafeArgument([string]$text, [string]$name) {
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    $pattern = '(?i)(?:^|\s)' + [regex]::Escape($name) + '(?:=|\s+)(?:"([^"]*)"|([^\s]+))'
    $m = [regex]::Match($text, $pattern)
    if (-not $m.Success) { return $null }
    if ($m.Groups[1].Success) { return [string]$m.Groups[1].Value }
    return [string]$m.Groups[2].Value
}
$report = [ordered]@{
    schema = 'tetherplane-leno-canary-saved-action-v1'
    source = 'TASK_DEFINITION_NOT_RUNNING_PROCESS'
    task_read = 'UNAVAILABLE'
    actions = @()
    note = 'Task arguments can change while an older tetherd process stays running.'
}
try {
    $task = Get-ScheduledTask -TaskName 'Tetherplane Leno Canary' -ErrorAction Stop
    $report.task_read = 'OK'
    foreach ($action in @($task.Actions)) {
        $argsText = [string]$action.Arguments
        $device = Get-SafeArgument $argsText '--device-id'
        $relay = Get-SafeArgument $argsText '--relay-url'
        $credentialPath = Get-SafeArgument $argsText '--device-credential-file'
        $deviceClass = if ($null -eq $device) { 'NOT_IN_TASK' }
            elseif ($device -ceq 'Leno') { 'EXACT_LENO' }
            elseif ($device -ieq 'Leno') { 'CASE_ONLY_DIFFERENCE' }
            else { 'OTHER_ID_REDACTED' }
        $scheme = 'NOT_IN_TASK'
        $pathClass = 'NOT_IN_TASK'
        $port = 'NOT_IN_TASK'
        $hostClass = 'NOT_IN_TASK'
        if ($null -ne $relay) {
            try {
                $u = [uri]$relay
                $scheme = if ($u.Scheme -eq 'wss') { 'WSS' }
                    elseif ($u.Scheme -eq 'ws') { 'WS' }
                    else { 'OTHER' }
                $pathClass = if ($u.AbsolutePath -ceq '/device') { 'EXACT_DEVICE_PATH' }
                    else { 'OTHER_PATH' }
                $port = [string]$u.Port
                $hostClass = if ($u.Host -match '^(?i:vaulter)(?:[.]|$)') { 'VAULTER_NAME' }
                    elseif ($u.Host -match '[.]ts[.]net$') { 'TAILNET_DNS_OTHER' }
                    else { 'OTHER_REDACTED' }
            } catch {
                $scheme = 'INVALID_REDACTED_URL'
            }
        }
        $execStatus = 'UNAVAILABLE'
        $digest = 'UNAVAILABLE'
        $exe = [string]$action.Execute
        $exe = $exe.Trim('"')
        if ($exe -match '^[A-Za-z]:\\' -and $exe -match '(?i)[.]exe$') {
            try {
                if (Test-Path -LiteralPath $exe -PathType Leaf) {
                    $execStatus = [string](Get-AuthenticodeSignature -LiteralPath $exe -ErrorAction Stop).Status
                    $digest = [string](Get-FileHash -LiteralPath $exe -Algorithm SHA256 -ErrorAction Stop).Hash
                } else { $execStatus = 'FILE_NOT_FOUND' }
            } catch { $execStatus = 'FILE_UNREADABLE' }
        }
        $report.actions += [pscustomobject]@{
            executable_class = if ([IO.Path]::GetFileName($exe) -ieq 'tetherd.exe') {
                'TETHERD_DIRECT'
            } else { 'OTHER' }
            device_id_class = $deviceClass
            relay_scheme = $scheme
            relay_path_class = $pathClass
            relay_port = $port
            relay_host_class = $hostClass
            credential_file_argument = if ($null -ne $credentialPath) { 'PRESENT' } else { 'NOT_IN_TASK' }
            executable_signature = $execStatus
            executable_sha256 = $digest
        }
    }
} catch {
    $report.task_read = 'NOT_READABLE'
}
[pscustomobject]$report | ConvertTo-Json -Depth 5 -Compress
