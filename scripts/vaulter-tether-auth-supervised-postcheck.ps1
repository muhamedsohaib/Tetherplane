<#
.SYNOPSIS
  Independently verify active S4U supervision for tether-auth on Vaulter.
.DESCRIPTION
  Read-only inspection of the registered startup task, listener and parent
  process, protected runner hash, local/public auth health, JWKS, current Auth0
  relay metadata, public Funnel root/JWKS and all four private routes.
  No Windows account identities, process command lines or key contents print.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:origin = 'https://vaulter.tailf65eba.ts.net'
$script:taskName = 'Tetherplane-TetherAuth-Startup'
$script:stateDir = Join-Path $env:LOCALAPPDATA 'Tetherplane\tether-auth'
$script:repoRoot = Split-Path -Parent $PSScriptRoot
$script:protectedRunner = Join-Path $script:stateDir 'tether-auth-startup-runner.ps1'
$script:authConfig = Join-Path $script:stateDir 'tether-auth-config.json'

function Assert-Postcheck([bool]$Condition, [string]$Reason) {
    if (-not $Condition) { throw $Reason }
}

function Test-TaskPrincipalIsCurrentUser {
    [CmdletBinding()]
    param(
        [AllowEmptyString()][string]$TaskUserId,
        [System.Security.Principal.SecurityIdentifier]$CurrentUserSid
    )
    if ([string]::IsNullOrWhiteSpace($TaskUserId) -or $null -eq $CurrentUserSid) {
        return $false
    }
    try {
        if ($TaskUserId -match '^S-\d-\d+(?:-\d+)+$') {
            $taskSid = [System.Security.Principal.SecurityIdentifier]::new($TaskUserId)
        } else {
            $account = [System.Security.Principal.NTAccount]::new($TaskUserId)
            $taskSid = $account.Translate([System.Security.Principal.SecurityIdentifier])
        }
        return ([string]$taskSid.Value -ceq [string]$CurrentUserSid.Value)
    } catch {
        return $false
    }
}

function Get-FlagValue([string]$CommandLine, [string]$Flag) {
    $pattern = '(?i)(?:^|\s)' + [regex]::Escape($Flag) + '\s+(?:"([^"]+)"|(\S+))'
    $match = [regex]::Match($CommandLine, $pattern)
    if (-not $match.Success) { return $null }
    if ($match.Groups[1].Success) { return $match.Groups[1].Value }
    return $match.Groups[2].Value
}

function Get-AuthListener {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)
    Assert-Postcheck ($listeners.Count -eq 1 -and
        $listeners[0].LocalAddress -ceq '127.0.0.1') 'Auth port 8790 is not bound exclusively to loopback.'
    $listenerProcessId = [int]$listeners[0].OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerProcessId" -ErrorAction Stop
    Assert-Postcheck ($null -ne $proc -and $proc.Name -ieq 'node.exe') 'Auth listener is not Node.js.'
    # Inspect command line only in memory. Never print process arguments.
    $cmd = [string]$proc.CommandLine
    Assert-Postcheck (
        $cmd -match '(?i)(?:^|[\s"\\/])auth[\\/]dist[\\/]cli\.js(?=[\s"]|$)' -and
        $cmd.Contains('--allow-insecure-localhost') -and
        (Get-FlagValue $cmd '--port') -ceq '8790' -and
        (Get-FlagValue $cmd '--host') -ceq '127.0.0.1'
    ) 'The Node.js listener does not match the restricted auth startup command.'
    $rawConfig = Get-FlagValue $cmd '--config'
    Assert-Postcheck ($rawConfig -and
        [IO.Path]::GetFullPath($rawConfig) -ieq $script:authConfig) 'Auth listener references a different configuration.'
    return [pscustomobject]@{
        ProcessId = $listenerProcessId
        ParentProcessId = [int]$proc.ParentProcessId
    }
}

