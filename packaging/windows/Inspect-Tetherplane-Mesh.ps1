<#
.SYNOPSIS
  Read-only status snapshot before any Tetherplane mesh re-enrollment.
.DESCRIPTION
  Does not install, pair, revoke, restart, or change services. It never reads
  or prints device credentials, OAuth tokens, task arguments or tailnet keys.
#>
[CmdletBinding()]
param(
  [ValidateSet('','Leno','RTX','Surface','Vaulter')]
  [string]$DeviceId = ''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Test-MeshPath([string]$Candidate) {
  if([string]::IsNullOrWhiteSpace($Candidate)){return $false}
  try { return [bool](Test-Path -LiteralPath $Candidate -ErrorAction Stop) }
  catch { return $false }
}
function Test-MeshRelayProbe([string]$Suffix,[string]$Expected) {
  try {
    $reply=Invoke-RestMethod -Uri ('https://vaulter.tailf65eba.ts.net/'+$Suffix) -Method Get -TimeoutSec 8 -ErrorAction Stop
    return [bool]([string]$reply.status -ceq $Expected)
  } catch { return $false }
}
function Get-MeshTaskSummary {
  $result=@()
  $available=[bool](Get-Command 'Get-ScheduledTask' -ErrorAction SilentlyContinue)
  if(-not $available){return @{available=$false;tasks=@()}}
  try {
    $matching=@(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -like 'Tetherplane*' })
    foreach($task in $matching){
      $result+=@{name=[string]$task.TaskName;state=[string]$task.State}
    }
    return @{available=$true;tasks=@($result|Sort-Object name|Select-Object -First 30)}
  } catch {return @{available=$false;tasks=@()}}
}
function Get-MeshTailscaleState {
  $program=$env:ProgramFiles
  $binary=$null
  if(-not [string]::IsNullOrWhiteSpace($program)){
    $candidate=Join-Path $program 'Tailscale\tailscale.exe'
    if(Test-Path -LiteralPath $candidate -PathType Leaf){$binary=$candidate}
  }
  if($null -eq $binary){return @{installed=$false;self_online=$null}}
  try {
    $raw=(& $binary status --json 2>$null | Out-String)
    if([string]::IsNullOrWhiteSpace($raw)){return @{installed=$true;self_online=$null}}
    $status=$raw|ConvertFrom-Json -ErrorAction Stop
    if($null -eq $status.Self){return @{installed=$true;self_online=$null}}
    return @{installed=$true;self_online=[bool]$status.Self.Online}
  } catch {return @{installed=$true;self_online=$null}}
}
if($env:OS -ne 'Windows_NT'){throw 'This read-only preflight requires Windows.'}
$local=$env:LOCALAPPDATA
if([string]::IsNullOrWhiteSpace($local)){throw 'LOCALAPPDATA is required.'}
$existingInstall=Join-Path $local 'Programs\Tetherplane'
$meshInstall=Join-Path $local 'Programs\Tetherplane-Mesh'
$existingState=Join-Path $local 'Tetherplane\state'
$knownCredentials=@((Join-Path $existingState 'device.credential'))
foreach($candidateId in @('Leno','RTX','Surface','Vaulter')){
  $knownCredentials+=Join-Path $local ('Tetherplane\mesh\'+$candidateId+'\device.credential')
}
if(-not [string]::IsNullOrWhiteSpace($env:ProgramData)){
  $knownCredentials+=Join-Path $env:ProgramData 'Tetherplane\device.credential'
}
$hasKnownCredential=$false
foreach($candidate in $knownCredentials){
  if(Test-MeshPath $candidate){$hasKnownCredential=$true;break}
}
$tasks=Get-MeshTaskSummary
$tailscale=Get-MeshTailscaleState
$processCount=$null
try {$processCount=@(Get-Process -Name 'tetherd' -ErrorAction SilentlyContinue).Count}
catch {$processCount=$null}
# Health and readiness are not a supervisor/process-tree proof.
$health=Test-MeshRelayProbe 'healthz' 'ok'
$ready=Test-MeshRelayProbe 'readyz' 'ready'
$report=[ordered]@{
  probe='TETHERPLANE_MESH_PREFLIGHT_V1'
  machine_hostname=[string]$env:COMPUTERNAME
  operator_supplied_device_id=$DeviceId
  previous_install_present=(Test-MeshPath $existingInstall)
  mesh_install_present=(Test-MeshPath $meshInstall)
  previous_state_present=(Test-MeshPath $existingState)
  credential_at_known_candidate_path=$hasKnownCredential
  scheduled_task_query_succeeded=[bool]$tasks.available
  tetherplane_tasks=@($tasks.tasks)
  visible_tetherd_process_count=$processCount
  tailscale_installed=[bool]$tailscale.installed
  tailscale_self_online=$tailscale.self_online
  vaulter_healthz_ok=$health
  vaulter_readyz_ok=$ready
  relay_pairing_registry='NOT_INSPECTED'
  vaulter_supervision='NOT_VERIFIED'
  installed_or_repaired_anything=$false
  guidance='Preserve existing credentials. Inspect authenticated registry and local agent settings before re-pairing.'
}
$report|ConvertTo-Json -Depth 7
