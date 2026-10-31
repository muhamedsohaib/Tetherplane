#requires -Version 5.1
<#
Local-only source and private-artwork packaging rehearsal for V5 Control Center.
Copies exact whitelisted runtime files to an ephemeral temp directory, starts
only a synthetic loopback portal with OAuth/authority disabled, verifies routes,
then terminates that test process and destroys the temp directory.
Do not publish or upload the staged private HTML/font.
#>
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$source=Join-Path $repo 'adapters\control-center-exact'
if(!(Test-Path (Join-Path $source 'public\index.html') -PathType Leaf) -or
   !(Test-Path (Join-Path $source 'public\tp-font.woff2') -PathType Leaf)){
 throw 'Missing approved Git-ignored V5 artwork. Do not substitute public placeholders.'
}
$trackedPrivate=@(git -C $repo ls-files -- adapters/control-center-exact/public/index.html adapters/control-center-exact/public/tp-font.woff2)
if($trackedPrivate.Count -ne 0){
 throw 'Approved private HTML/font are unexpectedly tracked by Git; refusing any release staging'
}
Write-Output 'PRIVATE_ARTWORK_NOT_GIT_TRACKED=PASS'
$files=@(
 'oauth.mjs','server.mjs','authority.mjs','authority-http.mjs',
 'authority-audit.mjs','authority-access.mjs','owner-leno-proxy.mjs',
 'public\index.html','public\tp-font.woff2',
 'public\tp-integration.js','public\tp-oauth.js',
 'public\tp-authority.js','public\tp-owner-leno.js'
)
$temp=Join-Path $env:TEMP ('Tetherplane-V5-PRIVATE-STAGE-TEST-'+[guid]::NewGuid().ToString('N'))
$package=Join-Path $temp 'stage'
$child=$null
$http=$null
$knownHtml='4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8'
$knownFont='18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e'
function HashBytes([byte[]]$bytes) {
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
 finally{$sha.Dispose()}
}
try{
 New-Item -ItemType Directory -Path $package -Force|Out-Null
 foreach($f in $files){
  $src=Join-Path $source $f
  if(!(Test-Path -LiteralPath $src -PathType Leaf)){throw ('Required runtime source missing: '+$f)}
  $item=Get-Item -LiteralPath $src -Force
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw ('Untrusted reparse runtime source: '+$f)}
  $dst=Join-Path $package $f
  New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force|Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -ErrorAction Stop
  $before=(Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
  $after=(Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
  if($before -cne $after){throw ('Copy hash mismatch: '+$f)}
 }
 Write-Output ('STAGED_RUNTIME_FILE_COUNT='+$files.Count)
 Write-Output 'STAGE_HASHES=PASS'
 if((Get-FileHash -LiteralPath (Join-Path $package 'public\index.html') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $knownHtml){throw 'V5 HTML provenance mismatch'}
 if((Get-FileHash -LiteralPath (Join-Path $package 'public\tp-font.woff2') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $knownFont){throw 'V5 private font provenance mismatch'}
 Write-Output 'APPROVED_ARTWORK_PROVENANCE=PASS'

 $node=(Get-Command node.exe -ErrorAction Stop).Source
 foreach($f in $files){
  if($f -notmatch '[.](mjs|js)$'){continue}
  & $node --check (Join-Path $package $f) 1>$null
  if($LASTEXITCODE -ne 0){throw ('Packaged syntax error: '+$f)}
 }
 Write-Output 'RUNTIME_MODULE_SYNTAX=PASS'

 $tcp=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
 try{$tcp.Start();$port=([Net.IPEndPoint]$tcp.LocalEndpoint).Port}
 finally{$tcp.Stop()}
 $out=Join-Path $temp 'synthetic-portal-stdout.log'
 $err=Join-Path $temp 'synthetic-portal-stderr.log'
 $app=Join-Path $package 'oauth.mjs'
 $child=Start-Process -FilePath $node -ArgumentList @(
    ('"'+$app+'"'),'--port',"$port",'--relay-url','https://relay.invalid'
 ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
 Add-Type -AssemblyName System.Net.Http
 $http=[Net.Http.HttpClient]::new()
 $http.Timeout=[TimeSpan]::FromSeconds(3)
 $base="http://127.0.0.1:$port"
 $ready=$false
 for($i=0;$i -lt 60;$i++){
   $child.Refresh()
   if($child.HasExited){throw 'Isolated portal terminated before readiness'}
   try{
     $resp=$http.GetAsync($base+'/').GetAwaiter().GetResult()
     if([int]$resp.StatusCode -eq 200){$ready=$true;break}
   }catch{}
   Start-Sleep -Milliseconds 120
 }
 if(!$ready){throw 'Isolated V5 code package never served the landing page'}
 Write-Output 'ISOLATED_PORTAL_HTTP=PASS'
 $fontResponse=$http.GetAsync($base+'/tp-font.woff2').GetAwaiter().GetResult()
 if([int]$fontResponse.StatusCode -ne 200){throw 'Private font endpoint unavailable'}
 $fontBytes=$fontResponse.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
 if((HashBytes $fontBytes) -cne $knownFont){throw 'Served font bytes changed'}
 Write-Output 'SERVED_PRIVATE_FONT_HASH=PASS'
 $scriptResponse=$http.GetAsync($base+'/tp-integration.js').GetAwaiter().GetResult()
 if([int]$scriptResponse.StatusCode -ne 200){throw 'V5 integration script failed'}
 $scriptText=$scriptResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
 $expectedText=[IO.File]::ReadAllText((Join-Path $package 'public\tp-integration.js'))+
  [char]10+[IO.File]::ReadAllText((Join-Path $package 'public\tp-oauth.js'))
 if($scriptText -cne $expectedText){throw 'Without authority opt-in, JS response must equal approved five-card plus OAuth modules only'}
 if($scriptText.Contains('tp-leno-owner-section') -or $scriptText.Contains('tp-authority-open')){
  throw 'Owner or authority UI was unexpectedly exposed without opt-in'
 }
 $ownerEndpoint=$http.GetAsync($base+'/api/owner-leno').GetAwaiter().GetResult()
 if([int]$ownerEndpoint.StatusCode -eq 200){throw 'Owner-management endpoint must not load without opt-in'}
 Write-Output 'DISABLED_OWNER_FEATURE_FAILS_CLOSED=PASS'
 Write-Output 'STAGED_CODE_NEVER_TOUCHED_PRODUCTION_CONFIG=TRUE'
}finally{
 if($http){$http.Dispose()}
 if($child){
  try{
   $child.Refresh()
   if(!$child.HasExited){Stop-Process -Id $child.Id -Force -ErrorAction Stop}
   [void]$child.WaitForExit(5000)
   Write-Output ('SYNTHETIC_PORTAL_PROCESS_STOPPED='+$child.HasExited)
  }finally{$child.Dispose()}
 }
 if(Test-Path -LiteralPath $temp){
  Remove-Item -LiteralPath $temp -Recurse -Force
 }
 Write-Output 'PRIVATE_TEST_PACKAGE_REMOVED=TRUE'
}
