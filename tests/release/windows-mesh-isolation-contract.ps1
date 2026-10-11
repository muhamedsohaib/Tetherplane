# Synthetic side-by-side lifecycle test. No real scheduled tasks or user installs.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installScript=Join-Path $repo 'scripts\install-windows.ps1'
$safeCleanup=Join-Path $repo 'packaging\windows\Uninstall-Tetherplane-Mesh.ps1'
$root=Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-mesh-isolation-'+[guid]::NewGuid().ToString('N'))
$realLocal=$env:LOCALAPPDATA
$global:TetherplaneTestLegacyTask=[pscustomobject]@{TaskName='Tetherplane Agent';State='Ready'}
$global:TetherplaneTestMeshTask=$null
$global:TetherplaneTestModifiedTasks=New-Object 'System.Collections.Generic.List[string]'

function Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskPath,[string]$TaskName)
  if($TaskName -ceq 'Tetherplane Agent'){return $global:TetherplaneTestLegacyTask}
  if($null -ne $global:TetherplaneTestMeshTask -and $TaskName -ceq $global:TetherplaneTestMeshTask.TaskName){return $global:TetherplaneTestMeshTask}
  return $null
}
function New-ScheduledTaskAction {
  [CmdletBinding()]
  param([string]$Execute,[string]$Argument)
  return [pscustomobject]@{Execute=$Execute;Arguments=$Argument}
}
function New-ScheduledTaskTrigger {
  [CmdletBinding()]
  param([switch]$AtLogOn)
  return [pscustomobject]@{AtLogOn=[bool]$AtLogOn}
}
function Register-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName,[object]$Action,[object]$Trigger,[string]$RunLevel,[switch]$Force)
  if($TaskName -cne 'Tetherplane Mesh Leno'){throw 'Attempted to replace a non-mesh scheduled task.'}
  $global:TetherplaneTestModifiedTasks.Add('register:'+$TaskName)
  $global:TetherplaneTestMeshTask=[pscustomobject]@{TaskName=$TaskName;State='Running';Actions=@($Action)}
  return $global:TetherplaneTestMeshTask
}
function Stop-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskPath,[string]$TaskName)
  if($null -eq $global:TetherplaneTestMeshTask -or $TaskName -cne $global:TetherplaneTestMeshTask.TaskName){
    throw 'Attempted to stop a non-mesh scheduled task.'
  }
  $global:TetherplaneTestModifiedTasks.Add('stop:'+$TaskName)
  $global:TetherplaneTestMeshTask.State='Ready'
}
function Unregister-ScheduledTask {
  [CmdletBinding(SupportsShouldProcess=$true)]
  param([string]$TaskPath,[string]$TaskName)
  if($null -eq $global:TetherplaneTestMeshTask -or $TaskName -cne $global:TetherplaneTestMeshTask.TaskName){
    throw 'Attempted to unregister a non-mesh scheduled task.'
  }
  $global:TetherplaneTestModifiedTasks.Add('unregister:'+$TaskName)
  $global:TetherplaneTestMeshTask=$null
}

try{
  $env:LOCALAPPDATA=Join-Path $root 'localappdata'
  $bundle=Join-Path $root 'package'
  $install=Join-Path $env:LOCALAPPDATA 'Programs\Tetherplane-Mesh'
  $state=Join-Path $env:LOCALAPPDATA 'Tetherplane\mesh\Leno'
  $legacy=Join-Path $env:LOCALAPPDATA 'Programs\Tetherplane'
  New-Item -ItemType Directory -Force -Path $bundle,$legacy,$env:LOCALAPPDATA|Out-Null
  $legacySentinel=Join-Path $legacy 'leave-legacy-untouched.txt'
  Set-Content -LiteralPath $legacySentinel -Value 'legacy-owned' -NoNewline

  foreach($relative in @(
    'bin\tetherd.exe',
    'adapters\compact-mcp\dist\stdio-server.js',
    'protocol\schemas\result.schema.json',
    'launch\tetherplane-mcp.ps1',
    'launch\tetherplane-agent.ps1',
    'manifest.json'
  )){
    $file=Join-Path $bundle $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file)|Out-Null
    Set-Content -LiteralPath $file -Value 'synthetic-package-fixture' -NoNewline
  }
  Copy-Item -LiteralPath $safeCleanup -Destination (Join-Path $bundle 'Uninstall-Tetherplane-Mesh.ps1')
  $argsFile=Join-Path $root 'args.json'
  $argsJson=ConvertTo-Json -InputObject @('--device-id','Leno')
  Set-Content -LiteralPath $argsFile -Value $argsJson -Encoding UTF8

  & $installScript -PackagePath $bundle -InstallPrefix $install -StateDir $state -InstallScheduledTask -ScheduledTaskName 'Tetherplane Mesh Leno' -AgentArgumentsFile $argsFile
  if($null -eq $global:TetherplaneTestMeshTask -or $global:TetherplaneTestMeshTask.TaskName -cne 'Tetherplane Mesh Leno'){
    throw 'Mesh installer did not register a separate device-scoped task.'
  }
  if([string]$global:TetherplaneTestMeshTask.Actions[0].Arguments -match 'ExecutionPolicy\s+Bypass'){
    throw 'RED: signed mesh scheduled task must not bypass PowerShell execution policy.'
  }
  if(-not(Test-Path -LiteralPath $legacySentinel)){
    throw 'Legacy installation was touched by mesh installation.'
  }
  $installedCleanup=Join-Path $install 'uninstall-windows.ps1'
  if(-not(Test-Path -LiteralPath $installedCleanup -PathType Leaf)){
    throw 'Side-by-side install lacks the safe cleanup entrypoint.'
  }
  if((Get-FileHash -LiteralPath $installedCleanup).Hash -cne (Get-FileHash -LiteralPath $safeCleanup).Hash){
    throw 'Side-by-side install copied the generic uninstaller instead of the safe mesh cleanup.'
  }
  $credentialSentinel=Join-Path $state 'device.credential'
  Set-Content -LiteralPath $credentialSentinel -Value 'synthetic-credential-do-not-print' -NoNewline

  & $installedCleanup
  if(Test-Path -LiteralPath $install){throw 'Mesh cleanup left installed files.'}
  if(-not(Test-Path -LiteralPath $credentialSentinel)){throw 'Mesh cleanup removed credential state.'}
  if(-not(Test-Path -LiteralPath $legacySentinel)){throw 'Mesh cleanup touched the legacy installation.'}
  if($global:TetherplaneTestLegacyTask.State -cne 'Ready'){throw 'Mesh cleanup changed the legacy scheduled task.'}
  if($null -ne $global:TetherplaneTestMeshTask){throw 'Mesh cleanup left its owned task registered.'}
  $actual=@($global:TetherplaneTestModifiedTasks)
  $expected=@('register:Tetherplane Mesh Leno','stop:Tetherplane Mesh Leno','unregister:Tetherplane Mesh Leno')
  if(($actual -join '|') -cne ($expected -join '|')){
    throw ('Unexpected scheduled-task changes: '+($actual -join ','))
  }
  Write-Output 'WINDOWS_MESH_SIDE_BY_SIDE_LIFECYCLE_OK'
}finally{
  $env:LOCALAPPDATA=$realLocal
  Remove-Variable -Scope Global -Name TetherplaneTestLegacyTask,TetherplaneTestMeshTask,TetherplaneTestModifiedTasks -ErrorAction SilentlyContinue
  if(Test-Path -LiteralPath $root){
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}
