#requires -Version 7.4
<#
SYNTHETIC ONLY: independent-key escrow mechanics, not a production backup tool.
Creates ephemeral RSA key and in-memory AES-GCM ciphertext, launches a separate
PowerShell process to decrypt a synthetic payload without DPAPI or cert store.
Never reads production files or touches tasks, auth, Windows cert stores or RTX.
#>
[CmdletBinding()]
param(
 [ValidateSet('SelfTest','RecoverTest')] [string]$Mode='SelfTest',
 [string]$FixtureDir=''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$prefix='TP-V5-SYNTHETIC-ESCROW-'
$mark='SYNTHETIC_ONLY_NOT_PRODUCTION'
$schema='tetherplane.synthetic.portable-recovery.v1'
$utf8=[Text.UTF8Encoding]::new($false)
function Assert([bool]$test,[string]$reason){
 if(!$test){throw ('SYNTHETIC_ESCROW_DENIED: '+$reason)}
}
function Sha([byte[]]$bytes){
 $h=[Security.Cryptography.SHA256]::Create()
 try{return ([Convert]::ToHexString($h.ComputeHash($bytes))).ToLowerInvariant()}
 finally{$h.Dispose()}
}
function SafeDir([string]$path){
 $full=[IO.Path]::GetFullPath($path)
 $temp=([IO.Path]::GetFullPath($env:TEMP)).TrimEnd('\')+'\'
 Assert ($full.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)) 'must be under temp'
 Assert ([IO.Path]::GetFileName($full).StartsWith($prefix,[StringComparison]::Ordinal)) 'unexpected root'
 return $full
}
function Recover([string]$dir){
 $dir=SafeDir $dir
 Assert (([IO.File]::ReadAllText((Join-Path $dir 'fixture-marker.txt'))) -ceq $mark) 'marker not synthetic'
 $output=Join-Path $dir 'restored-synthetic.txt'
 Assert (!(Test-Path -LiteralPath $output)) 'refuse to overwrite previous restore'
 $password=[Environment]::GetEnvironmentVariable('TP_ONLY_SYNTHETIC_PFX_PASSWORD')
 Assert (![string]::IsNullOrWhiteSpace($password)) 'missing ephemeral test key password'
 $private=[Security.Cryptography.X509Certificates.X509Certificate2]::new(
  (Join-Path $dir 'private-test-only.pfx'),$password,
  [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
 try{
  $data=([IO.File]::ReadAllText((Join-Path $dir 'encrypted.json'))|ConvertFrom-Json)
  Assert ($data.schema -ceq $schema -and $data.marker -ceq $mark) 'invalid synthetic envelope'
  Assert ($data.recipientThumbprint -ceq $private.Thumbprint) 'wrong recipient'
  Assert ($data.wrap -ceq 'RSA-OAEP-SHA256' -and $data.cipher -ceq 'AES-256-GCM') 'algorithm downgrade'
  $rsa=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($private)
  Assert ($null -ne $rsa) 'no private key'
  try{
   $key=$rsa.Decrypt([Convert]::FromBase64String($data.wrappedKey),
    [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
   try{
    Assert ($key.Length -eq 32) 'invalid AES key'
    $nonce=[Convert]::FromBase64String($data.nonce)
    $cipher=[Convert]::FromBase64String($data.ciphertext)
    $tag=[Convert]::FromBase64String($data.tag)
    Assert ($nonce.Length -eq 12 -and $tag.Length -eq 16 -and $cipher.Length -gt 1) 'invalid cipher length'
    $plain=New-Object byte[] $cipher.Length
    $aes=[Security.Cryptography.AesGcm]::new($key,16)
    try{
     $aes.Decrypt($nonce,$cipher,$tag,$plain,
       $utf8.GetBytes($schema+'|'+$data.recipientThumbprint))
    }finally{$aes.Dispose()}
    $pin=[IO.File]::ReadAllText((Join-Path $dir 'independent-pin.txt')).Trim()
    Assert ($pin -cmatch '^[0-9a-f]{64}$') 'pin malformed'
    Assert ((Sha $plain) -ceq $pin) 'independent receipt pin mismatch'
    Assert (($utf8.GetString($plain)).StartsWith($mark,[StringComparison]::Ordinal)) 'not a synthetic fixture'
    [IO.File]::WriteAllBytes($output,$plain)
    Assert ((Sha ([IO.File]::ReadAllBytes($output))) -ceq $pin) 'restore output differs'
    [Array]::Clear($plain,0,$plain.Length)
    Write-Output 'CROSS_PROCESS_EPHEMERAL_CERTIFICATE_RESTORE=PASS'
   }finally{[Array]::Clear($key,0,$key.Length)}
  }finally{$rsa.Dispose()}
 }finally{$private.Dispose()}
}
if($Mode -eq 'RecoverTest'){Recover $FixtureDir;exit 0}

$root=Join-Path $env:TEMP ($prefix+[guid]::NewGuid().ToString('N'))
$cert=$null;$public=$null;$rsa=$null
try{
 [void](New-Item -ItemType Directory -Path $root -Force)
 [IO.File]::WriteAllText((Join-Path $root 'fixture-marker.txt'),$mark,$utf8)
 $rsa=[Security.Cryptography.RSA]::Create(3072)
 $req=[Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=Tetherplane Synthetic Escrow Only',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,
  [Security.Cryptography.RSASignaturePadding]::Pkcs1)
 $cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddHours(1))
 $public=[Security.Cryptography.X509Certificates.X509Certificate2]::new(
  $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
 $pass=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
 [IO.File]::WriteAllBytes((Join-Path $root 'private-test-only.pfx'),
  $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$pass))
 [IO.File]::WriteAllBytes((Join-Path $root 'public-test-only.cer'),
  $public.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
 $payload=$utf8.GetBytes($mark+([char]10)+'{"devices":["Leno","Surface","VAULTER","RTX"],"notReal":true}')
 [IO.File]::WriteAllText((Join-Path $root 'independent-pin.txt'),(Sha $payload),$utf8)
 $key=[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
 try{
  $nonce=[Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
  $tag=New-Object byte[] 16
  $cipher=New-Object byte[] $payload.Length
  $aes=[Security.Cryptography.AesGcm]::new($key,16)
  try{$aes.Encrypt($nonce,$payload,$cipher,$tag,
     $utf8.GetBytes($schema+'|'+$public.Thumbprint))}finally{$aes.Dispose()}
  $pubRSA=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($public)
  try{$wrapped=$pubRSA.Encrypt($key,[Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)}
  finally{$pubRSA.Dispose()}
 }finally{[Array]::Clear($key,0,$key.Length);[Array]::Clear($payload,0,$payload.Length)}
 $envelope=[ordered]@{
  schema=$schema;marker=$mark;recipientThumbprint=$public.Thumbprint;
  wrap='RSA-OAEP-SHA256';cipher='AES-256-GCM';
  nonce=[Convert]::ToBase64String($nonce);
  wrappedKey=[Convert]::ToBase64String($wrapped);
  ciphertext=[Convert]::ToBase64String($cipher);
  tag=[Convert]::ToBase64String($tag)
 }
 $enc=Join-Path $root 'encrypted.json'
 [IO.File]::WriteAllText($enc,(ConvertTo-Json $envelope -Depth 4),$utf8)
 Write-Output 'EPHEMERAL_RSA_KEY_ONLY_NO_CERTIFICATE_STORE_CHANGES=TRUE'
 Write-Output 'AES256_GCM_RSA_OAEP_SHA256_ENVELOPE=CREATED'
 $env:TP_ONLY_SYNTHETIC_PFX_PASSWORD=$pass
 try{
  $log=Join-Path $root 'child-output.txt'
  & pwsh.exe -NoProfile -NonInteractive -File $PSCommandPath -Mode RecoverTest -FixtureDir $root > $log 2>&1
  Assert ($LASTEXITCODE -eq 0) 'separate process restore failed'
  Assert ((Get-Content -LiteralPath $log -Raw).Contains('CROSS_PROCESS_EPHEMERAL_CERTIFICATE_RESTORE=PASS')) 'child verification missing'
  Remove-Item -LiteralPath (Join-Path $root 'restored-synthetic.txt') -Force
  Write-Output 'CROSS_PROCESS_PORTABLE_RECOVERY=PASS'
  $env:TP_ONLY_SYNTHETIC_PFX_PASSWORD='incorrect-synthetic-password'
  & pwsh.exe -NoProfile -NonInteractive -File $PSCommandPath -Mode RecoverTest -FixtureDir $root > $log 2>&1
  Assert ($LASTEXITCODE -ne 0 -and !(Test-Path -LiteralPath (Join-Path $root 'restored-synthetic.txt'))) 'wrong key password accepted'
  Write-Output 'WRONG_PRIVATE_KEY_PASSWORD_DENIED=PASS'
  $env:TP_ONLY_SYNTHETIC_PFX_PASSWORD=$pass
  $original=[IO.File]::ReadAllText($enc)
  $modified=$original|ConvertFrom-Json
  $bytes=[Convert]::FromBase64String($modified.ciphertext)
  $bytes[0]=$bytes[0] -bxor 1
  $modified.ciphertext=[Convert]::ToBase64String($bytes)
  [IO.File]::WriteAllText($enc,(ConvertTo-Json $modified -Depth 4),$utf8)
  try{
   & pwsh.exe -NoProfile -NonInteractive -File $PSCommandPath -Mode RecoverTest -FixtureDir $root > $log 2>&1
   Assert ($LASTEXITCODE -ne 0 -and !(Test-Path -LiteralPath (Join-Path $root 'restored-synthetic.txt'))) 'tampered GCM ciphertext accepted'
   Write-Output 'TAMPERED_CIPHERTEXT_DENIED=PASS'
  }finally{[IO.File]::WriteAllText($enc,$original,$utf8)}
  $pinfile=Join-Path $root 'independent-pin.txt'
  $pin=[IO.File]::ReadAllText($pinfile)
  [IO.File]::WriteAllText($pinfile,('0'*64),$utf8)
  try{
   & pwsh.exe -NoProfile -NonInteractive -File $PSCommandPath -Mode RecoverTest -FixtureDir $root > $log 2>&1
   Assert ($LASTEXITCODE -ne 0 -and !(Test-Path -LiteralPath (Join-Path $root 'restored-synthetic.txt'))) 'wrong pinned receipt accepted'
   Write-Output 'SEPARATELY_PINNED_RECEIPT_HASH_MISMATCH_DENIED=PASS'
  }finally{[IO.File]::WriteAllText($pinfile,$pin,$utf8)}
  $keyFile=Join-Path $root 'private-test-only.pfx'
  $unavailableKey=$keyFile+'.unavailable'
  Move-Item -LiteralPath $keyFile -Destination $unavailableKey -ErrorAction Stop
  try{
   & pwsh.exe -NoProfile -NonInteractive -File $PSCommandPath -Mode RecoverTest -FixtureDir $root > $log 2>&1
   Assert ($LASTEXITCODE -ne 0 -and !(Test-Path -LiteralPath (Join-Path $root 'restored-synthetic.txt'))) 'unavailable private key unexpectedly recovered'
   Write-Output 'PRIVATE_RECOVERY_KEY_UNAVAILABLE_DENIED=PASS'
  }finally{Move-Item -LiteralPath $unavailableKey -Destination $keyFile -ErrorAction Stop}
 }finally{Remove-Item Env:\TP_ONLY_SYNTHETIC_PFX_PASSWORD -ErrorAction SilentlyContinue}
 Write-Output 'SYNTHETIC_ONLY_NO_DPAPI_OR_PRODUCTION_SECRETS=TRUE'
}finally{
 if($public){$public.Dispose()}
 if($cert){$cert.Dispose()}
 if($rsa){$rsa.Dispose()}
 if(Test-Path -LiteralPath $root){
  $full=SafeDir $root
  Remove-Item -LiteralPath $full -Recurse -Force
 }
 Write-Output 'EPHEMERAL_CERTIFICATE_AND_TEST_FILES_REMOVED=TRUE'
}
