<#
.SYNOPSIS
  Probe and register a DISABLED, passwordless S4U startup task for tether-auth.
.DESCRIPTION
  Default is read-only. -Probe creates/removes a temporary S4U task that
  verifies local protected state and both loopback HTTP services. -Register
  repeats the probe and installs a disabled startup task with restart settings.
  This never modifies existing relay/auth processes or Tailscale routes.
  The persistent task must be ACTIVATED separately with an explicit rollback.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'),
    [switch]$Probe,
    [switch]$ProbeV2,
    [switch]$Register
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskName = 'Tetherplane-TetherAuth-Startup'

function Assert-Autostart([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-ActionArguments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$RunnerPath,
        [Parameter(Mandatory=$true)][string]$StateDirectory,
        [Parameter(Mandatory=$true)][string]$RepoRoot,
        [Parameter(Mandatory=$true)][string]$NodeExecutable,
        [ValidateSet('Validate','Serve')][string]$Mode,
        [string]$ProbeResultFile
    )

    $arguments = @($RunnerPath, $StateDirectory, $RepoRoot, $NodeExecutable)
    if ($ProbeResultFile) { $arguments += $ProbeResultFile }
    foreach ($part in $arguments) {
        if (-not $part -or $part -match '["\x00-\x1f]' -or
            $part -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
            throw 'Autostart action paths must be absolute and free of special quoting characters.'
        }
    }
    if ($Mode -eq 'Serve' -and $ProbeResultFile) {
        throw 'A permanent service task cannot include a probe marker.'
    }

    $command = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File ' +
        '"' + $RunnerPath + '"' +
        ' -StateDirectory "' + $StateDirectory + '"' +
        ' -RepoRoot "' + $RepoRoot + '"' +
        ' -NodeExecutable "' + $NodeExecutable + '"' +
        ' -' + $Mode
    if ($ProbeResultFile) {
        $command += ' -ProbeResultFile "' + $ProbeResultFile + '"'
    }
    return $command
}

Assert-Autostart (
    $env:OS -eq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'vaulter'
) 'Autostart registration is restricted to Vaulter.'
Assert-Autostart (-not ($Probe -and $Register)) 'Select only one mode: -Probe or -Register.'
Assert-Autostart (-not ($ProbeV2 -and ($Probe -or $Register))) 'V2 S4U probe cannot register a permanent task.'

$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
$sourceRunnerV1 = Join-Path $RepoRoot 'scripts\vaulter-tether-auth-startup-runner.ps1'
$sourceRunnerV2 = Join-Path $RepoRoot 'scripts\vaulter-tether-auth-startup-runner-v2.ps1'
$sourceRunner = if ($ProbeV2) { $sourceRunnerV2 } else { $sourceRunnerV1 }
$permanentRunner = Join-Path $StateDirectory 'tether-auth-startup-runner.ps1'

Assert-Autostart (Test-Path -LiteralPath $sourceRunner -PathType Leaf) 'Verified startup runner is missing.'
Assert-Autostart (Test-Path -LiteralPath $StateDirectory -PathType Container) 'Protected auth-state directory not found.'
Assert-Autostart ((Get-Acl -LiteralPath $StateDirectory).AreAccessRulesProtected) 'Auth-state directory ACL is not protected.'
foreach ($name in @('tether-auth-config.json','tether-auth-jwks.json','bridge-token.secret','provider.sqlite')) {
    Assert-Autostart (Test-Path -LiteralPath (Join-Path $StateDirectory $name) -PathType Leaf) 'Existing auth-state file is missing.'
}

$relayHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 12
$authReady = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/readyz' -TimeoutSec 12
Assert-Autostart (
    $relayHealth.status -eq 'ok' -and $authReady.status -eq 'ready'
) 'Relay and staged auth must be healthy before probing unattended startup.'

