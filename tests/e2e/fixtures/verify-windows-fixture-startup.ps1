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

  # Phase 2: Nonvisible timer heartbeat + read-only OS foreground helper +
  # atomic MoveFileExW state replacement proof. Opens zero windows.
  $timerRoot = Join-Path $env:RUNNER_TEMP ('tp-g4-fixture-timer-' + [guid]::NewGuid().ToString('N'))
  [void](New-Item -ItemType Directory -Path $timerRoot -Force)
  $timerState = Join-Path $timerRoot 'owned.json'
  $timerPsi = [Diagnostics.ProcessStartInfo]::new()
  $timerPsi.FileName = 'powershell.exe'
  $timerPsi.Arguments = '-NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File "' +
    $fixture + '" -StatePath "' + $timerState +
    '" -Title "Nonvisible G4 timer selftest" -Prefix Owned -Framework ' + $framework +
    ' -NoActivate -SelfTestTimer'
  $timerPsi.RedirectStandardInput = $true
  $timerPsi.RedirectStandardOutput = $true
  $timerPsi.RedirectStandardError = $true
  $timerPsi.UseShellExecute = $false
  $timerPsi.CreateNoWindow = $true
  $tp = $null
  try {
    $tp = [Diagnostics.Process]::Start($timerPsi)
    $tStdout = $tp.StandardOutput.ReadToEndAsync()
    $tStderr = $tp.StandardError.ReadToEndAsync()
    if (-not $tp.WaitForExit(30000)) {
      $tp.Kill()
      [void]$tp.WaitForExit(3000)
      throw "$framework nonvisible timer self-test timed out"
    }
    if ($tp.ExitCode -ne 0) {
      throw "$framework timer self-test exit $($tp.ExitCode); stderr=$($tStderr.Result.Trim()); stdout=$($tStdout.Result.Trim())"
    }
    $tCheckpoint = "$timerState.startup.txt"
    if (-not (Test-Path -LiteralPath $tCheckpoint -PathType Leaf)) {
      throw "$framework timer self-test did not record startup stage"
    }
    $tStage = Get-Content -LiteralPath $tCheckpoint -Raw
    if ($tStage -notmatch 'stage=(?:winforms-)?selftest-timer-done') {
      throw "$framework timer self-test did not complete: $tStage"
    }
    if (-not (Test-Path -LiteralPath $timerState -PathType Leaf)) {
      throw "$framework timer self-test did not publish state JSON"
    }
    $parsed = Get-Content -LiteralPath $timerState -Raw | ConvertFrom-Json
    if ($parsed.ready -ne $true -or $parsed.content_rendered -ne $true) {
      throw "$framework timer self-test state not rendered/ready: $(Get-Content -LiteralPath $timerState -Raw)"
    }
    if ($parsed.framework -ne $framework) {
      throw "$framework timer self-test framework mismatch: $($parsed.framework)"
    }
    if ([int]$parsed.state_seq -lt 3 -or [int]$parsed.tick_count -lt 3) {
      throw "$framework timer self-test did not advance monotonic counters: state_seq=$($parsed.state_seq) tick_count=$($parsed.tick_count)"
    }
    if ($parsed.os_foreground_available -ne $true) {
      throw "$framework read-only OS foreground native helper unavailable: last_write_error=$($parsed.last_write_error)"
    }
    if ([int]$parsed.write_errors -ne 0) {
      throw "$framework timer self-test reported write_errors=$($parsed.write_errors): $($parsed.last_write_error)"
    }
    if ($parsed.last_source -ne 'selftest-timer') {
      throw "$framework unexpected last_source=$($parsed.last_source)"
    }
    [void][DateTimeOffset]::Parse([string]$parsed.updated_at_utc)
    $leftoverTmp = @(Get-ChildItem -LiteralPath $timerRoot -Filter '*.tmp' -ErrorAction SilentlyContinue)
    if ($leftoverTmp.Count -ne 0) {
      throw "$framework timer self-test left $($leftoverTmp.Count) temporary state file(s)"
    }
    Write-Output ("G4_$($framework.ToUpperInvariant())_NONVISIBLE_TIMER_SELFTEST=PASS state_seq=$($parsed.state_seq) tick_count=$($parsed.tick_count)")
  } finally {
    if ($tp) {
      if (-not $tp.HasExited) { $tp.Kill(); [void]$tp.WaitForExit(3000) }
      $tp.Dispose()
    }
    Remove-Item -LiteralPath $timerRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
