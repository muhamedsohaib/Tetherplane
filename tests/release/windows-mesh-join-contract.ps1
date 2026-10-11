# Windows mesh bootstrap security contract. Synthetic: never touch live task/network.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$join = Join-Path $repo 'packaging\windows\Join-Tetherplane-Mesh.ps1'
$entry = Join-Path $repo 'packaging\windows\Join-Tetherplane-Mesh.cmd'
if (-not(Test-Path -LiteralPath $join -PathType Leaf)) { throw 'RED: one-click mesh bootstrap missing' }
if (-not(Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'RED: clickable mesh entrypoint missing' }
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($join,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -gt 0){throw 'Mesh bootstrap syntax invalid'}
$script=[IO.File]::ReadAllText($join)
$cmd=[IO.File]::ReadAllText($entry)
foreach($needed in @('Join-MeshDevice','Start-MeshPairing','Get-MeshCredentialHash','Get-MeshPairingBody','Assert-MeshSafeInstall','Set-MeshPrivateAcl','-InstallScheduledTask','Start-ScheduledTask','-AgentArgumentsFile','https://vaulter.tailf65eba.ts.net','wss://vaulter.tailf65eba.ts.net/device')){
  if(-not $script.Contains($needed)){throw "RED: missing secure enrollment requirement $needed"}
}
foreach($blocked in @('Stop-ScheduledTask','Stop-Process','Unregister-ScheduledTask','--relay-allow-insecure-localhost','gh auth token')){
  if($script.Contains($blocked)){throw "Forbidden bootstrap operation: $blocked"}
}
if(-not $cmd.Contains('Join-Tetherplane-Mesh.ps1') -or -not $cmd.Contains('%~dp0')){throw 'One-click cmd entrypoint is not relative to extracted archive'}
foreach($name in @('Assert-MeshDeviceId','Get-MeshTaskName','Get-MeshCredentialHash','Get-MeshPairingBody','Assert-MeshRelayEndpoints')){
  $f=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
  if($null -eq $f){throw "Missing testable helper $name"}
  Invoke-Expression $f.Extent.Text
}
foreach($id in @('Leno','RTX','Surface','Vaulter')){
  Assert-MeshDeviceId $id
  if((Get-MeshTaskName $id) -cne ('Tetherplane Mesh '+$id)){throw 'Mesh task name must be device-scoped'}
}
foreach($id in @('','Unknown','Leno;Exit','../../Surface','leno ')){
  $rejected=$false
  try{Assert-MeshDeviceId $id}catch{$rejected=$true}
  if(-not $rejected){throw "Unsafe device ID allowed: $id"}
}
$hash=Get-MeshCredentialHash 'non-production-unit-test-device-secret'
if($hash -notmatch '^[a-f0-9]{64}$'){throw 'Credential hash is not SHA-256 hex'}
$body=Get-MeshPairingBody 'RTX' $hash
if(@($body.Keys).Count -ne 2 -or $body.deviceId -cne 'RTX' -or $body.credentialHash -cne $hash){throw 'Pairing request must contain ONLY device ID and hash'}
Assert-MeshRelayEndpoints 'https://vaulter.tailf65eba.ts.net' 'wss://vaulter.tailf65eba.ts.net/device'
foreach($origin in @('http://vaulter.tailf65eba.ts.net','https://example.org','https://vaulter.tailf65eba.ts.net.evil','https://vaulter.tailf65eba.ts.net:8443')){
  $rejected=$false
  try{Assert-MeshRelayEndpoints $origin 'wss://vaulter.tailf65eba.ts.net/device'}catch{$rejected=$true}
  if(-not $rejected){throw "Untrusted relay origin accepted"}
}
$installer=[IO.File]::ReadAllText((Join-Path $repo 'scripts\install-windows.ps1'))
$uninstaller=[IO.File]::ReadAllText((Join-Path $repo 'scripts\uninstall-windows.ps1'))
foreach($needle in @('-ScheduledTaskName $taskName','Get-MeshTaskName $id')){
  if(-not $script.Contains($needle)){throw "RED: mesh join lacks side-by-side scheduled task protection: $needle"}
}
foreach($needle in @('[string]$ScheduledTaskName', '$taskName = $ScheduledTaskName')){
  if(-not $installer.Contains($needle)){throw "RED: Windows installer does not support a separate mesh task: $needle"}
}
if(-not $uninstaller.Contains('$isMeshSideBySide')){
  throw 'RED: mesh uninstall must not remove the legacy model-worker startup registration'
}
Write-Output 'FOUR-DEVICE MESH BOOTSTRAP SECURITY CONTRACT PASS'