function Get-Json([string]$Url, [hashtable]$Headers = @{}) {
    Invoke-RestMethod -Uri $Url -Method Get -Headers $Headers -TimeoutSec 15 -ErrorAction Stop
}

function Get-PublicJwksFingerprint([string]$Url) {
    $jwks = Get-Json $Url
    $keys = @($jwks.keys)
    Assert-Postcheck ($keys.Count -gt 0) 'JWKS contains no signing verification keys.'
    $rows = @(
        foreach ($key in $keys) {
            $properties = @($key.PSObject.Properties.Name)
            foreach ($privateField in @('d','p','q','dp','dq','qi','oth','k')) {
                Assert-Postcheck (-not ($properties -contains $privateField)) 'Public JWKS has a private key field.'
            }
            Assert-Postcheck (
                $key.kty -ceq 'RSA' -and
                -not [string]::IsNullOrWhiteSpace([string]$key.kid) -and
                -not [string]::IsNullOrWhiteSpace([string]$key.n) -and
                -not [string]::IsNullOrWhiteSpace([string]$key.e)
            ) 'Public JWKS verification key has an invalid structure.'
            [string]$key.kid + '|' + [string]$key.kty + '|' +
                [string]$key.n + '|' + [string]$key.e
        }
    )
    return (($rows | Sort-Object) -join ';')
}

Assert-Postcheck ($env:OS -eq 'Windows_NT' -and
    $env:COMPUTERNAME -ieq 'vaulter') 'Read-only auth inspection is restricted to Vaulter.'
Assert-Postcheck (Test-Path -LiteralPath $script:stateDir -PathType Container) 'Protected auth directory missing.'
Assert-Postcheck ((Get-Acl -LiteralPath $script:stateDir).AreAccessRulesProtected) 'Auth directory ACL is not protected.'
$sourceRunner = Join-Path $script:repoRoot 'scripts\vaulter-tether-auth-startup-runner.ps1'
foreach ($file in @($sourceRunner, $script:protectedRunner, $script:authConfig)) {
    Assert-Postcheck (Test-Path -LiteralPath $file -PathType Leaf) 'Required public configuration or protected runner missing.'
}
Assert-Postcheck (
    (Get-FileHash -LiteralPath $sourceRunner -Algorithm SHA256).Hash -ceq
    (Get-FileHash -LiteralPath $script:protectedRunner -Algorithm SHA256).Hash
) 'Installed protected task runner differs from the verified repository version.'

$task = Get-ScheduledTask -TaskName $script:taskName -TaskPath '\' -ErrorAction Stop
Assert-Postcheck ($task.State -eq 'Running') 'S4U auth startup task is not running.'
Assert-Postcheck ([string]$task.Principal.LogonType -ceq 'S4U') 'Auth task is not configured for S4U.'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
Assert-Postcheck (
    (Test-TaskPrincipalIsCurrentUser ([string]$task.Principal.UserId) $identity.User)
) 'Auth task principal is not the protected state owner.'
Assert-Postcheck (@($task.Triggers | Where-Object {
    $_.CimClass.CimClassName -match 'BootTrigger$'
}).Count -gt 0) 'Auth task is missing a startup trigger.'
Assert-Postcheck ([int]$task.Settings.RestartCount -gt 0) 'Auth task has no restart policy.'
Assert-Postcheck (@($task.Actions).Count -eq 1) 'Auth task has an unexpected number of actions.'
$action = @($task.Actions)[0]
$expectedHost = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Assert-Postcheck ([string]$action.Execute -ieq $expectedHost) 'Auth task uses an unexpected executable.'
Assert-Postcheck (
    ([string]$action.Arguments).Contains(' -File "' + $script:protectedRunner + '"') -and
    ([string]$action.Arguments).EndsWith(' -Serve', [StringComparison]::Ordinal)
) 'Auth task no longer invokes the protected startup runner.'

