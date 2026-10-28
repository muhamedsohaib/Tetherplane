# Review-only, ephemeral Microsoft WebView2 typed-host acceptance.
# No account profiles, external sites, agent restarts or production changes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedPackageHash = '56F7F4B8BF9AEE4B8EFEFBBDD4F67D5F74EBD1B100ED0806DA71BF76AF481AA9'
$expectedNugetHash = '92DBED160DDEE0F64B901E907439E021211B428E57C089ECC12FC38DCC4BD9A5'
$root = Join-Path $env:TEMP ('tp-webview2-owned-build-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $PSScriptRoot 'WebView2OwnedHost.cs'
$nodeTest = Join-Path $PSScriptRoot 'owned-host-acceptance.mjs'
try {
  if (-not [IO.File]::Exists($source)) { throw 'WEBVIEW2_OWNED_HOST_SOURCE_MISSING' }
  if (-not [IO.File]::Exists($nodeTest)) { throw 'WEBVIEW2_OWNED_TEST_MISSING' }
  $compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not [IO.File]::Exists($compiler)) { throw 'FRAMEWORK_CSC_MISSING' }
  [void][IO.Directory]::CreateDirectory($root)
  $nuget = Join-Path $root 'nuget.exe'
  $package = Join-Path $root 'webview2.nupkg'
  Invoke-WebRequest -Uri 'https://dist.nuget.org/win-x86-commandline/v6.14.0/nuget.exe' -UseBasicParsing -OutFile $nuget -TimeoutSec 50
  if ((Get-FileHash -LiteralPath $nuget -Algorithm SHA256).Hash -ne $expectedNugetHash) { throw 'NUGET_SHA256_MISMATCH' }
  $sig = Get-AuthenticodeSignature -FilePath $nuget
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft') { throw 'NUGET_SIGNER_INVALID' }
  Invoke-WebRequest -Uri 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4258.31/microsoft.web.webview2.1.0.4258.31.nupkg' -UseBasicParsing -OutFile $package -TimeoutSec 70
  if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $expectedPackageHash) { throw 'WEBVIEW2_NUPKG_HASH_MISMATCH' }
  $signLines = @(& $nuget verify -Signatures $package -NonInteractive -ForceEnglishOutput -Verbosity normal 2>&1)
  if ($LASTEXITCODE -ne 0 -or ($signLines -join ' ') -notmatch 'Subject Name: CN=Microsoft Corporation') {
    throw 'MICROSOFT_WEBVIEW2_AUTHOR_SIGNATURE_NOT_VERIFIED'
  }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($package)
  try {
    foreach ($file in @(
      'lib/net462/Microsoft.Web.WebView2.Core.dll',
      'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
      'runtimes/win-x64/native/WebView2Loader.dll'
    )) {
      $item = $zip.GetEntry($file)
      if ($null -eq $item) { throw ('MISSING_PACKAGE_ENTRY=' + $file) }
      $dest = Join-Path $root $item.Name
      [IO.Compression.ZipFileExtensions]::ExtractToFile($item, $dest, $true)
      $itemSignature = Get-AuthenticodeSignature -FilePath $dest
      if ($itemSignature.Status -ne 'Valid' -or $itemSignature.SignerCertificate.Subject -notmatch 'Microsoft') {
        throw ('UNTRUSTED_WEBVIEW_DLL=' + $item.Name)
      }
    }
  } finally { $zip.Dispose() }
  $exe = Join-Path $root 'WebView2OwnedHost.exe'
  $args = @(
    '/nologo', '/target:exe', '/platform:x64',
    ('/out:' + $exe), '/r:System.dll', '/r:System.Core.dll',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    '/r:System.Web.Extensions.dll',
    ('/r:' + (Join-Path $root 'Microsoft.Web.WebView2.Core.dll')),
    ('/r:' + (Join-Path $root 'Microsoft.Web.WebView2.WinForms.dll')),
    $source
  )
  $compile = @(& $compiler @args 2>&1)
  if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($exe)) {
    throw ('WEBVIEW2_HOST_COMPILATION_FAILED ' + (($compile | Select-Object -First 3) -join ' ').Substring(0,[Math]::Min(250,(($compile|Select-Object -First 3)-join ' ').Length)))
  }
  & node.exe $nodeTest $exe
  if ($LASTEXITCODE -ne 0) { throw 'NATIVE_HOST_ACCEPTANCE_FAILED' }
  Write-Output 'TETHERPLANE_WEBVIEW2_TYPED_HOST=PASS'
} catch {
  Write-Output ('TETHERPLANE_WEBVIEW2_TYPED_HOST=FAIL ' + $_.Exception.Message)
  exit 1
} finally {
  if (Test-Path -LiteralPath $root) {
    try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop }
    catch { Write-Output ('LAB_BUILD_CLEANUP_FAILED=' + $_.Exception.Message) }
  }
}
