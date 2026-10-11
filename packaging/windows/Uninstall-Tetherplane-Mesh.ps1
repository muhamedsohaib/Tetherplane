<#
.SYNOPSIS
  Remove only this user's side-by-side Tetherplane Mesh installation.
.DESCRIPTION
  Preserves all device credentials and mesh state. Never changes the legacy
  Tetherplane Agent, Emergency Relay, Browser Bridge, or model-worker startup.
  Requires an exact mesh-owned install receipt and scheduled-task action.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-MeshUninstallReceipt([object]$Receipt,[string]$ExpectedInstall){
  if($null -eq $Receipt){throw 'Missing mesh install receipt.'}
  $fixed=Join-Path $env:LOCALAPPDATA 'Programs\Tetherplane-Mesh'
  $fixed=[IO.Path]::GetFullPath($fixed).TrimEnd('\')
  $install=[IO.Path]::GetFullPath($ExpectedInstall).TrimEnd('\')
  if(-not [string]::Equals($fixed,$install,[StringComparison]::OrdinalIgnoreCase)){
    throw 'Mesh cleanup refuses an unrecognized installation directory.'
  }
  $receiptInstall=[IO.Path]::GetFullPath([string]$Receipt.install_prefix).TrimEnd('\')
  if(-not [string]::Equals($receiptInstall,$install,[StringComparison]::OrdinalIgnoreCase)){
    throw 'Mesh cleanup receipt installation path mismatch.'
  }
  $name=[string]$Receipt.scheduled_task
  if($name -cnotmatch '^Tetherplane Mesh (Leno|RTX|Surface|Vaulter)$'){
    throw 'Mesh cleanup refuses to remove an unrecognized or legacy task.'
  }
  $id=$name.Substring('Tetherplane Mesh '.Length)
  $expectedState=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA ('Tetherplane\mesh\'+$id))).TrimEnd('\')
  $receiptState=[IO.Path]::GetFullPath([string]$Receipt.state_dir).TrimEnd('\')
  if(-not [string]::Equals($expectedState,$receiptState,[StringComparison]::OrdinalIgnoreCase)){
    throw 'Mesh cleanup receipt protected state path mismatch.'
  }
  return $name
}

function Invoke-MeshUninstall {
  if($env:OS -ne 'Windows_NT'){throw 'Mesh cleanup requires Windows.'}
  $install=Join-Path $env:LOCALAPPDATA 'Programs\Tetherplane-Mesh'
  if(-not (Test-Path -LiteralPath $install -PathType Container)){
    throw 'Side-by-side mesh installation is absent.'
  }
  $directory=Get-Item -LiteralPath $install -Force -ErrorAction Stop
  if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint){
    throw 'Mesh cleanup refuses a reparse-point install directory.'
  }
  $receiptPath=Join-Path $install 'config\install.json'
  if(-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)){
    throw 'Mesh cleanup refuses an installation without a receipt.'
  }
  $receipt=Get-Content -LiteralPath $receiptPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  $taskName=Assert-MeshUninstallReceipt $receipt $install

  $task=Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
  if($null -ne $task){
    $actions=@($task.Actions)
    $expectedLaunch=Join-Path $install 'launch\tetherplane-agent.ps1'
    $expectedArgs='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$expectedLaunch+'"'
    if($actions.Count -ne 1 -or
       [string]$actions[0].Execute -ine 'powershell.exe' -or
       [string]$actions[0].Arguments -cne $expectedArgs){
      throw 'Mesh task action does not belong to this installation; no task was modified.'
    }
    if($task.State -eq 'Running'){
      Stop-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction Stop
    }
    Unregister-ScheduledTask -TaskPath '\' -TaskName $taskName -Confirm:$false -ErrorAction Stop
  }

  # Only remove the verified side-by-side install. Protected device identity
  # and credential state remain in LOCALAPPDATA\Tetherplane\mesh\<device-id>.
  Remove-Item -LiteralPath $install -Recurse -Force -ErrorAction Stop
  Write-Output 'MESH_UNINSTALL_OK'
  Write-Output 'Mesh credentials and protected state were preserved.'
}
if($MyInvocation.InvocationName -ne '.'){
  try{Invoke-MeshUninstall}catch{
    Write-Error ('MESH_UNINSTALL_STOPPED: '+$_.Exception.Message)
    exit 1
  }
}
