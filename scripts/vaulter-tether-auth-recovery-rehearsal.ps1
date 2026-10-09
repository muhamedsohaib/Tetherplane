<#
.SYNOPSIS
  Guarded Windows S4U auth restart rehearsal, with read-only default.
.DESCRIPTION
  -Exercise terminates only the verified task-owned Node auth process to test
  automatic recovery; on failure it attempts manual task recovery, then restores
  staged auth with the protected credential if necessary.
  Reboot recovery remains unverified until tested separately.
#>
[CmdletBinding()]
param([switch]$Exercise)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:taskName = 'Tetherplane-TetherAuth-Startup'
$script:origin = 'https://vaulter.tailf65eba.ts.net'
$script:stateDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:repoDir = Split-Path -Parent $PSScriptRoot
$script:protectedRunner = Join-Path $script:stateDir 'tether-auth-startup-runner.ps1'
$script:authConfig = Join-Path $script:stateDir 'tether-auth-config.json'
$script:postcheck = Join-Path $PSScriptRoot 'vaulter-tether-auth-supervised-postcheck.ps1'

function Assert-Recovery([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Invoke-RestartRecoveryTransaction {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][hashtable]$Operations)
    foreach ($key in @(
        'VerifyBaseline','VerifyCrashTarget','CrashOwnedAuth','WaitAutomatic',
        'StartTaskManually','WaitManual','DisableTask','StopTask',
        'ClearOwnedListener','RestoreStage','VerifyStage'
    )) {
        if (-not $Operations.ContainsKey($key) -or
            -not ($Operations[$key] -is [scriptblock])) {
            throw 'Restart rehearsal operations are incomplete.'
        }
    }
    # No task or process may be changed if either pre-mutation check fails.
    & $Operations['VerifyBaseline']
    & $Operations['VerifyCrashTarget']
    try {
        & $Operations['CrashOwnedAuth']
        & $Operations['WaitAutomatic']
        return 'automatic'
    } catch {
        # Stop-Process may have taken effect before raising an error.
        try {
            & $Operations['StartTaskManually']
            & $Operations['WaitManual']
            return 'manual_only'
        } catch {
            $verified = $true
            foreach ($step in @(
                'DisableTask','StopTask','ClearOwnedListener',
                'RestoreStage','VerifyStage'
            )) {
                try { & $Operations[$step] }
                catch { $verified = $false }
            }
            if (-not $verified) {
                throw 'Auth restart failed; rollback unverified. Do not reboot or modify relay/Funnel.'
            }
            throw 'Auth restart failed; staged auth restored and rollback verified.'
        }
    }
}
function Get-Task {
    Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
}
function Get-Flag([string]$CommandLine, [string]$Flag) {
    $pattern = '(?i)(?:^|\s)' + [regex]::Escape($Flag) + '\s+(?:"([^"]+)"|(\S+))'
    $m = [regex]::Match($CommandLine, $pattern)
    if (-not $m.Success) { return $null }
    if ($m.Groups[1].Success) { return $m.Groups[1].Value }
    return $m.Groups[2].Value
}
function Get-AuthPortProcess {
    $ports = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
    if ($ports.Count -eq 0) { return $null }
    Assert-Recovery ($ports.Count -eq 1 -and
        $ports[0].LocalAddress -ceq '127.0.0.1') 'Auth is not bound exclusively to loopback.'
    $listenerPid = [int]$ports[0].OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction Stop
    Assert-Recovery ($null -ne $proc -and $proc.Name -ieq 'node.exe') 'Unexpected listener process.'
    $cmd = [string]$proc.CommandLine
    Assert-Recovery (
        $cmd -match '(?i)(?:^|[\s"\\/])auth[\\/]dist[\\/]cli\.js(?=[\s"]|$)' -and
        (Get-Flag $cmd '--host') -ceq '127.0.0.1' -and
        (Get-Flag $cmd '--port') -ceq '8790' -and
        $cmd.Contains('--allow-insecure-localhost')
    ) 'Listener does not run the intended auth CLI.'
    $cfg = Get-Flag $cmd '--config'
    Assert-Recovery ($cfg -and
        [IO.Path]::GetFullPath($cfg) -ieq $script:authConfig) 'Auth config path changed.'
    return [pscustomobject]@{
        ProcessId = $listenerPid
        ParentProcessId = [int]$proc.ParentProcessId
        CreationDate = $proc.CreationDate
    }
}
function Get-TaskOwnedListener {
    $listener = Get-AuthPortProcess
    if ($null -eq $listener) { return $null }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.ParentProcessId)" -ErrorAction Stop
    Assert-Recovery ($null -ne $parent -and
        $parent.Name -ieq 'powershell.exe') 'Auth listener is not task-owned.'
    Assert-Recovery (
        ([string]$parent.CommandLine).Contains($script:protectedRunner) -and
        ([string]$parent.CommandLine).Contains(' -Serve')
    ) 'Auth is not owned by the protected task runner.'
    return $listener
}
function Get-Json([string]$Url) {
    Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 12 -ErrorAction Stop
}
function Get-PublicJwksFingerprint([string]$Url) {
    $keys = @((Get-Json $Url).keys)
    Assert-Recovery ($keys.Count -gt 0) 'Public JWKS is empty.'
    $rows = @(
        foreach ($key in $keys) {
            $names = @($key.PSObject.Properties.Name)
            foreach ($field in @('d','p','q','dp','dq','qi','oth','k')) {
                Assert-Recovery (-not ($names -contains $field)) 'Public JWK includes a private field.'
            }
            Assert-Recovery ($key.kty -ceq 'RSA' -and
                -not [string]::IsNullOrWhiteSpace([string]$key.kid) -and
                -not [string]::IsNullOrWhiteSpace([string]$key.n) -and
                -not [string]::IsNullOrWhiteSpace([string]$key.e)) 'Public JWK is malformed.'
            [string]$key.kid + '|' + [string]$key.kty + '|' +
                [string]$key.n + '|' + [string]$key.e
        }
    )
    return (($rows | Sort-Object) -join ';')
}
function Verify-SharedState {
    $auth = Get-Json 'http://127.0.0.1:8790/readyz'
    $relay = Get-Json 'http://127.0.0.1:8788/healthz'
    $public = Get-Json "$script:origin/healthz"
    $resource = Get-Json "$script:origin/.well-known/oauth-protected-resource/mcp"
    Assert-Recovery ($auth.status -ceq 'ready' -and
        $relay.status -ceq 'ok' -and $public.status -ceq 'ok') 'Auth or relay not healthy.'
    Assert-Recovery (
        $resource.resource -ceq "$script:origin/mcp" -and
        @($resource.authorization_servers).Count -eq 1 -and
        @($resource.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/'
    ) 'Original Auth0 resource metadata changed.'
    Assert-Recovery (
        (Get-PublicJwksFingerprint 'http://127.0.0.1:8790/jwks') -ceq $script:baselineKeys -and
        (Get-PublicJwksFingerprint "$script:origin/jwks") -ceq $script:baselineKeys
    ) 'Local/public JWKS changed.'
}
function Wait-SupervisedAuth([int]$PriorPid, [int]$Attempts) {
    for ($i = 0; $i -lt $Attempts; $i++) {
        try {
            $listener = Get-TaskOwnedListener
            if ($null -ne $listener -and $listener.ProcessId -ne $PriorPid -and
                (Get-Task).State -eq 'Running') {
                $ready = Get-Json 'http://127.0.0.1:8790/readyz'
                if ($ready.status -ceq 'ready') {
                    & $script:postcheck | Out-Null
                    return
                }
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw 'Scheduled auth restart did not pass independent health and ownership checks.'
}
function Wait-FreePort([int]$Attempts=20) {
    for ($i = 0; $i -lt $Attempts; $i++) {
        $ports = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
        if ($ports.Count -eq 0) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Auth port 8790 remained occupied; refusing duplicate auth startup.'
}
