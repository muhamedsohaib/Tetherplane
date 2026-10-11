<#
.SYNOPSIS
  Reject unsigned or untrusted Windows mesh distributions.
.DESCRIPTION
  Read-only Authenticode and content integrity verification. Windows Smart App
  Control makes the final execution decision; this script does not disable,
  reconfigure, or attempt to bypass any Windows security control.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [string]$PackagePath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Get-MeshSignedFiles {
  # Only Tetherplane-authored launch/runtime code. Dependencies retain their
  # upstream signatures; their trust is independently enforced by Windows.
  return @(
    [pscustomobject]@{Path='Join-Tetherplane-Mesh.ps1';Pin='mesh_join_sha256'},
    [pscustomobject]@{Path='Inspect-Tetherplane-Mesh.ps1';Pin='mesh_inspect_sha256'},
    [pscustomobject]@{Path='Uninstall-Tetherplane-Mesh.ps1';Pin='mesh_uninstall_sha256'},
    [pscustomobject]@{Path='install-windows.ps1';Pin='windows_installer_sha256'},
    [pscustomobject]@{Path='uninstall-windows.ps1';Pin=$null},
    [pscustomobject]@{Path='install-model-worker-windows.ps1';Pin=$null},
    [pscustomobject]@{Path='launch\tetherplane-agent.ps1';Pin=$null},
    [pscustomobject]@{Path='launch\tetherplane-mcp.ps1';Pin=$null},
    [pscustomobject]@{Path='bin\tetherd.exe';Pin='tetherd_sha256'}
  )
}

function Assert-MeshSignedPayload([string]$Root) {
  if(-not(Test-Path -LiteralPath $Root -PathType Container)){
    throw 'Signed package directory does not exist.'
  }
  $folder=Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  if($folder.Attributes -band [IO.FileAttributes]::ReparsePoint){
    throw 'Signed package directory must not be a reparse point.'
  }
  $signers=@()
  foreach($entry in @(Get-MeshSignedFiles)){
    $file=Join-Path $Root $entry.Path
    if(-not(Test-Path -LiteralPath $file -PathType Leaf)){
      throw ('Signed package is missing '+$entry.Path)
    }
    $item=Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){
      throw ('Signed package contains a reparse point at '+$entry.Path)
    }
    $signature=Get-AuthenticodeSignature -LiteralPath $file -ErrorAction Stop
    if([string]$signature.Status -cne 'Valid' -or $null -eq $signature.SignerCertificate){
      throw ('Unsigned or untrusted executable: '+$entry.Path)
    }
    $thumb=[string]$signature.SignerCertificate.Thumbprint
    if($thumb -notmatch '^[a-fA-F0-9]{40,64}$'){
      throw ('Invalid publisher certificate identity for '+$entry.Path)
    }
    $signers+= $thumb.ToUpperInvariant()
  }
  $unique=@($signers|Select-Object -Unique)
  if($unique.Count -ne 1){throw 'A signed mesh package must use a single, consistent trusted publisher.'}
  return [string]$unique[0]
}

function Assert-MeshSignedPackage([string]$Root) {
  $manifestPath=Join-Path $Root 'manifest.json'
  if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){
    throw 'Signed package manifest is missing.'
  }
  $manifest=Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
  if($manifest.PSObject.Properties.Name -notcontains 'signed_package' -or
     $manifest.signed_package -ne $true){
    throw 'This is an unsigned package, not a trusted signed distribution.'
  }
  if([string]$manifest.platform -cne 'windows' -or
     [string]$manifest.architecture -cne 'x64' -or
     [string]$manifest.source_commit -cnotmatch '^[a-f0-9]{40}$'){
    throw 'Signed manifest does not describe the reviewed Windows x64 source.'
  }
  $tools=@($manifest.default_mcp_tools)
  if(($tools -join ',') -cne 'device,files,process,browser,desktop,batch'){
    throw 'Signed mesh package must retain exactly the six canonical MCP tools.'
  }
  foreach($batchLauncher in @('Join-Tetherplane-Mesh.cmd','Inspect-Tetherplane-Mesh.cmd')){
    if(Test-Path -LiteralPath (Join-Path $Root $batchLauncher)){
      throw ('Signed distribution must not advertise an un-signable Internet batch launcher: '+$batchLauncher)
    }
  }
  $publisher=Assert-MeshSignedPayload $Root
  if([string]$manifest.signed_signer_thumbprint -cne $publisher){
    throw 'Signed manifest publisher identity disagrees with Authenticode signatures.'
  }
  foreach($entry in @(Get-MeshSignedFiles)){
    if($null -eq $entry.Pin){continue}
    $pin=[string]$manifest.($entry.Pin)
    if($pin -notmatch '^[a-fA-F0-9]{64}$'){
      throw ('Signed manifest lacks a valid SHA-256 for '+$entry.Path)
    }
    $actual=(Get-FileHash -LiteralPath (Join-Path $Root $entry.Path) -Algorithm SHA256).Hash
    if(-not [string]::Equals($pin,$actual,[StringComparison]::OrdinalIgnoreCase)){
      throw ('Signed package content integrity mismatch: '+$entry.Path)
    }
  }
  return [pscustomobject]@{
    verified=$true
    source_commit=[string]$manifest.source_commit
    signed_file_count=@(Get-MeshSignedFiles).Count
    # The signed publisher public thumbprint is non-secret, but need not be
    # printed in routine operator logs.
  }
}

if($MyInvocation.InvocationName -ne '.'){
  try{
    $resolved=(Resolve-Path -LiteralPath $PackagePath -ErrorAction Stop).Path
    $proof=Assert-MeshSignedPackage $resolved
    Write-Output ('SIGNED_MESH_PACKAGE_VERIFIED: '+$proof.source_commit)
    Write-Output 'Authenticode signatures, signer consistency and package hashes passed.'
    Write-Output 'Smart App Control compatibility still requires a trusted CA and operator-observed launch.'
  }catch{
    Write-Error ('SIGNED_MESH_VERIFICATION_BLOCKED: '+$_.Exception.Message)
    exit 1
  }
}
