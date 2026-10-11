<#
.SYNOPSIS
  Assemble a Windows mesh package after external trusted code signing.
.DESCRIPTION
  Takes an independently signed staging directory (for example, from an
  approved open-source signing provider), validates all first-party
  Authenticode signatures, and creates a separate distribution. Never signs
  with a self-signed certificate, changes machine policy, or operates on
  installed agents. Requires a trusted publisher; rejects unsigned inputs.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SignedPackagePath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Assert-MeshFreshDestination([string]$Source,[string]$Target) {
  if(-not[IO.Path]::IsPathRooted($Target)){
    throw 'Final signing output must be an absolute directory.'
  }
  $full=[IO.Path]::GetFullPath($Target).TrimEnd('\')
  $sourceFull=[IO.Path]::GetFullPath($Source).TrimEnd('\')
  if([string]::Equals($full,$sourceFull,[StringComparison]::OrdinalIgnoreCase) -or
     $full.StartsWith($sourceFull+'\',[StringComparison]::OrdinalIgnoreCase) -or
     $sourceFull.StartsWith($full+'\',[StringComparison]::OrdinalIgnoreCase)){
    throw 'Signed output must not overlap the staging directory.'
  }
  if(Test-Path -LiteralPath $full){
    throw 'Signed output already exists; refusing to overwrite it.'
  }
  $parent=[IO.Path]::GetDirectoryName($full)
  if(-not(Test-Path -LiteralPath $parent -PathType Container)){
    throw 'Signed output parent must already exist.'
  }
  $parentItem=Get-Item -LiteralPath $parent -Force
  if($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint){
    throw 'Signed output parent cannot be a reparse point.'
  }
  return $full
}

function Complete-SignedMeshPackage {
  if($env:OS -ne 'Windows_NT'){throw 'Windows Authenticode is required.'}
  $stage=(Resolve-Path -LiteralPath $SignedPackagePath -ErrorAction Stop).Path
  $verify=Join-Path $PSScriptRoot 'verify-windows-mesh-signatures.ps1'
  if(-not(Test-Path -LiteralPath $verify -PathType Leaf)){
    throw 'Independent signed package verifier is missing.'
  }
  . $verify -PackagePath $stage
  $destination=Assert-MeshFreshDestination $stage $OutputPath
  $archive=$destination+'.zip'
  $sums=$destination+'.SHA256SUMS.txt'
  if((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $sums)){
    throw 'Signed distribution archive or checksum already exists.'
  }
  $manifestPath=Join-Path $stage 'manifest.json'
  if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){
    throw 'Signed input is missing the source manifest.'
  }
  $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json -ErrorAction Stop
  if([string]$manifest.source_commit -cnotmatch '^[a-f0-9]{40}$' -or
     [string]$manifest.platform -cne 'windows' -or
     [string]$manifest.architecture -cne 'x64'){
    throw 'Signed input does not identify the reviewed Windows source.'
  }
  if($manifest.PSObject.Properties.Name -contains 'signed_package' -and
     $manifest.signed_package -eq $true){
    throw 'Signed source is already finalized; refusing to silently repackage it.'
  }
  # Verify the actual publisher identity before creating any output.
  $signer=Assert-MeshSignedPayload $stage
  $reparse=@(Get-ChildItem -LiteralPath $stage -Recurse -Force -ErrorAction Stop|
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }|Select-Object -First 1)
  if($reparse.Count -gt 0){throw 'Signed source cannot contain reparse-point content.'}

  $created=$false
  try{
    New-Item -ItemType Directory -Path $destination -ErrorAction Stop|Out-Null
    $created=$true
    Get-ChildItem -LiteralPath $stage -Force -ErrorAction Stop|ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -ErrorAction Stop
    }
    # Batch scripts cannot carry the trusted embedded Authenticode signature
    # expected for launchers downloaded from the internet. The signed scripts
    # are the only entrypoints of this distribution.
    foreach($legacyLauncher in @('Join-Tetherplane-Mesh.cmd','Inspect-Tetherplane-Mesh.cmd')){
      $legacyPath=Join-Path $destination $legacyLauncher
      if(Test-Path -LiteralPath $legacyPath -PathType Leaf){
        Remove-Item -LiteralPath $legacyPath -Force -ErrorAction Stop
      }
    }
    foreach($entry in @(Get-MeshSignedFiles)){
      if($null -ne $entry.Pin){
        $sha=(Get-FileHash -LiteralPath (Join-Path $destination $entry.Path) -Algorithm SHA256).Hash
        $manifest|Add-Member -NotePropertyName $entry.Pin -NotePropertyValue $sha -Force
      }
    }
    $manifest|Add-Member -NotePropertyName 'signed_package' -NotePropertyValue $true -Force
    $manifest|Add-Member -NotePropertyName 'distribution_trust' -NotePropertyValue 'trusted_publisher_authenticode' -Force
    $manifest|Add-Member -NotePropertyName 'signed_signer_thumbprint' -NotePropertyValue $signer -Force
    $manifest|Add-Member -NotePropertyName 'signing_verification' -NotePropertyValue 'Windows Authenticode; trusted OS chain' -Force
    $encoding=[Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $destination 'manifest.json'),($manifest|ConvertTo-Json -Depth 7),$encoding)

    $instructions=@'
TETHERPLANE WINDOWS MESH - AUTHENTICODE-SIGNED DISTRIBUTION

From a normal Windows PowerShell session in this extracted directory:

  powershell.exe -NoProfile -File .\Inspect-Tetherplane-Mesh.ps1
  powershell.exe -NoProfile -File .\Join-Tetherplane-Mesh.ps1

Never disable Smart App Control, alter execution policy, or run the
unsigned .cmd launcher. Check publisher signature and SHA256SUMS first.
Enrollment still needs the authenticated relay owner's approval.
No existing Tetherplane installation, task, or credential is replaced.

This package was finalized from separately signed input files. Windows
Smart App Control must independently accept the publisher on each device.
'@
    [IO.File]::WriteAllText((Join-Path $destination 'SIGNED-INSTALL-INSTRUCTIONS.txt'),$instructions,$encoding)
    $proof=Assert-MeshSignedPackage $destination
    if(-not $proof.verified){throw 'Signed distribution verification did not pass.'}
    Compress-Archive -Path (Join-Path $destination '*') -DestinationPath $archive -ErrorAction Stop
    $digest=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($sums,($digest+'  '+[IO.Path]::GetFileName($archive)+[Environment]::NewLine),$encoding)
    Write-Output ('SIGNED_MESH_DISTRIBUTION_READY: '+$proof.source_commit)
    Write-Output ('ARCHIVE: '+$archive)
    Write-Output ('SHA256SUMS: '+$sums)
    Write-Output 'User/OS verification is required before declaring Smart App Control compatibility.'
  }catch{
    if($created -and (Test-Path -LiteralPath $destination)){
      Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
    }
    if(Test-Path -LiteralPath $archive){Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue}
    if(Test-Path -LiteralPath $sums){Remove-Item -LiteralPath $sums -Force -ErrorAction SilentlyContinue}
    throw
  }
}

if($MyInvocation.InvocationName -ne '.'){
  try{Complete-SignedMeshPackage}catch{
    Write-Error ('SIGNED_MESH_FINALIZATION_BLOCKED: '+$_.Exception.Message)
    exit 1
  }
}