$listener = Get-AuthListener
$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.ParentProcessId)" -ErrorAction Stop
Assert-Postcheck ($null -ne $parent -and
    $parent.Name -ieq 'powershell.exe') 'Auth listener parent is not the registered Windows PowerShell runner.'
Assert-Postcheck (
    ([string]$parent.CommandLine).Contains($script:protectedRunner) -and
    ([string]$parent.CommandLine).Contains(' -Serve')
) 'Auth listener is not owned by the protected task startup runner.'

$authHealth = Get-Json 'http://127.0.0.1:8790/healthz'
$authReady = Get-Json 'http://127.0.0.1:8790/readyz'
$relayHealth = Get-Json 'http://127.0.0.1:8788/healthz'
$publicRelayHealth = Get-Json "$script:origin/healthz"
$publicRelayReady = Get-Json "$script:origin/readyz"
Assert-Postcheck ($authHealth.status -ceq 'ok' -and
    $authReady.status -ceq 'ready' -and
    $relayHealth.status -ceq 'ok' -and
    $publicRelayHealth.status -ceq 'ok' -and
    $publicRelayReady.status -ceq 'ready') 'One or more local/public health probes failed.'

$resource = Get-Json "$script:origin/.well-known/oauth-protected-resource/mcp"
Assert-Postcheck ($resource.resource -ceq "$script:origin/mcp" -and
    @($resource.authorization_servers).Count -eq 1 -and
    @($resource.authorization_servers)[0] -ceq 'https://tetherplane-dev.eu.auth0.com/') 'Public MCP resource or Auth0 issuer has unexpectedly changed.'

$forwarded = @{
    'X-Forwarded-Proto' = 'https'
    'X-Forwarded-Host' = ([Uri]$script:origin).Authority
}
$metadata = Get-Json -Url 'http://127.0.0.1:8790/.well-known/openid-configuration' -Headers $forwarded
Assert-Postcheck ($metadata.issuer -ceq "$script:origin/" -and
    @($metadata.code_challenge_methods_supported) -contains 'S256') 'Authorization-server issuer or PKCE metadata changed.'
foreach ($field in @('authorization_endpoint','token_endpoint','jwks_uri','registration_endpoint')) {
    $endpoint = [string]$metadata.$field
    Assert-Postcheck ($endpoint.StartsWith("$script:origin/",[StringComparison]::Ordinal)) 'Public authorization-server endpoint origin changed.'
}

$localPublicKeys = Get-PublicJwksFingerprint 'http://127.0.0.1:8790/jwks'
$publicKeys = Get-PublicJwksFingerprint "$script:origin/jwks"
Assert-Postcheck ($localPublicKeys -ceq $publicKeys) 'Public signing verification keys differ between loopback and Funnel.'

$ts = Get-Command tailscale.exe -ErrorAction Stop
$lines = @(& $ts.Source funnel status)
Assert-Postcheck ($LASTEXITCODE -eq 0) 'Cannot inspect existing Tailscale Funnel configuration.'
$status = ($lines -join [Environment]::NewLine)
Assert-Postcheck (
    $status.Contains("$script:origin (Funnel on)") -and
    $status.Contains('|-- / proxy http://127.0.0.1:8788') -and
    $status.Contains('/jwks proxy http://127.0.0.1:8790/jwks')
) 'Public Funnel root or JWKS canary changed.'
foreach ($port in @('10000','8443','9443','9445')) {
    Assert-Postcheck ($status.Contains("$($script:origin):$port (tailnet only)")) 'A private Funnel port changed.'
}

Write-Output "SUPERVISED AUTH POSTCHECK PASS: task=Running, listenerPID=$($listener.ProcessId), task-owned parent=verified."
Write-Output 'Auth ready, relay healthy, original Auth0 issuer, public signing keys, and four private ports: VERIFIED.'
Write-Output 'No changes made. Reboot recovery and authenticated ChatGPT acceptance remain unverified.'
