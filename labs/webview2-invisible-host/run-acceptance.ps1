# Standalone, explicitly invoked Windows/Leno laboratory proof.
# No installers, production agent changes, personal profiles, remote debugging
# ports, network destinations, persistent credentials, or browser automation grants.
# The program only navigates to a locally generated about:blank HTML document.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$packageVersion = '1.0.4258.31'
$expectedPackageSha256 = '56F7F4B8BF9AEE4B8EFEFBBDD4F67D5F74EBD1B100ED0806DA71BF76AF481AA9'
$expectedNugetSha256 = '92DBED160DDEE0F64B901E907439E021211B428E57C089ECC12FC38DCC4BD9A5'
$nugetUrl = 'https://dist.nuget.org/win-x86-commandline/v6.14.0/nuget.exe'
$packageUrl = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4258.31/microsoft.web.webview2.1.0.4258.31.nupkg'
$temporaryRoot = Join-Path $env:TEMP ('tp-webview2-proof-' + [guid]::NewGuid().ToString('N'))
$profile = Join-Path $temporaryRoot 'profile'
$evidenceFile = Join-Path $temporaryRoot 'browser-evidence.txt'
$report = [ordered]@{
  sdk = $packageVersion
  verifiedMicrosoftPackage = $false
  webviewRuntime = 'unknown'
  browserCdpRead = $false
  browserCdpAction = $false
  hostExitCode = $null
  foregroundChanges = -1
  cursorChangeSamples = -1
  clipboardUnchanged = $false
  observedOwnedBrowserProcesses = 0
  browserTcpListenerCount = $null
  devtoolsPortFile = $null
  unsafeDebugTcpFlag = $null
  noSandboxFlag = $null
  processesRemaining = $null
  tempDirectoryRemoved = $false
  verdict = 'FAIL'
  error = $null
}
$hostProcess = $null

