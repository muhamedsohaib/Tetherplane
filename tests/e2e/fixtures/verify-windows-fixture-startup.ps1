# Pure fixture constructor verification. Does not open any windows, control a user,
# connect to Tetherplane, or grant process.terminate. Runs only on disposable CI.
$ErrorActionPreference = 'Stop'
$fixture = Join-Path $PSScriptRoot 'windows-desktop-fixture.ps1'
if (-not (Test-Path -LiteralPath $fixture -PathType Leaf)) { throw 'Fixture script missing' }
foreach ($framework in @('WinForms', 'Wpf')) {
  $root = Join-Path $env:RUNNER_TEMP ('tp-g4-fixture-preflight-' + [guid]::NewGuid().ToString('N'))
  [void](New-Item -ItemType Directory -Path $root -Force)
  $state = Join-Path $root 'owned.json'
  $stdoutFile = Join-Path $root 'stdout.txt'
  $stderrFile = Join-Path $root 'stderr.txt'
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = 'powershell.exe'
  # Windows PowerShell 5.1 uses .NET Framework: ProcessStartInfo.ArgumentList
  # is unavailable. Quote only paths from the runner's own trusted workspace.
  $psi.Arguments = '-NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File "' +
    $fixture + '" -StatePath "' + $state +
    '" -Title "Nonvisible G4 preflight" -Prefix Owned -Framework ' + $framework +
    ' -InitializeOnly'
  $psi.RedirectStandardInput = $true  # Match tetherd process.run piped stdin; keep the pipe open.
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = $null
  try {
    $p = [Diagnostics.Process]::Start($psi)
    $stdout = $p.StandardOutput.ReadToEndAsync()
    $stderr = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(30000)) {
      $p.Kill()
      [void]$p.WaitForExit(3000)
      throw "$framework nonvisible fixture initialization timed out"
    }
    if ($p.ExitCode -ne 0) {
      throw "$framework fixture exit $($p.ExitCode); stderr=$($stderr.Result.Trim()); stdout=$($stdout.Result.Trim())"
    }
    $checkpoint = "$state.startup.txt"
    if (-not (Test-Path -LiteralPath $checkpoint -PathType Leaf)) {
      throw "$framework fixture did not record startup stage"
    }
    $stages = Get-Content -LiteralPath $checkpoint -Raw
    if ($stages -notmatch 'stage=(?:winforms-)?controls-created') {
      throw "$framework did not construct controls: $stages"
    }
    if (Test-Path -LiteralPath $state) {
      throw "$framework unexpectedly published a live GUI fixture state during nonvisible initialization"
    }
    Write-Output "G4_$($framework.ToUpperInvariant())_NONVISIBLE_STARTUP=PASS"
  } finally {
    if ($p) {
      if (-not $p.HasExited) { $p.Kill(); [void]$p.WaitForExit(3000) }
      $p.Dispose()
    }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}
