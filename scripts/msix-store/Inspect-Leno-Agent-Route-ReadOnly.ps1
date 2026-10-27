# Leno / Tetherplane: inspect ONLY sanitized routing facts of running tetherd.
# No admin, credential reads, secrets, raw command lines, paths, IPs, or URLs.
# Never starts, stops, reconnects, changes policy or edits identity.
$ErrorActionPreference = 'Stop'
function Read-CommandArgument([string]$commandLine, [string]$option) {
    if ([string]::IsNullOrWhiteSpace($commandLine)) { return $null }
    $pattern = '(?i)(?:^|\s)' + [regex]::Escape($option) + '(?:\s+|=)(?:"([^"]+)"|(\S+))'
    $match = [regex]::Match($commandLine, $pattern)
    if (-not $match.Success) { return $null }
    if ($match.Groups[1].Success) { return [string]$match.Groups[1].Value }
    return [string]$match.Groups[2].Value
}

$report = [ordered]@{
    schema = 'tetherplane-leno-agent-route-v1'
    collected_utc = [DateTime]::UtcNow.ToString('o')
    canary_action_kind = 'UNAVAILABLE'
    agent_processes = @()
    note = 'Ports and launch arguments do not establish successful WebSocket authentication'
}
try {
    $task = Get-ScheduledTask -TaskName 'Tetherplane Leno Canary' -ErrorAction Stop
    $kinds = @()
    foreach ($action in @($task.Actions)) {
        $exe = [IO.Path]::GetFileName([string]$action.Execute)
        if ($exe -match '^(?i:tetherd[.]exe)$') { $kinds += 'TETHERD_DIRECT' }
        elseif ($exe -match '^(?i:powershell|pwsh)[.]exe$') { $kinds += 'POWERSHELL_WRAPPER' }
        elseif ($exe -match '^(?i:cmd)[.]exe$') { $kinds += 'CMD_WRAPPER' }
        else { $kinds += 'OTHER' }
    }
    $report.canary_action_kind = @($kinds) -join ','
} catch {}
try {
    $agents = @(Get-CimInstance Win32_Process -Filter "Name = 'tetherd.exe'" -ErrorAction Stop)
    foreach ($agent in $agents) {
        $cmd = [string]$agent.CommandLine
        $id = Read-CommandArgument $cmd '--device-id'
        $deviceClass = 'NOT_VISIBLE'
        if ($null -ne $id) {
            if ($id -ceq 'Leno') { $deviceClass = 'EXACT_LENO' }
            elseif ($id -ieq 'Leno') { $deviceClass = 'CASE_ONLY_MISMATCH' }
            else { $deviceClass = 'OTHER_DEVICE_ID' }
        }
        $url = Read-CommandArgument $cmd '--relay-url'
        $scheme = 'NOT_VISIBLE'
        $endpointClass = 'NOT_VISIBLE'
        $devicePath = 'NOT_VISIBLE'
        $configuredPort = 'NOT_VISIBLE'
        if ($null -ne $url) {
            try {
                $parsed = [uri]$url
                $scheme = if ($parsed.Scheme -eq 'wss') { 'WSS' }
                    elseif ($parsed.Scheme -eq 'ws') { 'WS' }
                    else { 'OTHER' }
                $devicePath = if ($parsed.AbsolutePath -ceq '/device') { 'DEVICE_PATH' }
                    else { 'OTHER_PATH' }
                $configuredPort = [string]$parsed.Port
                if ($parsed.Host -match '^(?i:vaulter)(?:[.]|$)') {
                    $endpointClass = 'VAULTER_NAMED'
                } elseif ($parsed.Host -match '[.]ts[.]net$') {
                    $endpointClass = 'TAILNET_NAME_OTHER'
                } else { $endpointClass = 'OTHER_OR_PUBLIC'
                }
            } catch { $scheme = 'INVALID_URL' }
        }
        $ports = @()
        try {
            $tcp = @(Get-NetTCPConnection -OwningProcess ([int]$agent.ProcessId) -State Established -ErrorAction Stop)
            $ports = @($tcp | Select-Object -ExpandProperty RemotePort | Sort-Object -Unique)
        } catch {}
        $report.agent_processes += [pscustomobject]@{
            pid = [int]$agent.ProcessId
            device_id_class = $deviceClass
            transport = $scheme
            configured_host_class = $endpointClass
            device_path = $devicePath
            configured_port = $configuredPort
            active_remote_ports = @($ports)
        }
    }
} catch {}
[pscustomobject]$report | ConvertTo-Json -Depth 6 -Compress