try {
  if (-not [Environment]::UserInteractive) { throw 'INTERACTIVE_DESKTOP_REQUIRED' }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'WIN64_REQUIRED' }
  $compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not [IO.File]::Exists($compiler)) { throw 'DOTNET_FRAMEWORK_CSC_MISSING' }
  $source = Join-Path $PSScriptRoot 'WebView2DisposableProof.cs'
  if (-not [IO.File]::Exists($source)) { throw 'LAB_SOURCE_MISSING' }

  [void][IO.Directory]::CreateDirectory($temporaryRoot)
  [void][IO.Directory]::CreateDirectory($profile)
  $nuget = Join-Path $temporaryRoot 'nuget.exe'
  $package = Join-Path $temporaryRoot 'webview2.nupkg'
  Invoke-WebRequest -UseBasicParsing -Uri $nugetUrl -OutFile $nuget -TimeoutSec 50
  if ((Get-FileHash -LiteralPath $nuget -Algorithm SHA256).Hash -ne $expectedNugetSha256) {
    throw 'NUGET_BINARY_HASH_MISMATCH'
  }
  $nuSig = Get-AuthenticodeSignature -LiteralPath $nuget
  if ($nuSig.Status -ne 'Valid' -or $nuSig.SignerCertificate.Subject -notmatch 'Microsoft') {
    throw 'NUGET_BINARY_SIGNATURE_REJECTED'
  }

  Invoke-WebRequest -UseBasicParsing -Uri $packageUrl -OutFile $package -TimeoutSec 75
  if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $expectedPackageSha256) {
    throw 'WEBVIEW2_SDK_PACKAGE_HASH_MISMATCH'
  }
  $verifyLines = @(& $nuget verify -Signatures $package -NonInteractive -ForceEnglishOutput -Verbosity normal 2>&1)
  $nugetExit = $LASTEXITCODE
  if ($nugetExit -ne 0 -or ($verifyLines -join ' ') -notmatch 'Subject Name: CN=Microsoft Corporation') {
    throw 'MICROSOFT_NUGET_AUTHOR_SIGNATURE_NOT_VERIFIED'
  }
  $bin = Join-Path $temporaryRoot 'bin'
  [void][IO.Directory]::CreateDirectory($bin)
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($package)
  try {
    $files = @(
      'lib/net462/Microsoft.Web.WebView2.Core.dll'
      'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
      'runtimes/win-x64/native/WebView2Loader.dll'
    )
    foreach ($entryName in $files) {
      $entry = $archive.GetEntry($entryName)
      if ($null -eq $entry) { throw ('SDK_DLL_MISSING:' + $entryName) }
      $destination = Join-Path $bin $entry.Name
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
      $sig = Get-AuthenticodeSignature -LiteralPath $destination
      if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft') {
        throw ('SDK_DLL_SIGNATURE_REJECTED:' + $entry.Name)
      }
    }
  } finally {
    $archive.Dispose()
  }
  $report.verifiedMicrosoftPackage = $true

  $exe = Join-Path $bin 'WebView2DisposableProof.exe'
  $cscArgs = @(
    '/nologo', '/target:winexe', '/platform:x64',
    ('/out:' + $exe),
    '/r:System.dll', '/r:System.Core.dll',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    ('/r:' + (Join-Path $bin 'Microsoft.Web.WebView2.Core.dll')),
    ('/r:' + (Join-Path $bin 'Microsoft.Web.WebView2.WinForms.dll')),
    $source
  )
  $build = @(& $compiler @cscArgs 2>&1)
  $cscExit = $LASTEXITCODE
  if ($cscExit -ne 0 -or -not [IO.File]::Exists($exe)) {
    throw ('CS_COMPILATION_FAILED:' + (($build | Select-Object -First 2) -join ' ').Substring(0, [Math]::Min(250, (($build | Select-Object -First 2) -join ' ').Length)))
  }

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TpWebViewLabDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
}
'@
  $baseHwnd = [TpWebViewLabDesktop]::GetForegroundWindow().ToInt64()
  $baseClipboard = [TpWebViewLabDesktop]::GetClipboardSequenceNumber()
  $baseCursor = New-Object TpWebViewLabDesktop+Point
  [void][TpWebViewLabDesktop]::GetCursorPos([ref]$baseCursor)

  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $exe
  $info.Arguments = ('"' + $profile + '" "' + $evidenceFile + '"')
  $info.WorkingDirectory = $bin
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $hostProcess = [Diagnostics.Process]::Start($info)

  $focusChanges = 0
  $cursorChanges = 0
  $ownedPids = @()
  $listenerCount = $null
  $unsafeFlag = $false
  $noSandbox = $false
  $portFile = $false
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while (-not $hostProcess.HasExited -and $timer.ElapsedMilliseconds -lt 26000) {
    if ([TpWebViewLabDesktop]::GetForegroundWindow().ToInt64() -ne $baseHwnd) { $focusChanges++ }
    $point = New-Object TpWebViewLabDesktop+Point
    [void][TpWebViewLabDesktop]::GetCursorPos([ref]$point)
    if ($point.X -ne $baseCursor.X -or $point.Y -ne $baseCursor.Y) { $cursorChanges++ }
    if ($timer.ElapsedMilliseconds -gt 700 -and $ownedPids.Count -eq 0) {
      # Match only browser processes with the unique disposable profile.
      $owned = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
        Where-Object { $_.CommandLine -like "*$profile*" })
      if ($owned.Count -gt 0) {
        $ownedPids = @($owned | Select-Object -ExpandProperty ProcessId)
        foreach ($proc in $owned) {
          if ($proc.CommandLine -like '*--remote-debugging-port=*') { $unsafeFlag = $true }
          if ($proc.CommandLine -like '*--no-sandbox*') { $noSandbox = $true }
        }
        $listenerCount = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
          Where-Object { $ownedPids -contains $_.OwningProcess }).Count
        $portFile = Test-Path -LiteralPath (Join-Path $profile 'DevToolsActivePort')
      }
    }
    Start-Sleep -Milliseconds 35
  }
  if (-not $hostProcess.HasExited) { throw 'LAB_HOST_TIMEOUT' }
  $report.hostExitCode = $hostProcess.ExitCode
  $report.foregroundChanges = $focusChanges
  $report.cursorChangeSamples = $cursorChanges
  $report.clipboardUnchanged = ($baseClipboard -eq [TpWebViewLabDesktop]::GetClipboardSequenceNumber())
  $report.observedOwnedBrowserProcesses = $ownedPids.Count
  $report.browserTcpListenerCount = $listenerCount
  $report.devtoolsPortFile = $portFile
  $report.unsafeDebugTcpFlag = $unsafeFlag
  $report.noSandboxFlag = $noSandbox
  if (-not [IO.File]::Exists($evidenceFile)) { throw 'BROWSER_LAB_EVIDENCE_NOT_WRITTEN' }
  $evidence = [IO.File]::ReadAllText($evidenceFile)
  $runtimeMatch = [regex]::Match($evidence, '(?m)^RUNTIME_VERSION=([0-9.]+)\s*$')
  if ($runtimeMatch.Success) { $report.webviewRuntime = $runtimeMatch.Groups[1].Value }
  $report.browserCdpRead = $evidence.Contains('CDP_READ_OK=true')
  $report.browserCdpAction = $evidence.Contains('CDP_ACTION_VERIFIED=true')
  $internalPass = $evidence.Contains('RESULT=PASS')
  if (-not $internalPass -or $report.hostExitCode -ne 0 -or
      -not $report.browserCdpRead -or -not $report.browserCdpAction -or
      $focusChanges -ne 0 -or $cursorChanges -ne 0 -or
      -not $report.clipboardUnchanged -or $ownedPids.Count -eq 0 -or
      $listenerCount -ne 0 -or $portFile -or $unsafeFlag -or $noSandbox) {
    throw 'BROWSER_LAB_ACCEPTANCE_FAILED'
  }
  $report.verdict = 'PASS_PENDING_CLEANUP'
} catch {
  $report.error = ($_.Exception.GetType().Name + ':' + $_.Exception.Message)
} finally {
  if ($null -ne $hostProcess) {
    try {
      if (-not $hostProcess.HasExited) {
        Stop-Process -Id $hostProcess.Id -Force -ErrorAction Stop
      }
      $hostProcess.WaitForExit(2500) | Out-Null
    } catch {
      $report.error = 'LAB_HOST_TERMINATION_FAILED'
    }
  }
  if (Test-Path -LiteralPath $profile) {
    try {
      $remaining = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
        Where-Object { $_.CommandLine -like "*$profile*" })
      foreach ($proc in $remaining) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Milliseconds 450
      $after = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
        Where-Object { $_.CommandLine -like "*$profile*" })
      $report.processesRemaining = $after.Count
    } catch {
      $report.processesRemaining = 'inspection_failed'
    }
  }
  try {
    if (Test-Path -LiteralPath $temporaryRoot) {
      Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction Stop
    }
  } catch {
    $report.error = 'TEMPORARY_PROOF_FILES_CLEANUP_FAILED'
  }
  $report.tempDirectoryRemoved = (-not (Test-Path -LiteralPath $temporaryRoot))
  if ($report.verdict -eq 'PASS_PENDING_CLEANUP' -and
      $report.processesRemaining -eq 0 -and $report.tempDirectoryRemoved) {
    $report.verdict = 'PASS'
  } else {
    $report.verdict = 'FAIL'
  }
  Write-Output ('WEBVIEW2_EVIDENCE=' + ($report | ConvertTo-Json -Compress -Depth 3))
}
if ($report.verdict -ne 'PASS') { exit 1 }
