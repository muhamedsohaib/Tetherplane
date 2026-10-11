# Parses source only; never touches live task, credentials, or network.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$inspect=Join-Path $repo 'packaging\windows\Inspect-Tetherplane-Mesh.ps1'
$entry=Join-Path $repo 'packaging\windows\Inspect-Tetherplane-Mesh.cmd'
if(-not(Test-Path -LiteralPath $inspect -PathType Leaf)){throw 'Read-only preflight script missing'}
if(-not(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'Read-only preflight entrypoint missing'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($inspect,[ref]$tokens,[ref]$errors)
if(@($errors).Count -gt 0){throw 'Read-only preflight syntax invalid'}
$source=[IO.File]::ReadAllText($inspect)
$cmd=[IO.File]::ReadAllText($entry)
foreach($needed in @('TETHERPLANE_MESH_PREFLIGHT_V1','Get-ScheduledTask','Get-Process','status --json','vaulter_supervision','NOT_VERIFIED','relay_pairing_registry','NOT_INSPECTED','https://vaulter.tailf65eba.ts.net/')){
  if(-not $source.Contains($needed)){throw "Read-only preflight missing: $needed"}
}
foreach($blocked in @('Register-ScheduledTask','Unregister-ScheduledTask','Start-ScheduledTask','Stop-ScheduledTask','Start-Process','Stop-Process','Remove-Item','Set-Content','Set-Acl','New-Item','Set-Item','Invoke-Expression','Set-ExecutionPolicy','pair/start','pair/approve','/revoke','-Method Post','-Method Put','-Method Delete','Get-Content')){
  if($source.IndexOf($blocked,[StringComparison]::OrdinalIgnoreCase) -ge 0){
    throw "Read-only preflight forbidden operation: $blocked"
  }
}
if(-not $cmd.Contains('Inspect-Tetherplane-Mesh.ps1') -or -not $cmd.Contains('%~dp0')){
  throw 'Read-only entrypoint must use archive-relative path'
}
Write-Output 'FOUR-DEVICE READONLY MESH PREFLIGHT CONTRACT PASS'
