# Smart App Control signing readiness contract.
# Synthetic only. No real certificate, signing service, tasks or live machines.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$verify=Join-Path $repo 'scripts\verify-windows-mesh-signatures.ps1'
$finalize=Join-Path $repo 'scripts\finalize-windows-mesh-signed.ps1'
foreach($file in @($verify,$finalize)){
  if(-not(Test-Path -LiteralPath $file -PathType Leaf)){
    throw 'RED: Windows trusted-publisher distribution scripts are missing'
  }
  $tokens=$null;$errors=$null
  [Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)|Out-Null
  if(@($errors).Count -gt 0){throw 'Signing-distribution script syntax invalid'}
}
$verifierText=[IO.File]::ReadAllText($verify)
$finalizerText=[IO.File]::ReadAllText($finalize)
foreach($required in @('Get-AuthenticodeSignature','Valid','manifest.json','tetherd.exe','Join-Tetherplane-Mesh.ps1','Inspect-Tetherplane-Mesh.ps1','signed_package')){
  if(-not $verifierText.Contains($required)){throw "RED: missing signing-verification contract $required"}
}
foreach($required in @('verify-windows-mesh-signatures.ps1','Get-MeshSignedFiles','Assert-MeshSignedPayload','Assert-MeshSignedPackage','signed_package')){
  if(-not $finalizerText.Contains($required)){throw "RED: missing signed-package finalization contract $required"}
}
foreach($required in @('mesh_join_sha256','mesh_inspect_sha256','mesh_uninstall_sha256','windows_installer_sha256','tetherd_sha256')){
  if(-not $verifierText.Contains($required)){throw "RED: required signed package hash pin missing: $required"}
}
foreach($unsafe in @('-ExecutionPolicy Bypass','Unblock-File','Set-MpPreference','Stop-ScheduledTask','Stop-Process')){
  if($verifierText.Contains($unsafe) -or $finalizerText.Contains($unsafe)){
    throw "Signing workflow must not override Windows security or live machines: $unsafe"
  }
}

$root=Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-signed-contract-'+[guid]::NewGuid().ToString('N'))
$package=Join-Path $root 'unsigned'
$output=Join-Path $root 'signed'
try{
  New-Item -ItemType Directory -Force -Path $package|Out-Null
  $payload=Join-Path $package 'Join-Tetherplane-Mesh.ps1'
  [IO.File]::WriteAllText($payload,'Write-Output "synthetic and unsigned"')
  $manifest=[ordered]@{
    name='Tetherplane'
    platform='windows'
    architecture='x64'
    source_commit=('a'*40)
    signed_package=$false
    default_mcp_tools=@('device','files','process','browser','desktop','batch')
  }
  $manifest|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $package 'manifest.json') -Encoding UTF8
  $before=(Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash

  # Child stderr is redirected to a temporary file so intentional rejection
  # cannot be misinterpreted as a terminating PowerShell ErrorRecord.
  $verifyOut=Join-Path $root 'verify.out'
  $verifyErr=Join-Path $root 'verify.err'
  $verifyArgs='-NoProfile -NonInteractive -File "'+$verify+'" -PackagePath "'+$package+'"'
  $verifyProcess=Start-Process -FilePath 'powershell.exe' -ArgumentList $verifyArgs -Wait -PassThru -RedirectStandardOutput $verifyOut -RedirectStandardError $verifyErr
  if($verifyProcess.ExitCode -eq 0){throw 'Unsigned package incorrectly passed trust verification'}
  $out=Get-Content -LiteralPath $verifyErr -Raw -ErrorAction Stop
  if($out -notmatch 'unsigned|untrusted|not signed|signed_package'){
    throw 'Unsigned verification failure did not identify the trust problem'
  }

  $finalOut=Join-Path $root 'finalize.out'
  $finalErr=Join-Path $root 'finalize.err'
  $finalArgs='-NoProfile -NonInteractive -File "'+$finalize+'" -SignedPackagePath "'+$package+'" -OutputPath "'+$output+'"'
  $finalProcess=Start-Process -FilePath 'powershell.exe' -ArgumentList $finalArgs -Wait -PassThru -RedirectStandardOutput $finalOut -RedirectStandardError $finalErr
  if($finalProcess.ExitCode -eq 0){throw 'Unsigned package incorrectly finalized as trusted'}
  if(Test-Path -LiteralPath $output){throw 'Rejected unsigned input created signed output files'}
  if((Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash -cne $before){
    throw 'Rejected signing attempt modified the input package'
  }

  Write-Output 'WINDOWS_SAC_SIGNING_FAIL_CLOSED_CONTRACT_OK'
}finally{
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
