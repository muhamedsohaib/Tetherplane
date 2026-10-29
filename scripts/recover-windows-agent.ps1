# Guarded local recovery. Never kill console processes or bypass permissions.
# Approved hashes must come from an independently reviewed signed release.
[CmdletBinding()]
param(
  [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA 'Programs\Tetherplane'),
  [string]$SourceRoot = (Join-Path $env:USERPROFILE 'source\Tetherplane'),
  [string]$EvidenceRoot = (Join-Path $env:LOCALAPPDATA 'Tetherplane\task-recovery'),
  [string]$ApprovedAgentSha256,
  [string]$ApprovedLauncherSha256,
  [switch]$Apply,
  [switch]$RemoveVerifiedLegacy,
  [switch]$AuthenticatedAcceptanceConfirmed
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskName = 'Tetherplane Agent'
$legacyNames = @('Tetherplane Leno Agent','Tetherplane Leno Canary',
  'Tetherplane Leno Canary V2','Tetherplane Leno Canary Rollback',
  'Tetherplane Leno Canary Rollback V2')
$bin = [IO.Path]::GetFullPath((Join-Path $InstallPrefix 'bin\tetherd.exe'))
$launcher = [IO.Path]::GetFullPath((Join-Path $InstallPrefix 'launch\tetherplane-agent.ps1'))
$receiptFile = Join-Path $InstallPrefix 'config\install.json'
$argsFile = Join-Path $InstallPrefix 'config\agent-args.json'
function GetRootTask([string]$Name) {
  $matches = @(Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -ceq $Name -and $_.TaskPath -eq '\' })
  if ($matches.Count -gt 1) { throw 'STOP_AMBIGUOUS_TASK' }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}
function ActionFile($task) {
  if (!$task -or @($task.Actions).Count -ne 1) { return $null }
  $a = @($task.Actions)[0]
  if ([IO.Path]::GetFileName([string]$a.Execute) -ine 'powershell.exe') { return $null }
  $m = [regex]::Match([string]$a.Arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))')
  if (!$m.Success) { return $null }
  try { return [IO.Path]::GetFullPath($m.Groups[1].Value + $m.Groups[2].Value) }
  catch { return $null }
}
function Under([string]$PathValue,[string]$Root) {
  if (!$PathValue -or !$Root) { return $false }
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  return $PathValue.StartsWith($rootPath,[StringComparison]::OrdinalIgnoreCase)
}
function LiveAgents {
  $cim = @(Get-CimInstance Win32_Process -Filter "Name = 'tetherd.exe'" -ErrorAction Stop)
  return @($cim | ForEach-Object { [ordered]@{
    pid = [int]$_.ProcessId; path = [string]$_.ExecutablePath
  } })
}
$task = GetRootTask $taskName
$legacy = @($legacyNames | ForEach-Object { GetRootTask $_ } | Where-Object { $_ })
$verifyLegacy = @($legacy | Where-Object {
  $file = ActionFile $_
  $file -and ((Under $file $InstallPrefix) -or (Under $file $SourceRoot))
})
if ($verifyLegacy.Count -ne $legacy.Count) {
  throw 'STOP_UNVERIFIED_LEGACY_TASK: no task was changed'
}
if (!$task) { throw 'STOP_CANONICAL_TASK_MISSING' }
if (-not (Test-Path -LiteralPath $bin -PathType Leaf) -or
    -not (Test-Path -LiteralPath $launcher -PathType Leaf) -or
    -not (Test-Path -LiteralPath $receiptFile -PathType Leaf) -or
    -not (Test-Path -LiteralPath $argsFile -PathType Leaf)) {
  throw 'STOP_INSTALLED_AGENT_INCOMPLETE'
}
$signature = Get-AuthenticodeSignature -LiteralPath $bin
$agentHash = (Get-FileHash -LiteralPath $bin -Algorithm SHA256).Hash
$launcherHash = (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash
if ($signature.Status -ne 'Valid' -or
    $ApprovedAgentSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
    $agentHash -ine $ApprovedAgentSha256 -or
    $ApprovedLauncherSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
    $launcherHash -ine $ApprovedLauncherSha256) {
  throw 'STOP_UNAPPROVED_EXECUTABLE: signed binary and both approved hashes required'
}
$receipt = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
if ($receipt.scheduled_task -cne $taskName -or
    [IO.Path]::GetFullPath([string]$receipt.install_prefix) -ine
      [IO.Path]::GetFullPath($InstallPrefix)) { throw 'STOP_INSTALL_RECEIPT_MISMATCH' }
$arguments = @(Get-Content -LiteralPath $argsFile -Raw | ConvertFrom-Json)
foreach ($flag in @('--relay-url','--device-id','--device-credential-file')) {
  if (@($arguments | Where-Object { $_ -ceq $flag }).Count -ne 1) {
    throw 'STOP_AGENT_CONNECTION_ARGUMENTS_INVALID'
  }
}
$relayIndex = [Array]::IndexOf([string[]]$arguments,'--relay-url')
if ($relayIndex + 1 -ge $arguments.Count) { throw 'STOP_RELAY_URL_MISSING' }
$relayUri = $null
if (-not [Uri]::TryCreate([string]$arguments[$relayIndex + 1],
     [UriKind]::Absolute, [ref]$relayUri) -or
    $relayUri.Scheme -notin @('wss','https') -or
    $relayUri.UserInfo) {
  throw 'STOP_UNAPPROVED_RELAY_SCHEME_OR_CREDENTIALS_IN_URL'
}
$credentialIndex = [Array]::IndexOf([string[]]$arguments,'--device-credential-file')
if ($credentialIndex + 1 -ge $arguments.Count -or
    -not (Test-Path -LiteralPath ([string]$arguments[$credentialIndex+1]) -PathType Leaf)) {
  throw 'STOP_DEVICE_CREDENTIAL_FILE_MISSING'
}
$a = @($task.Actions)[0]
if ((ActionFile $task) -ine $launcher -or
    [string]$a.Arguments -notmatch '(?i)-WindowStyle\s+Hidden' -or
    [string]$a.Arguments -notmatch '(?i)-NonInteractive' -or
    @($task.Actions).Count -ne 1) {
  throw 'STOP_AGENT_LAUNCH_ACTION_NOT_APPROVED'
}
$principal = [Security.Principal.WindowsIdentity]::GetCurrent()
if ([string]$task.Principal.UserId -notin @($principal.Name, $principal.User.Value)) {
  throw 'STOP_TASK_PRINCIPAL_MISMATCH'
}
if ([string]$task.Settings.MultipleInstances -ne 'IgnoreNew') {
  throw 'STOP_TASK_MAY_LAUNCH_DUPLICATE_INSTANCES'
}
if ($RemoveVerifiedLegacy -and -not $AuthenticatedAcceptanceConfirmed) {
  throw 'STOP_REMOTE_AUTHENTICATED_ACCEPTANCE_NOT_CONFIRMED'
}
$running = @(LiveAgents)
if ($running.Count -gt 1 -or
    @($running | Where-Object { $_.path -ine $bin }).Count -gt 0) {
  throw 'STOP_DUPLICATE_OR_FOREIGN_AGENT_RUNNING'
}
if (!$Apply) {
  [ordered]@{status='READY_FOR_AUTHORIZED_LOCAL_APPLY';
    canonicalTask=$task.TaskName;legacyTasks=@($legacy | ForEach-Object { $_.TaskName });
    signedAgent=$true;oneAgentRunning=($running.Count -eq 1);
    note='No task changed. Approval hashes and signature verified; remote authentication not proven.'} |
    ConvertTo-Json -Depth 4
  return
}
if ($running.Count -eq 1) { throw 'STOP_AGENT_ALREADY_RUNNING' }
$archive = Join-Path $EvidenceRoot ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
New-Item -ItemType Directory -Path $archive -Force | Out-Null
foreach ($currentTask in @($task) + $legacy) {
  $name = [regex]::Replace($currentTask.TaskName,'[^A-Za-z0-9]','_')
  Export-ScheduledTask -TaskName $currentTask.TaskName -TaskPath '\' |
    Set-Content -LiteralPath (Join-Path $archive ($name+'.xml')) -Encoding UTF8
}
$disabled = @()
$previouslyDisabled = $task.State -eq 'Disabled'
$started = $false
try {
  foreach ($old in $verifyLegacy) {
    if ($old.State -eq 'Running') {
      Stop-ScheduledTask -TaskName $old.TaskName -ErrorAction Stop
    }
    if ($old.State -ne 'Disabled') {
      Disable-ScheduledTask -TaskName $old.TaskName -ErrorAction Stop | Out-Null
      $disabled += $old.TaskName
    }
  }
  if (@(LiveAgents).Count -gt 0) { throw 'STOP_OLD_AGENT_STILL_RUNNING' }
  if ($previouslyDisabled) { Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null }
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $started = $true
  $ok = $false
  for ($i=0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    $live = @(LiveAgents)
    $state = (GetRootTask $taskName).State
    if ($state -eq 'Running' -and $live.Count -eq 1 -and $live[0].path -ieq $bin) {
      $ok = $true;break
    }
  }
  if (!$ok) { throw 'STOP_AGENT_RECONNECT_LOCAL_PROOF_FAILED' }
  # Removal is separate; this cannot certify remote OAuth connectivity.
  if ($RemoveVerifiedLegacy) {
    foreach ($old in $verifyLegacy) {
      Unregister-ScheduledTask -TaskName $old.TaskName -Confirm:$false -ErrorAction Stop
    }
  }
  [ordered]@{status='LOCAL_SINGLE_AGENT_RUNNING';backup=$archive;
    legacy=$verifyLegacy.Count;legacyDeleted=[bool]$RemoveVerifiedLegacy;
    remoteAcceptance='UNKNOWN';visibleConsoleWindows='NOT_VERIFIED'} | ConvertTo-Json
}
catch {
  if ($started) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
  if ($previouslyDisabled) { Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null }
  foreach ($name in $disabled) { Enable-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Out-Null }
  throw
}
