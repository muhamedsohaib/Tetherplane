<#
.SYNOPSIS
  Ownership-verified staged-auth to S4U cutback. Read-only by default.
.DESCRIPTION
  Apply only during a separately approved maintenance window. Refuses any
  listener not proven to have been launched by guarded fallback recovery.
  Never changes relay, Funnel, signing keys or other processes.
#>
[CmdletBinding()]
param([switch]$ApplyCutback)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$script:taskName = 'Tetherplane-TetherAuth-Startup'
$script:stateDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:proofPath = Join-Path $script:stateDir 'tether-auth-owned-staged-fallback.json'
$script:offlineRescue = Join-Path $PSScriptRoot 'vaulter-tether-auth-offline-restore.ps1'
$script:postcheck = Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1'
$script:authConfig = Join-Path $script:stateDir 'tether-auth-config.json'
$script:sourceRoot = Split-Path -Parent $PSScriptRoot
$script:protectedRunner = Join-Path $script:stateDir 'tether-auth-startup-runner.ps1'
. (Join-Path $PSScriptRoot 'vaulter-tether-auth-runner-integrity.ps1')

function Assert-Cutback([bool]$Condition,[string]$Reason) {
    if (-not $Condition) {throw $Reason}
}
function Invoke-StagedCutbackTransaction {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][hashtable]$Operations)
    foreach($name in @('VerifyBaseline','VerifyOwnedTarget','QuiesceOwnedStage','VerifyVacant',
      'RestoreV1','EnableTask','StartTask','VerifyS4U',
      'PrepareStagedRollback','RestoreStage','VerifyStage')) {
        if (-not $Operations.ContainsKey($name) -or -not ($Operations[$name] -is [scriptblock])) {
            throw 'Cutback operations incomplete.'
        }
    }
    # Fail before touching any process or task if either precondition changes.
    & $Operations['VerifyBaseline']
    & $Operations['VerifyOwnedTarget']
    try {
        foreach($name in @('QuiesceOwnedStage','VerifyVacant','RestoreV1',
            'EnableTask','StartTask','VerifyS4U')) { & $Operations[$name] }
        return 's4u_restored'
    } catch {
        # A cutback failure is never reported as an accepted S4U restoration.
        # Each rollback operation depends on the preceding one. In
        # particular, a failed port/ownership check MUST NOT be followed by
        # launching a second auth listener.
        foreach($name in @('PrepareStagedRollback','RestoreStage','VerifyStage')) {
            try {
                & $Operations[$name]
            } catch {
                throw 'CUTBACK FAILED; ROLLBACK UNVERIFIED. Preserve private evidence; do not reboot or change Funnel.'
            }
        }
        throw 'CUTBACK FAILED; staged auth restored and verified. S4U cutback not accepted.'
    }
}
function Get-TaskSnapshot {
    $t=Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
    Assert-Cutback ($t.State -eq 'Disabled' -and -not [bool]$t.Settings.Enabled -and
        [string]$t.Principal.LogonType -ceq 'S4U' -and
        [int]$t.Settings.RestartCount -eq 10 -and
        [string]$t.Settings.RestartInterval -ceq 'PT1M') 'Exact S4U task is not disabled with approved policy.'
    $actions=@($t.Actions)
    Assert-Cutback ($actions.Count -eq 1 -and
        ([string]$actions[0].Arguments).Contains($script:protectedRunner) -and
        ([string]$actions[0].Arguments).EndsWith(' -Serve',[StringComparison]::Ordinal)) 'Task action has changed.'
    Assert-Cutback (@($t.Triggers | Where-Object { $_.CimClass.CimClassName -match 'BootTrigger$' }).Count -gt 0) 'Task boot trigger changed.'
    return [string](Export-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop)
}
# Compare parsed arguments, not substrings: a lookalike CLI/config
# must never authorize terminating an unrelated Node process.
function Test-OwnedStageCommandLine {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$CommandLine,
        [Parameter(Mandatory=$true)][string]$ExpectedConfig
    )
    try {
        $cli=@([regex]::Matches($CommandLine,'(?i)(?:^|\s)auth[\\/]dist[\\/]cli\.js(?=\s|$)'))
        if ($cli.Count -ne 1) { return $false }
        $expected=@(
            @{Name='--config'; Value=$ExpectedConfig; IsPath=$true},
            @{Name='--host'; Value='127.0.0.1'; IsPath=$false},
            @{Name='--port'; Value='8790'; IsPath=$false}
        )
        foreach($item in $expected) {
            $pattern='(?i)(?:^|\s)' + [regex]::Escape($item.Name) +
                '\s+(?:"([^"]+)"|(\S+))(?=\s|$)'
            $matched=[regex]::Matches($CommandLine,$pattern)
            if ($matched.Count -ne 1) {return $false}
            $actual=if($matched[0].Groups[1].Success) {
                $matched[0].Groups[1].Value
            } else {
                $matched[0].Groups[2].Value
            }
            if ($item.IsPath) {
                if ([IO.Path]::GetFullPath($actual) -ine
                    [IO.Path]::GetFullPath([string]$item.Value)) {return $false}
            } elseif ($actual -cne [string]$item.Value) {
                return $false
            }
        }
        $allow=@([regex]::Matches($CommandLine,
            '(?i)(?:^|\s)--allow-insecure-localhost(?=\s|$)'))
        return ($allow.Count -eq 1)
    } catch { return $false }
}
function Get-CutbackV1RestoreDecision {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$InstalledVersion)
    if ($InstalledVersion -ceq 'v1') {return 'already_v1'}
    if ($InstalledVersion -ceq 'v2') {return 'restore_v1'}
    throw 'Cutback refuses an untrusted protected runner.'
}
function Test-CutbackProofAclEquivalent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Expected,
        [Parameter(Mandatory=$true)]$Actual
    )
    try {
        if ([string]$Expected.Owner -cne [string]$Actual.Owner -or
            [string]$Expected.Group -cne [string]$Actual.Group -or
            [bool]$Expected.AreAccessRulesProtected -ne [bool]$Actual.AreAccessRulesProtected) {
            return $false
        }
        $before=@(foreach($ace in @($Expected.Access)) {
            [string]$ace.IdentityReference.Value + '|' + [string]$ace.FileSystemRights + '|' +
                [string]$ace.AccessControlType + '|' + [string]$ace.InheritanceFlags + '|' +
                [string]$ace.PropagationFlags
        }) | Sort-Object
        $after=@(foreach($ace in @($Actual.Access)) {
            [string]$ace.IdentityReference.Value + '|' + [string]$ace.FileSystemRights + '|' +
                [string]$ace.AccessControlType + '|' + [string]$ace.InheritanceFlags + '|' +
                [string]$ace.PropagationFlags
        }) | Sort-Object
        return (($before -join ';') -ceq ($after -join ';'))
    } catch {return $false}
}
function Get-ProvenStagedListener {
    Assert-Cutback (Test-Path -LiteralPath $script:proofPath -PathType Leaf) 'No owned staged-fallback proof; manual review required.'
    $proofFile=Get-Item -LiteralPath $script:proofPath -ErrorAction Stop
    Assert-Cutback (-not [bool]($proofFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Proof path is a reparse point.'
    $proofAcl=Get-Acl -LiteralPath $script:proofPath -ErrorAction Stop
    $runnerAcl=Get-Acl -LiteralPath $script:protectedRunner -ErrorAction Stop
    Assert-Cutback ($proofAcl.AreAccessRulesProtected -and
        (Test-CutbackProofAclEquivalent -Expected $runnerAcl -Actual $proofAcl)) 'Staged-fallback proof ACL differs from protected runner.'
    $proof=Get-Content -LiteralPath $script:proofPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    Assert-Cutback ($proof.schema -ceq 'tether-auth-owned-stage/v2' -and
        [int]$proof.port -eq 8790 -and [int]$proof.pid -gt 0 -and
        [long]$proof.creationUtcTicks -gt 0)) 'Invalid staged-fallback proof.'
    $ports=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq 8790})
    Assert-Cutback ($ports.Count -eq 1 -and $ports[0].LocalAddress -ceq '127.0.0.1' -and
        [int]$ports[0].OwningProcess -eq [int]$proof.pid) 'Listener differs from owned staged fallback.'
    $proc=Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$proof.pid) -ErrorAction Stop
    $birthTicks=([datetime]$proc.CreationDate).ToUniversalTime().Ticks
    Assert-Cutback ($null -ne $proc -and $proc.Name -ieq 'node.exe' -and
        [long]$birthTicks -eq [long]$proof.creationUtcTicks) 'Owned staged PID/creation identity changed.'
    Assert-Cutback (Test-OwnedStageCommandLine -CommandLine ([string]$proc.CommandLine) -ExpectedConfig $script:authConfig) 'Staged Node CLI/config identity changed.'
    Assert-Cutback ([int]$proc.ParentProcessId -eq [int]$proof.parentPid) 'Staged process parent changed.'
    return [pscustomobject]@{ProcessId=[int]$proc.ProcessId; CreationUtcTicks=[long]$birthTicks; ParentProcessId=[int]$proc.ParentProcessId}
}
function Get-PublicKeyFingerprint([string]$Url) {
    $keys=@((Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 12 -ErrorAction Stop).keys)
    Assert-Cutback ($keys.Count -gt 0) 'Public signing keys are absent.'
    $rows=@(foreach($key in $keys) {
        foreach($private in @('d','p','q','dp','dq','qi','oth','k')) {
            Assert-Cutback (-not ($key.PSObject.Properties.Name -contains $private)) 'Public key contains private material.'
        }
        Assert-Cutback ($key.kty -ceq 'RSA' -and $key.kid -and $key.n -and $key.e) 'Malformed public signing key.'
        [string]$key.kid + '|' + [string]$key.kty + '|' + [string]$key.n + '|' + [string]$key.e
    })
    return (($rows | Sort-Object) -join ';')
}
function Assert-StagedHealth {
    $ready=Invoke-RestMethod -Uri 'http://127.0.0.1:8790/readyz' -TimeoutSec 12 -ErrorAction Stop
    Assert-Cutback ($ready.status -ceq 'ready') 'Staged auth not ready.'
    $relay=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 12 -ErrorAction Stop
    $public=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/healthz' -TimeoutSec 12 -ErrorAction Stop
    Assert-Cutback ($relay.status -ceq 'ok' -and $public.status -ceq 'ok') 'Relay or public endpoint is not healthy.'
    $resource=Invoke-RestMethod -Uri 'https://vaulter.tailf65eba.ts.net/.well-known/oauth-protected-resource/mcp' -TimeoutSec 12 -ErrorAction Stop
    Assert-Cutback ($resource.resource -ceq 'https://vaulter.tailf65eba.ts.net/mcp' -and
        @($resource.authorization_servers).Count -eq 1 -and
        @($resource.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Auth0-backed relay resource metadata changed.'
    Assert-Cutback ((Get-PublicKeyFingerprint 'http://127.0.0.1:8790/jwks') -ceq $script:baselineKeys -and
        (Get-PublicKeyFingerprint 'https://vaulter.tailf65eba.ts.net/jwks') -ceq $script:baselineKeys) 'Public/local signing keys changed during cutback.'
}
Assert-Cutback ($env:OS -ceq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'vaulter') 'Cutback restricted to Vaulter.'
Assert-Cutback (Test-Path -LiteralPath $script:stateDir -PathType Container) 'Protected state missing.'
Assert-Cutback ((Get-Acl -LiteralPath $script:stateDir -ErrorAction Stop).AreAccessRulesProtected) 'Protected state ACL not isolated.'
Assert-Cutback (Test-Path -LiteralPath $script:offlineRescue -PathType Leaf) 'Offline v1 rescue missing.'
$script:baselineXml=Get-TaskSnapshot
$script:owned=Get-ProvenStagedListener
$script:baselineKeys=Get-PublicKeyFingerprint 'http://127.0.0.1:8790/jwks'
Assert-StagedHealth
& $script:offlineRescue | Out-Null
if (-not $ApplyCutback) {
    Write-Output 'STAGED CUTBACK PREFLIGHT PASS: exact owned stage, disabled S4U task and offline rescue checked.'
    Write-Output 'No changes made. -ApplyCutback requires separately approved maintenance.'
    return
}
$script:stageStillRunning = $false
$script:rollbackStagePid = $null
$ops=@{
    VerifyBaseline = {
        Assert-Cutback ((Get-TaskSnapshot) -ceq $script:baselineXml) 'Task changed before cutback.'
        Assert-StagedHealth
        & $script:offlineRescue | Out-Null
    }
    VerifyOwnedTarget = {
        $now=Get-ProvenStagedListener
        Assert-Cutback ($now.ProcessId -eq $script:owned.ProcessId -and
            $now.CreationUtcTicks -eq $script:owned.CreationUtcTicks) 'Staged PID identity changed before quiesce.'
    }
    QuiesceOwnedStage = {
        $now=Get-ProvenStagedListener
        Assert-Cutback ($now.ProcessId -eq $script:owned.ProcessId -and
            $now.CreationUtcTicks -eq $script:owned.CreationUtcTicks) 'Staged Node replaced before stop.'
        # The last check must cover the named task too, not just the PID:
        # re-enabled autostart could race the process termination.
        Assert-Cutback ((Get-TaskSnapshot) -ceq $script:baselineXml) 'S4U task changed immediately before staged stop.'
        Stop-Process -Id $now.ProcessId -ErrorAction Stop
    }
    VerifyVacant = {
        $vacant=$false
        for($i=0;$i -lt 20;$i++) {
            $ports=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq 8790})
            if ($ports.Count -eq 0) {$vacant=$true;break}
            Start-Sleep -Milliseconds 500
        }
        Assert-Cutback $vacant 'Port 8790 not vacant; refusing duplicate startup.'
    }
    RestoreV1 = {
        $paths=@{
            V1SourcePath=(Join-Path $script:sourceRoot 'scripts\vaulter-tether-auth-startup-runner.ps1')
            V2SourcePath=(Join-Path $script:sourceRoot 'scripts\vaulter-tether-auth-startup-runner-v2.ps1')
            ProtectedRunnerPath=$script:protectedRunner
        }
        $installed=Get-VerifiedRunnerVersion @paths
        $decision=Get-CutbackV1RestoreDecision -InstalledVersion $installed
        if ($decision -ceq 'restore_v1') {
            & $script:offlineRescue -RestoreV1 | Out-Null
        }
    }
    EnableTask = {
        & $script:offlineRescue -EnableV1Task | Out-Null
    }
    StartTask = {
        & $script:offlineRescue -StartV1Task | Out-Null
    }
    VerifyS4U = {
        & $script:postcheck | Out-Null
        # The task-owned successor must reuse the exact baseline public keys,
        # not merely agree with its own freshly served JWKS.
        Assert-StagedHealth
        $ports=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq 8790})
        Assert-Cutback ($ports.Count -eq 1 -and [int]$ports[0].OwningProcess -ne $script:owned.ProcessId) 'S4U listener missing or old staged process persisted.'
    }
    PrepareStagedRollback = {
        # Never revive stage while a named task might automatically restart.
        $task=Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
        if ([bool]$task.Settings.Enabled) {
            Disable-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop | Out-Null
        }
        $task=Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
        if ($task.State -eq 'Running') {
            # Task-owned process termination requires separate proof; fail closed.
            throw 'Named task remains running: staged rollback needs manual recovery.'
        }
        Assert-Cutback ($task.State -eq 'Disabled') 'Named task not disabled after failed cutback.'
        $ports=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq 8790})
        if ($ports.Count -gt 0) {
            # If quiesce failed before stopping the original owned process,
            # preserve it; any other occupied listener is a hard stop.
            $now=Get-ProvenStagedListener
            Assert-Cutback ($ports.Count -eq 1 -and
                $now.ProcessId -eq $script:owned.ProcessId -and
                $now.CreationUtcTicks -eq $script:owned.CreationUtcTicks) 'Unknown listener blocks staged rollback.'
            $script:stageStillRunning=$true
        } else {
            $script:stageStillRunning=$false
        }
    }
    RestoreStage = {
        if (-not $script:stageStillRunning) {
            $secretFile=Join-Path $script:stateDir 'bridge-token.secret'
            Assert-Cutback (Test-Path -LiteralPath $secretFile -PathType Leaf) 'Existing bridge credential unavailable.'
            $secret=([IO.File]::ReadAllText($secretFile)).Trim()
            Assert-Cutback ($secret -match '^[A-Za-z0-9_-]{60,}$') 'Existing bridge credential invalid.'
            $node=(Get-Command node.exe -ErrorAction Stop).Source
            $prior=[Environment]::GetEnvironmentVariable('TETHERPLANE_AUTH_BRIDGE_TOKEN','Process')
            try {
                $env:TETHERPLANE_AUTH_BRIDGE_TOKEN=$secret
                $nonce=[Guid]::NewGuid().ToString('N')
                $stdout=Join-Path $script:stateDir ("tether-auth-cutback-$nonce.stdout.log")
                $stderr=Join-Path $script:stateDir ("tether-auth-cutback-$nonce.stderr.log")
                $argsText='auth/dist/cli.js --config "' + $script:authConfig +
                    '" --host 127.0.0.1 --port 8790 --allow-insecure-localhost'
                $started=Start-Process -FilePath $node -ArgumentList $argsText -WorkingDirectory $script:sourceRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru -ErrorAction Stop
                Assert-Cutback ($null -ne $started) 'Failed to launch staged rollback.'
                $script:rollbackStagePid=[int]$started.Id
            } finally {
                $secret=$null
                if ($null -eq $prior) { Remove-Item Env:\TETHERPLANE_AUTH_BRIDGE_TOKEN -ErrorAction SilentlyContinue }
                else { $env:TETHERPLANE_AUTH_BRIDGE_TOKEN=$prior }
            }
        }
    }
    VerifyStage = {
        $ready=$false
        for($i=0;$i -lt 35;$i++) {
            try {
                Assert-Cutback ((Get-TaskSnapshot) -ceq $script:baselineXml) 'S4U task changed during staged rollback.'
                Assert-StagedHealth
                $ports=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq 8790})
                Assert-Cutback ($ports.Count -eq 1 -and $ports[0].LocalAddress -ceq '127.0.0.1') 'Staged listener not exclusive.'
                $expectedPid=if($script:stageStillRunning){$script:owned.ProcessId}else{$script:rollbackStagePid}
                Assert-Cutback ([int]$ports[0].OwningProcess -eq [int]$expectedPid) 'Staged listener not owned by cutback rollback.'
                $proc=Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$expectedPid) -ErrorAction Stop
                Assert-Cutback ($null -ne $proc -and $proc.Name -ieq 'node.exe' -and
                    (Test-OwnedStageCommandLine -CommandLine ([string]$proc.CommandLine) -ExpectedConfig $script:authConfig)) 'Staged rollback process identity invalid.'
                if (-not $script:stageStillRunning) {
                    $record=[ordered]@{
                        schema='tether-auth-owned-stage/v2';port=8790
                        pid=[int]$proc.ProcessId;parentPid=[int]$proc.ParentProcessId
                        creationUtcTicks=([datetime]$proc.CreationDate).ToUniversalTime().Ticks
                    }
                    $temporaryProof=Join-Path $script:stateDir ('cutback-proof-' + [Guid]::NewGuid().ToString('N') + '.tmp')
                    $evidence=Join-Path $script:stateDir ('cutback-old-proof-' + [Guid]::NewGuid().ToString('N') + '.tmp')
                    [IO.File]::WriteAllText($temporaryProof,($record | ConvertTo-Json -Compress),([Text.UTF8Encoding]::new($false)))
                    Set-Acl -LiteralPath $temporaryProof -AclObject (Get-Acl -LiteralPath $script:protectedRunner -ErrorAction Stop) -ErrorAction Stop
                    [IO.File]::Replace($temporaryProof,$script:proofPath,$evidence)
                }
                $ready=$true
                break
            } catch {
                Start-Sleep -Seconds 1
            }
        }
        Assert-Cutback $ready 'Staged auth rollback did not independently verify readiness and process ownership.'
    }
}
$result=Invoke-StagedCutbackTransaction -Operations $ops
if ($result -cne 's4u_restored') {throw 'Unexpected cutback state.'}
Write-Output 'STAGED CUTBACK VERIFIED: original S4U v1 task and independent postcheck healthy.'
