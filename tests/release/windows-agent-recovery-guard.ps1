$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $repo 'scripts\recover-windows-agent.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-recovery-negative-' + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $global:TPTaskMutations = 0
  function Start-ScheduledTask { $global:TPTaskMutations++; throw 'FORBIDDEN_TASK_MUTATION' }
  function Stop-ScheduledTask { $global:TPTaskMutations++; throw 'FORBIDDEN_TASK_MUTATION' }
  function Enable-ScheduledTask { $global:TPTaskMutations++; throw 'FORBIDDEN_TASK_MUTATION' }
  function Disable-ScheduledTask { $global:TPTaskMutations++; throw 'FORBIDDEN_TASK_MUTATION' }
  function Unregister-ScheduledTask { $global:TPTaskMutations++; throw 'FORBIDDEN_TASK_MUTATION' }
  function Set-ScheduledTask { $global:TPTaskMutations++; throw 'FORBIDDEN_TASK_MUTATION' }
  $caught = $false
  try {
    & $script -Apply -InstallPrefix $root -ApprovedAgentSha256 ('0' * 64) -ApprovedLauncherSha256 ('0' * 64) -RemoveVerifiedLegacy | Out-Null
  } catch {
    if ($_.Exception.Message -notlike 'STOP_*') { throw }
    $caught = $true
  }
  if (-not $caught) { throw 'unsigned/uninstalled agent was approved' }
  if ($global:TPTaskMutations -ne 0) { throw 'failed preflight mutated a scheduled task' }
  $source = Get-Content -LiteralPath $script -Raw
  if ($source -match '(?i)\bStop-Process\b|\bNew-ItemProperty\b|\bRemove-ItemProperty\b') {
    throw 'recovery script should not terminate arbitrary processes or rewrite auth persistence'
  }
  if ($source -notmatch 'Get-AuthenticodeSignature' -or
      $source -notmatch 'ApprovedAgentSha256' -or
      $source -notmatch 'ApprovedLauncherSha256' -or
      $source -notmatch 'Export-ScheduledTask') {
    throw 'release provenance or task-backup safety gate absent'
  }
  Write-Output 'WINDOWS_AGENT_RECOVERY_FAIL_CLOSED=PASS'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
