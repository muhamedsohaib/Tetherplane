# Read-only Tetherplane Windows relay-recovery observation.
# No task arguments, credential files, full log lines, or remote addresses are printed.
[CmdletBinding()]
param(
  [string]$AgentTaskName = 'Tetherplane Leno Agent',
  [string]$AgentProcessName = 'tetherd',
  [int]$LogTailLines = 100,
  [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'Tetherplane\tetherd-leno-task.stderr.log')
)
$ErrorActionPreference = 'Stop'
if ($LogTailLines -lt 1 -or $LogTailLines -gt 1000) { throw 'LogTailLines must be between 1 and 1000' }
$task = Get-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue
$info = if ($task) { $task | Get-ScheduledTaskInfo } else { $null }
$agents = @(Get-Process -Name $AgentProcessName -ErrorAction SilentlyContinue)
$tcp = @()
foreach ($agent in $agents) {
  $tcp += @(Get-NetTCPConnection -OwningProcess $agent.Id -State Established -ErrorAction SilentlyContinue)
}
$lines = @()
$logLastWrite = $null
if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
  $lines = @(Get-Content -LiteralPath $LogPath -Tail $LogTailLines -ErrorAction SilentlyContinue)
  $logLastWrite = (Get-Item -LiteralPath $LogPath).LastWriteTimeUtc.ToString('o')
}
[ordered]@{
  schema = 'tetherplane.windows.reconnect.readonly.v1'
  observed_utc = [DateTime]::UtcNow.ToString('o')
  hostname = $env:COMPUTERNAME
  agent_task_state = if ($task) { [string]$task.State } else { 'NotFound' }
  agent_task_last_result = if ($info) { $info.LastTaskResult } else { $null }
  agent_process_count = $agents.Count
  agent_pids = @($agents | Select-Object -ExpandProperty Id)
  established_tcp_count = $tcp.Count
  remote_ports = @($tcp | Select-Object -ExpandProperty RemotePort -Unique)
  log_last_write_utc = $logLastWrite
  inspected_log_lines = $lines.Count
  tls_handshake_eof_count = @($lines | Where-Object { $_ -match 'tls handshake eof' }).Count
  remote_reset_10054_count = @($lines | Where-Object { $_ -match 'os error 10054' }).Count
  websocket_receive_error_count = @($lines | Where-Object { $_ -match 'websocket receive failed' }).Count
  auth_http_401_403_count = @($lines | Where-Object { $_ -match 'relay rejected device authentication with HTTP (401|403)' }).Count
} | ConvertTo-Json -Compress -Depth 4
# Diagnostic output is not proof of authenticated registration or real MCP reachability.
