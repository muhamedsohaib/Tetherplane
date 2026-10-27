# Tetherplane Leno connectivity follow-up. Read-only; no admin required.
# Output excludes credentials, command lines, filesystem paths and IPs.
$ErrorActionPreference = 'Stop'
$report = [ordered]@{
    schema = 'tetherplane-leno-connectivity-readonly-v1'
    collected_utc = [DateTime]::UtcNow.ToString('o')
    tailscale_backend = 'UNAVAILABLE'
    tailscale_self_online = 'UNAVAILABLE'
    task_runs = @()
    tetherd_tcp_states = @()
    caveat = 'Task Running/TCP Established is not authenticated MCP connectivity'
}
$exe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
try {
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
        $output = & $exe status --json 2>$null
        if ($LASTEXITCODE -eq 0) {
            $data = ($output | Out-String | ConvertFrom-Json -ErrorAction Stop)
            $report.tailscale_backend = [string]$data.BackendState
            if ($null -ne $data.Self) {
                $report.tailscale_self_online = [string]$data.Self.Online
            }
        }
    } else { $report.tailscale_backend = 'CLI_NOT_FOUND' }
} catch { $report.tailscale_backend = 'QUERY_FAILED' }
foreach ($name in @('Tetherplane Leno Canary','Tetherplane Emergency Relay')) {
    $entry = [ordered]@{
        name = $name
        task_state = 'UNAVAILABLE'
        last_run_utc = 'UNAVAILABLE'
        last_task_result = 'UNAVAILABLE'
        missed_runs = 'UNAVAILABLE'
    }
    try {
        $task = @(Get-ScheduledTask -TaskName $name -ErrorAction Stop) | Select-Object -First 1
        if ($null -ne $task) {
            $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
            $entry.task_state = [string]$task.State
            $entry.last_run_utc = $info.LastRunTime.ToUniversalTime().ToString('o')
            $entry.last_task_result = [string]$info.LastTaskResult
            $entry.missed_runs = [string]$info.NumberOfMissedRuns
        }
    } catch {}
    $report.task_runs += [pscustomobject]$entry
}
try {
    $agents = @(Get-CimInstance Win32_Process -Filter "Name = 'tetherd.exe'" -ErrorAction Stop)
    foreach ($agent in $agents) {
        $counts = @()
        try {
            $connections = @(Get-NetTCPConnection -OwningProcess ([int]$agent.ProcessId) -ErrorAction Stop)
            $counts = @($connections | Group-Object State | ForEach-Object {
                [pscustomobject]@{state = [string]$_.Name; count = [int]$_.Count}
            })
        } catch {}
        $report.tetherd_tcp_states += [pscustomobject]@{
            pid = [int]$agent.ProcessId
            tcp_states = @($counts)
        }
    }
} catch {}
[pscustomobject]$report | ConvertTo-Json -Depth 5 -Compress
