<#
.SYNOPSIS
  One-click, per-user Tetherplane mesh enrollment for one Windows device.
.DESCRIPTION
  Run only from the reviewed Windows package. Never prints a raw device
  credential, changes the existing Vaulter relay, or overwrites an installation.
  Pairing still requires separate approval by the authenticated relay account.
#>
[CmdletBinding()]
param(
  [ValidateSet('Leno','RTX','Surface','Vaulter')]
  [string]$DeviceId,
  [string]$AllowedRoot
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Get-MeshTaskName([string]$Candidate){
  Assert-MeshDeviceId $Candidate
  return ('Tetherplane Mesh '+$Candidate)
}
function Assert-MeshDeviceId([string]$Candidate){
  if($Candidate -cnotin @('Leno','RTX','Surface','Vaulter')){
    throw 'Device ID must be exactly one of Leno, RTX, Surface or Vaulter.'
  }
}
function Assert-MeshRelayEndpoints([string]$Origin,[string]$WebSocket){
  if($Origin -cne 'https://vaulter.tailf65eba.ts.net' -or
     $WebSocket -cne 'wss://vaulter.tailf65eba.ts.net/device'){
    throw 'Mesh bootstrap must use the existing reviewed Vaulter HTTPS/WSS origin.'
  }
}
function Get-MeshCredentialHash([string]$Credential){
  if([string]::IsNullOrWhiteSpace($Credential) -or $Credential.Length -lt 16){
    throw 'A high-entropy device credential is required.'
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  try{
    $digest=$sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Credential))
    return ([BitConverter]::ToString($digest)).Replace('-','').ToLowerInvariant()
  }finally{$sha.Dispose()}
}
function New-MeshCredential {
  $bytes=New-Object byte[] 32
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}
function Get-MeshPairingBody([string]$Candidate,[string]$CredentialHash){
  Assert-MeshDeviceId $Candidate
  if($CredentialHash -cnotmatch '^[0-9a-f]{64}$'){throw 'Invalid SHA-256 credential hash.'}
  return [ordered]@{deviceId=$Candidate;credentialHash=$CredentialHash}
}
function Assert-MeshOrdinaryPath([string]$Path,[switch]$RequireExisting){
  if(-not [IO.Path]::IsPathRooted($Path)){throw 'Only absolute Windows paths are permitted.'}
  if(Test-Path -LiteralPath $Path){
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){
      throw 'Directory or file reparse point rejected.'
    }
  }elseif($RequireExisting){throw 'Required path does not exist.'}
}
function Set-MeshPrivateAcl([string]$Path,[switch]$Directory){
  $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
  $acl.SetAccessRuleProtection($true,$false)
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach($sid in @($owner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){
    if($Directory){
      $rule=[Security.AccessControl.FileSystemAccessRule]::new(
        $sid,[Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    }else{
      $rule=[Security.AccessControl.FileSystemAccessRule]::new(
        $sid,[Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow)
    }
    $acl.SetAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
  $check=Get-Acl -LiteralPath $Path -ErrorAction Stop
  if(-not $check.AreAccessRulesProtected){throw 'Private credential ACL was not protected.'}
  $permitted=@($owner.Value,'S-1-5-18','S-1-5-32-544')
  foreach($ace in @($check.Access)){
    if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow){
      $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if($sid -notin $permitted){throw 'Unexpected allow-ACE in private mesh state.'}
    }
  }
}
function Assert-MeshSafeInstall([string]$Bundle,[string]$Install,[string]$State){
  foreach($file in @('install-windows.ps1','manifest.json','bin\tetherd.exe','Join-Tetherplane-Mesh.ps1')){
    $path=Join-Path $Bundle $file
    if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'Incomplete reviewed Windows package.'}
    Assert-MeshOrdinaryPath $path -RequireExisting
  }
  $manifest=Get-Content -LiteralPath (Join-Path $Bundle 'manifest.json') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  if([string]$manifest.platform -cne 'windows' -or [string]$manifest.architecture -cne 'x64' -or
     [string]$manifest.source_commit -notmatch '^[a-f0-9]{40}$'){
    throw 'Package manifest does not identify a reviewed Windows x64 build.'
  }
  foreach($pin in @(
    @{Path=(Join-Path $Bundle 'Join-Tetherplane-Mesh.ps1');Hash=[string]$manifest.mesh_join_sha256},
    @{Path=(Join-Path $Bundle 'bin\tetherd.exe');Hash=[string]$manifest.tetherd_sha256}
  )){
    if($pin.Hash -notmatch '^[A-Fa-f0-9]{64}$' -or
       (Get-FileHash -LiteralPath $pin.Path -Algorithm SHA256).Hash -cne $pin.Hash.ToUpperInvariant()){
      throw 'Reviewed package file digest mismatch.'
    }
  }
  foreach($path in @($Install,$State)){
    Assert-MeshOrdinaryPath $path
    if(Test-Path -LiteralPath $path){
      throw 'Existing mesh installation or state detected. Refusing to overwrite or regenerate device identity.'
    }
  }
  $meshTask=Get-MeshTaskName $DeviceId
  if(Get-ScheduledTask -TaskPath '\' -TaskName $meshTask -ErrorAction SilentlyContinue){
    throw 'Existing device-scoped Tetherplane Mesh task detected; refusing to replace it.'
  }
}
function Start-MeshPairing([string]$Origin,[string]$Candidate,[string]$CredentialHash){
  Assert-MeshRelayEndpoints $Origin 'wss://vaulter.tailf65eba.ts.net/device'
  $body=Get-MeshPairingBody $Candidate $CredentialHash
  try{
    $pending=Invoke-RestMethod -Uri ($Origin+'/pair/start') -Method Post -ContentType 'application/json' -Body ($body|ConvertTo-Json -Compress) -TimeoutSec 15 -ErrorAction Stop
  }catch{
    throw 'Relay rejected the device pairing request or is unreachable; no agent task was installed.'
  }
  if([string]$pending.userCode -notmatch '^[A-F0-9]{4}-[A-F0-9]{4}$' -or
     [string]::IsNullOrWhiteSpace([string]$pending.pairingId)){
    throw 'Relay returned an invalid pairing response.'
  }
  return $pending
}
function Join-MeshDevice {
  if($env:OS -ne 'Windows_NT'){throw 'This bootstrap requires Windows.'}
  $origin='https://vaulter.tailf65eba.ts.net'
  $websocket='wss://vaulter.tailf65eba.ts.net/device'
  Assert-MeshRelayEndpoints $origin $websocket
  $id=$DeviceId
  if([string]::IsNullOrWhiteSpace($id)){
    Write-Host 'Tetherplane four-device mesh: Leno / RTX / Surface / Vaulter'
    Write-Host ('This Windows hostname: '+$env:COMPUTERNAME)
    $id=Read-Host 'Type this machine logical device ID'
  }
  Assert-MeshDeviceId $id
  if((Read-Host ('To confirm this computer is '+$id+', type '+$id+' again')) -cne $id){
    throw 'Device identity confirmation failed.'
  }
  $install=Join-Path $env:LOCALAPPDATA 'Programs\Tetherplane-Mesh'
  $state=Join-Path $env:LOCALAPPDATA ('Tetherplane\mesh\'+$id)
  $bundle=Split-Path -Parent $PSCommandPath
  Assert-MeshSafeInstall $bundle $install $state

  # The existing Vaulter relay is healthy but not supervised. Do not add a
  # background task on that host until operator recovery is independently proven.
  if($id -ceq 'Vaulter'){
    $relayTask=Get-ScheduledTask -TaskPath '\' -TaskName 'Tetherplane Relay' -ErrorAction SilentlyContinue
    if($null -eq $relayTask -or $relayTask.State -ne 'Running'){
      throw 'Vaulter supervised relay recovery is pending; no mesh agent was installed.'
    }
  }
  $defaultRoot=Join-Path $env:USERPROFILE 'Tetherplane-Mesh-Workspace'
  $root=$AllowedRoot
  if([string]::IsNullOrWhiteSpace($root)){
    $root=Read-Host ('Allowed workspace path (blank for '+$defaultRoot+')')
  }
  if([string]::IsNullOrWhiteSpace($root)){$root=$defaultRoot}
  if(-not [IO.Path]::IsPathRooted($root)){throw 'Allowed directory must be an absolute path.'}
  $root=[IO.Path]::GetFullPath($root).TrimEnd('\')
  $stateFull=[IO.Path]::GetFullPath($state)
  if($stateFull.StartsWith($root+'\', [StringComparison]::OrdinalIgnoreCase) -or
     $stateFull -ieq $root){
    throw 'Allowed root must never contain the protected mesh state or device credential.'
  }
  Assert-MeshOrdinaryPath $root
  if((Test-Path -LiteralPath $root) -and -not(Test-Path -LiteralPath $root -PathType Container)){
    throw 'Allowed root is not a directory.'
  }
  if(-not(Test-Path -LiteralPath $root) -and $root -ine $defaultRoot){
    throw 'Custom allowed root must already exist.'
  }

  # Only the credential hash is sent; raw bytes stay in this user session.
  $secret=New-MeshCredential
  $hash=Get-MeshCredentialHash $secret
  $pending=Start-MeshPairing $origin $id $hash
  $cred=Join-Path $state 'device.credential'
  $profile=Join-Path $state 'principal.json'
  $argsFile=Join-Path $state 'agent-args.json'
  if(-not(Test-Path -LiteralPath $root)){
    New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
  }
  New-Item -ItemType Directory -Path $state -ErrorAction Stop | Out-Null
  Set-MeshPrivateAcl $state -Directory
  $encoding=[Text.UTF8Encoding]::new($false)
  try{
    [IO.File]::WriteAllText($cred,$secret,$encoding)
    Set-MeshPrivateAcl $cred
  }finally{$secret=$null}
  $capabilities=@('device.status','device.capabilities',
    'filesystem.read','filesystem.read_many','filesystem.list','filesystem.info',
    'search.start','search.read','search.stop','search.list')
  $principal=[ordered]@{
    principal_id=('mesh:'+ $id)
    authentication='local_process_binding'
    allowed_devices=@($id)
    allowed_capabilities=$capabilities
    allowed_directories=@($root)
  }
  [IO.File]::WriteAllText($profile,($principal|ConvertTo-Json -Depth 5),$encoding)
  Set-MeshPrivateAcl $profile
  $arguments=@('--relay-url',$websocket,'--device-id',$id,
    '--device-credential-file',$cred,'--allow',$root,
    '--principal-profile',$profile,'--state-dir',$state)
  [IO.File]::WriteAllText($argsFile,($arguments|ConvertTo-Json),$encoding)
  Set-MeshPrivateAcl $argsFile
  $taskName=Get-MeshTaskName $id
  $installer=Join-Path $bundle 'install-windows.ps1'
  $hostPs=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $hostPs -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -PackagePath $bundle -InstallPrefix $install -StateDir $state -InstallScheduledTask -ScheduledTaskName $taskName -AgentArgumentsFile $argsFile
  if($LASTEXITCODE -ne 0){
    throw 'Installer failed; preserve the protected state and inspect before retry.'
  }
  Start-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction Stop
  $task=Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction Stop
  if($task.State -ne 'Running'){throw 'Background agent task did not reach Running.'}
  $manifest=Get-Content -LiteralPath (Join-Path $bundle 'manifest.json') -Raw | ConvertFrom-Json
  Write-Output ('MESH DEVICE INSTALLED: '+$id)
  Write-Output ('SOURCE COMMIT: '+[string]$manifest.source_commit)
  Write-Output ('APPROVE PAIRING CODE: '+[string]$pending.userCode)
  Write-Output ('PAIR CODE EXPIRES: '+[string]$pending.expiresAt)
  Write-Output 'Use an authenticated relay owner client to POST the userCode to /pair/approve.'
  Write-Output 'Device connection requires account approval. No token was shown or copied.'
  Write-Output 'Background agent uses per-user AtLogOn restart supervision; pre-login reboot recovery is not yet verified.'
}

# Dot-sourcing is used only by contract tests; normal invocation enrolls.
if($MyInvocation.InvocationName -ne '.'){
  try{Join-MeshDevice}catch{
    Write-Error ('MESH INSTALL STOPPED: '+$_.Exception.Message)
    exit 1
  }
}
