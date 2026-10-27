# Tetherplane / Leno: third-stage canary boundary inspection (read-only).
# No task actions, security changes, credentials, IPs, URLs or command lines.
$ErrorActionPreference = 'Stop'
$report = [ordered]@{
    schema = 'tetherplane-leno-canary-boundary-v1'
    collected_utc = [DateTime]::UtcNow.ToString('o')
    canary = [ordered]@{
        state = 'UNAVAILABLE'
        last_run_utc = 'UNAVAILABLE'
        last_result_hex = 'UNAVAILABLE'
        multiple_instances = 'UNAVAILABLE'
        logon_type = 'UNAVAILABLE'
        run_level = 'UNAVAILABLE'
    }
    agent_processes = @()
    canary_event_query = 'NOT_RUN'
    canary_task_events = @()
    code_integrity_query = 'NOT_RUN'
    recent_tetherd_blocks = @()
    note = 'Read-only observation; established TCP does not prove authenticated MCP relay access.'
}
try {
    $task = Get-ScheduledTask -TaskName 'Tetherplane Leno Canary' -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
    $report.canary.state = [string]$task.State
    $report.canary.last_run_utc = $info.LastRunTime.ToUniversalTime().ToString('o')
    $report.canary.last_result_hex = '0x{0:X8}' -f ([uint32]$info.LastTaskResult)
    $report.canary.multiple_instances = [string]$task.Settings.MultipleInstances
    $report.canary.logon_type = [string]$task.Principal.LogonType
    $report.canary.run_level = [string]$task.Principal.RunLevel
} catch {}

# The tailnet peer map remains in local memory. Only the broad peer class
# is returned. It never outputs peer IPs, node addresses or hostnames.
$peerClasses = @{}
try {
    $tailscaleExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $tailscaleExe -PathType Leaf) {
        $raw = & $tailscaleExe status --json 2>$null
        if ($LASTEXITCODE -eq 0) {
            $ts = $raw | Out-String | ConvertFrom-Json -ErrorAction Stop
            if ($null -ne $ts.Peer) {
                foreach ($item in $ts.Peer.PSObject.Properties) {
                    $peer = $item.Value
                    $peerClass = 'TAILNET_OTHER_PEER'
                    if (([string]$peer.HostName -ieq 'VAULTER') -or
                        ([string]$peer.DNSName -match '^(?i:vaulter)[.]')) {
                        $peerClass = 'TAILNET_VAULTER'
                    }
                    foreach ($ip in @($peer.TailscaleIPs)) {
                        if (-not [string]::IsNullOrWhiteSpace([string]$ip)) {
                            $peerClasses[[string]$ip] = $peerClass
                        }
                    }
                }
            }
        }
    }
} catch {}

try {
    $agents = @(Get-CimInstance Win32_Process -Filter "Name = 'tetherd.exe'" -ErrorAction Stop)
    foreach ($agent in $agents) {
        $startUtc = 'UNAVAILABLE'
        try {
            if ($null -ne $agent.CreationDate) {
                $startUtc = ([datetime]$agent.CreationDate).ToUniversalTime().ToString('o')
            }
        } catch {}
        $types = @()
        try {
            $sockets = @(Get-NetTCPConnection -OwningProcess ([int]$agent.ProcessId) -State Established -ErrorAction Stop)
            foreach ($socket in $sockets) {
                $remote = [string]$socket.RemoteAddress
                $class = 'NON_TAILNET_OR_DIRECT'
                if ($remote -eq '127.0.0.1' -or $remote -eq '::1') {
                    $class = 'LOOPBACK'
                } elseif ($peerClasses.ContainsKey($remote)) {
                    $class = [string]$peerClasses[$remote]
                }
                $types += $class
            }
        } catch {}
        $summary = @($types | Group-Object | ForEach-Object {
            [pscustomobject]@{ class = [string]$_.Name; connections = [int]$_.Count }
        })
        $report.agent_processes += [pscustomobject]@{
            pid = [int]$agent.ProcessId
            created_utc = $startUtc
            established_peers = $summary
        }
    }
} catch {}

# Event descriptions are inspected locally only to match the canary; event
# message text (which may include action arguments) is never returned.
try {
    $events = @(Get-WinEvent -FilterHashtable @{
        LogName = 'Microsoft-Windows-TaskScheduler/Operational'
        StartTime = (Get-Date).AddDays(-3)
    } -MaxEvents 800 -ErrorAction Stop)
    $matches = @($events | Where-Object {
        [string]$_.Message -like '*Tetherplane Leno Canary*'
    } | Select-Object -First 12)
    $report.canary_task_events = @($matches | ForEach-Object {
        [pscustomobject]@{
            event_id = [int]$_.Id
            observed_utc = $_.TimeCreated.ToUniversalTime().ToString('o')
        }
    })
    $report.canary_event_query = 'BOUNDED_LAST_800_EVENTS_WITHIN_72_HOURS'
} catch {
    $report.canary_event_query = 'UNAVAILABLE_OR_EMPTY'
}

try {
    $blocks = @(Get-WinEvent -FilterHashtable @{
        LogName = 'Microsoft-Windows-CodeIntegrity/Operational'
        Id = 3077
        StartTime = (Get-Date).AddDays(-3)
    } -MaxEvents 100 -ErrorAction Stop)
    $matches = @($blocks | Where-Object {
        [string]$_.Message -match 'tetherd[.]exe'
    } | Select-Object -First 5)
    $report.recent_tetherd_blocks = @($matches | ForEach-Object {
        [pscustomobject]@{
            event_id = [int]$_.Id
            observed_utc = $_.TimeCreated.ToUniversalTime().ToString('o')
        }
    })
    $report.code_integrity_query = 'BOUNDED_100_CODE_INTEGRITY_3077_EVENTS_72_HOURS'
} catch {
    $report.code_integrity_query = 'UNAVAILABLE_OR_EMPTY'
}

[pscustomobject]$report | ConvertTo-Json -Depth 7 -Compress