$existingTask = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
if ($ProbeV2) {
    Assert-Autostart ($existingTask.Count -eq 1 -and
        $existingTask[0].State -eq 'Running' -and
        [string]$existingTask[0].Principal.LogonType -ceq 'S4U') 'V2 probe requires the existing healthy S4U startup task.'
    . (Join-Path $PSScriptRoot 'vaulter-tether-auth-runner-integrity.ps1')
    $installedVersion = Get-VerifiedRunnerVersion -V1SourcePath $sourceRunnerV1 -V2SourcePath $sourceRunnerV2 -ProtectedRunnerPath $permanentRunner
    Assert-Autostart ($installedVersion -ceq 'v1') 'V2 probe expects an unchanged installed v1 baseline.'
    & (Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1') | Out-Null
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $head = [string](& $git -C $RepoRoot rev-parse HEAD)
    $remote = [string](& $git -C $RepoRoot rev-parse 'refs/remotes/origin/feature/tether-auth-vaulter-migration-20261009')
    Assert-Autostart ($LASTEXITCODE -eq 0 -and $head.Trim() -ceq $remote.Trim()) 'V2 source must match the fetched feature revision.'
    $dirty = @(& $git -C $RepoRoot status --porcelain --untracked-files=no)
    Assert-Autostart ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'V2 source must come from a clean checkout.'
} else {
    Assert-Autostart ($existingTask.Count -eq 0) 'Permanent auth autostart task already exists; task already exists, do not overwrite.'
}

$node = Get-Command node.exe -ErrorAction Stop
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Assert-Autostart (Test-Path -LiteralPath $powerShell -PathType Leaf) 'Windows PowerShell 5.1 executable missing.'

if (-not $Probe -and -not $Register) {
    if (-not $ProbeV2) {
        Write-Output 'Auth autostart preflight: PASS. No permanent changes made.'
        Write-Output 'Use -Probe to check S4U access before first registration; use -ProbeV2 to validate v2 under the EXISTING task principal.'
        Write-Output 'Use -Register only after the S4U probe has passed.'
        return
    }
}

# S4U does not persist a user password, and the task uses the current
# owner of the protected signing material without elevation.
$windowsIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-ScheduledTaskPrincipal -UserId $windowsIdentity.Name -LogonType S4U -RunLevel Limited

# A temporary task checks local file permissions and loopback access.
$id = [Guid]::NewGuid().ToString('N')
$probeName = "Tetherplane-TetherAuth-S4U-Probe-$id"
$probeRunner = Join-Path $StateDirectory ("s4u-probe-$id.ps1")
$probeResult = Join-Path $StateDirectory ("s4u-probe-$id.result")
$probeRegistered = $false
$probeCleanupSucceeded = $true

try {
    Assert-Autostart (-not (Test-Path -LiteralPath $probeRunner) -and -not (Test-Path -LiteralPath $probeResult)) 'Probe files already exist.'
    Copy-Item -LiteralPath $sourceRunner -Destination $probeRunner -ErrorAction Stop

    $probeArgs = Get-ActionArguments -RunnerPath $probeRunner -StateDirectory $StateDirectory -RepoRoot $RepoRoot -NodeExecutable $node.Source -Mode Validate -ProbeResultFile $probeResult
    $probeAction = New-ScheduledTaskAction -Execute $powerShell -Argument $probeArgs -WorkingDirectory $RepoRoot
    $probeTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)
    $probeSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $probeName -Principal $principal -Trigger $probeTrigger -Action $probeAction -Settings $probeSettings -ErrorAction Stop | Out-Null
    $probeRegistered = $true
    Start-ScheduledTask -TaskName $probeName -ErrorAction Stop

    $probePassed = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path -LiteralPath $probeResult) {
            $result = ([IO.File]::ReadAllText($probeResult)).Trim()
            $probePassed = ($result -ceq 'PASS')
            break
        }
    }
    Assert-Autostart $probePassed 'S4U probe did not pass. Verify batch-logon rights and protected state/loopback access.'
} finally {
    if ($probeRegistered) {
        try { Stop-ScheduledTask -TaskName $probeName -ErrorAction SilentlyContinue } catch { }
        try {
            Unregister-ScheduledTask -TaskName $probeName -Confirm:$false -ErrorAction Stop
            $remains = @(Get-ScheduledTask -TaskName $probeName -ErrorAction SilentlyContinue)
            if ($remains.Count -gt 0) {
                $probeCleanupSucceeded = $false
                Write-Warning 'Temporary S4U probe task is still registered; stop before permanent installation.'
            }
        } catch {
            $probeCleanupSucceeded = $false
            Write-Warning 'Temporary S4U probe task cleanup needs local review.'
        }
    }
    foreach ($scratch in @($probeResult, $probeRunner)) {
        if (Test-Path -LiteralPath $scratch -PathType Leaf) {
            Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
        }
    }
}
Assert-Autostart $probeCleanupSucceeded 'Temporary S4U probe task was not removed. Refusing permanent registration.'
Write-Output 'S4U probe verified protected state access, Node.js runtime, and both loopback services.'

if ($ProbeV2) {
    Assert-Autostart (-not (Test-Path -LiteralPath $probeRunner) -and
        -not (Test-Path -LiteralPath $probeResult)) 'Temporary S4U probe files remain; refusing to issue v2 proof.'
    # Only after successful task cleanup, record a short-lived proof with
    # nonsecret source SHA-256 and verification timestamp in protected state.
    $proofPath = Join-Path $StateDirectory 'tether-auth-runner-v2-probe.json'
    $proof = [ordered]@{
        v2_source_hash = (Get-FileHash -LiteralPath $sourceRunnerV2 -Algorithm SHA256).Hash
        verified_utc = [datetimeoffset]::UtcNow.ToString('o')
        principal = 'S4U'
        task = $taskName
    }
    [IO.File]::WriteAllText($proofPath, (ConvertTo-Json -InputObject $proof -Compress), [Text.Encoding]::UTF8)
    Assert-Autostart (Test-Path -LiteralPath $proofPath -PathType Leaf) 'Protected S4U v2 proof not saved.'
    Write-Output 'S4U v2 probe verified. Existing task, auth listener, relay, and public routes remain unchanged.'
    return
}

if (-not $Register) {
    Write-Output 'No permanent changes made. Existing auth and relay services remain running.'
    return
}

# Add a NEW, DISABLED task. Never start it while the staged process owns 8790.
Assert-Autostart (-not (Test-Path -LiteralPath $permanentRunner)) 'Protected auth startup runner already exists; do not overwrite.'
Assert-Autostart (@(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).Count -eq 0) 'Permanent autostart task already exists.'

$registered = $false
$runnerCopied = $false
try {
    Copy-Item -LiteralPath $sourceRunner -Destination $permanentRunner -ErrorAction Stop
    $runnerCopied = $true
    $expectedHash = (Get-FileHash -LiteralPath $sourceRunner -Algorithm SHA256).Hash
    Assert-Autostart ((Get-FileHash -LiteralPath $permanentRunner -Algorithm SHA256).Hash -ceq $expectedHash) 'Protected startup runner copy differs from tested source.'

    $args = Get-ActionArguments -RunnerPath $permanentRunner -StateDirectory $StateDirectory -RepoRoot $RepoRoot -NodeExecutable $node.Source -Mode Serve
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument $args -WorkingDirectory $RepoRoot
    $boot = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -Disable -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    Register-ScheduledTask -TaskName $taskName -Principal $principal -Action $action -Trigger $boot -Settings $settings -ErrorAction Stop | Out-Null
    $registered = $true
    $newTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Assert-Autostart ($newTask.State -eq 'Disabled') 'New auth task was not registered disabled.'
    Assert-Autostart ([string]$newTask.Principal.LogonType -eq 'S4U') 'New auth task did not retain S4U identity.'
    Assert-Autostart (@($newTask.Triggers | Where-Object {
        $_.CimClass.CimClassName -match 'BootTrigger$'
    }).Count -gt 0) 'Startup trigger was not registered.'
} catch {
    if ($registered) {
        try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop }
        catch { Write-Warning 'Failed task registration rollback requires local review.' }
    }
    if ($runnerCopied -and (Test-Path -LiteralPath $permanentRunner)) {
        Remove-Item -LiteralPath $permanentRunner -Force -ErrorAction SilentlyContinue
    }
    throw 'Autostart registration or verification failed; existing processes and routes were not changed.'
}
Write-Output 'Auth startup task REGISTERED DISABLED with S4U, startup trigger, and restart handling.'
Write-Output 'No existing service was restarted. Existing Auth0 relay and JWKS canary are unchanged.'
Write-Output 'Do not reboot until a separate, rollback-tested activation step is ready.'
