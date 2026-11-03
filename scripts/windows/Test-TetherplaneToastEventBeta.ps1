# Isolated end-to-end Windows developer-beta notification acceptance.
# Synthetic loopback only. No real relay, device credentials, or agent task changes.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ToastExecutable,
    [Parameter(Mandatory=$true)][string]$AgentExecutable,
    [string]$ExpectedToastSha256,
    [string]$ExpectedAgentSha256,
    [switch]$UseSyntheticArgumentsFile,
    [switch]$KeepRegistration,
    [switch]$KeepEvidence
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$identity = 'ARCUSLabs.Tetherplane.DevBeta'
$registrar = Join-Path $PSScriptRoot 'Register-TetherplaneToastBeta.ps1'
$fixture = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\tests\release\windows-toast-loopback-relay.mjs')).Path
if (-not [IO.Path]::IsPathRooted($ToastExecutable) -or
    -not [IO.Path]::IsPathRooted($AgentExecutable) -or
    (Split-Path -Leaf $ToastExecutable) -cne 'tetherplane-toast-smoke.exe' -or
    (Split-Path -Leaf $AgentExecutable) -cne 'tetherd.exe' -or
    -not (Test-Path -LiteralPath $ToastExecutable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $AgentExecutable -PathType Leaf)) {
    throw 'BETA_EXECUTABLE_INPUTS_INVALID'
}
$toast = (Resolve-Path -LiteralPath $ToastExecutable).Path
$agent = (Resolve-Path -LiteralPath $AgentExecutable).Path
foreach($artifact in @(
    @{ Path = $toast; Expected = $ExpectedToastSha256; Name = 'TOAST' },
    @{ Path = $agent; Expected = $ExpectedAgentSha256; Name = 'AGENT' }
)) {
    if ($artifact.Expected -and
        (Get-FileHash -LiteralPath $artifact.Path -Algorithm SHA256).Hash -ine $artifact.Expected) {
        throw ('BETA_' + $artifact.Name + '_ARTIFACT_HASH_MISMATCH')
    }
}
$link = Join-Path ([Environment]::GetFolderPath('Programs')) 'Tetherplane Developer Beta.lnk'
$createdHere = -not (Test-Path -LiteralPath $link)
$registered = $false
$scriptSuccess = $false
$evidence = Join-Path $env:TEMP ('TPToastAcceptance-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidence -ErrorAction Stop | Out-Null
$credentialFile = Join-Path $evidence 'synthetic-credential.txt'
[IO.File]::WriteAllText($credentialFile, 'synthetic-notification-only-credential', [Text.Encoding]::ASCII)
[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
$manager = [Windows.UI.Notifications.ToastNotificationManager]
$node = (Get-Command node.exe -ErrorAction Stop).Source

function Get-HistoryCount {
    return @($manager::History.GetHistory($identity)).Count
}
function Get-EventTagCount {
    param([ValidateSet('cn','uk')][string]$Kind)
    $count = 0
    foreach($item in @($manager::History.GetHistory($identity))) {
        # Windows may retain entries with null Content. Only trust our bounded
        # beta group and unique event-type tags, not XML or global history totals.
        if ($null -eq $item) { continue }
        try {
            $tag = [string]$item.Tag
            $group = [string]$item.Group
            if ($group -ceq 'tetherplane-beta' -and
                $tag -cmatch ('^tb-' + $Kind + '-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$')) {
                $count++
            }
        } catch {
            continue
        }
    }
    return $count
}
function Run-SyntheticCase {
    param([ValidateSet('accept','reject')][string]$Mode)
    $serverStdout = Join-Path $evidence ($Mode + '.server.out')
    $serverStderr = Join-Path $evidence ($Mode + '.server.err')
    $agentStdout = Join-Path $evidence ($Mode + '.agent.out')
    $agentStderr = Join-Path $evidence ($Mode + '.agent.err')
    $serverProcess = $null
    $agentProcess = $null
    try {
        $serverProcess = Start-Process -FilePath $node -ArgumentList @('"' + $fixture + '"', $Mode) -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr
        $port = $null
        for ($i=0; $i -lt 90; $i++) {
            if (Test-Path -LiteralPath $serverStdout) {
                $line = Get-Content -LiteralPath $serverStdout -TotalCount 1 -ErrorAction SilentlyContinue
                if ($line -match '^MOCK_RELAY_PORT=(\d+)$') {
                    $port = [int]$Matches[1]
                    break
                }
            }
            if ($serverProcess.HasExited) { break }
            Start-Sleep -Milliseconds 100
        }
        if (-not $port) {
            throw ('BETA_MOCK_RELAY_FAILED_TO_START_' + $Mode)
        }
        $before = Get-HistoryCount
        $connectedBefore = Get-EventTagCount -Kind "cn"
        $unknownBefore = Get-EventTagCount -Kind "uk"
        $argList = @(
            '--relay-url', ('ws://127.0.0.1:' + $port + '/device'),
            '--device-id', 'TP_BETA_TEST',
            '--device-credential-file', ('"' + $credentialFile + '"'),
            '--allow', ('"' + $evidence + '"'),
            '--relay-allow-insecure-localhost',
            '--dev-beta-local-toasts'
        )
        if ($UseSyntheticArgumentsFile) {
            # Exercise the JSON-array compatibility path with synthetic loopback data only.
            # A separate actual agent identity must NEVER be loaded or copied here.
            $argFile = Join-Path $evidence ($Mode + '.synthetic-arguments.json')
            $plainArgs = @(
                '--relay-url', ('ws://127.0.0.1:' + $port + '/device'),
                '--device-id', 'TP_BETA_TEST',
                '--device-credential-file', $credentialFile,
                '--allow', $evidence,
                '--relay-allow-insecure-localhost'
            )
            $json = ConvertTo-Json -InputObject $plainArgs -Compress
            [IO.File]::WriteAllText($argFile, $json, [Text.UTF8Encoding]::new($false))
            $argList = @('--arguments-file', ('"' + $argFile + '"'), '--dev-beta-local-toasts')
            Write-Output 'BETA_SYNTHETIC_ARGUMENT_FILE_MODE'
        }
        $agentProcess = Start-Process -FilePath $agent -ArgumentList $argList -WindowStyle Hidden -PassThru -RedirectStandardOutput $agentStdout -RedirectStandardError $agentStderr
        if ($Mode -eq 'reject') {
            Start-Sleep -Seconds 2
            $after = Get-HistoryCount
            $connectedAfter = Get-EventTagCount -Kind "cn"
            $unknownAfter = Get-EventTagCount -Kind "uk"
            Write-Output ('BETA_401_HISTORY_BEFORE=' + $before)
            Write-Output ('BETA_401_HISTORY_AFTER=' + $after)
            if ($after -ne $before -or
                $connectedAfter -ne $connectedBefore -or
                $unknownAfter -ne $unknownBefore) {
                throw 'BETA_401_GENERATED_UNAUTHORIZED_NOTIFICATION'
            }
            $serverEvidence = Get-Content -LiteralPath $serverStdout -Raw
            $agentEvidence = Get-Content -LiteralPath $agentStderr -Raw
            if ($serverEvidence -notmatch 'MOCK_UPGRADE_REJECTED' -or
                $agentEvidence -notmatch 'relay rejected device authentication with HTTP 401') {
                throw 'BETA_401_HANDSHAKE_DENIAL_NOT_PROVEN'
            }
            Write-Output 'BETA_401_NO_NOTIFICATION_VERIFIED'
        } else {
            $after = $before
            $connectedAfter = $connectedBefore
            $unknownAfter = $unknownBefore
            for ($i=0; $i -lt 100; $i++) {
                $after = Get-HistoryCount
                $connectedAfter = Get-EventTagCount -Kind "cn"
                $unknownAfter = Get-EventTagCount -Kind "uk"
                if ($connectedAfter -gt $connectedBefore -and $unknownAfter -gt $unknownBefore) { break }
                if ($agentProcess.HasExited) { break }
                Start-Sleep -Milliseconds 100
            }
            Write-Output ('BETA_101_HISTORY_BEFORE=' + $before)
            Write-Output ('BETA_101_HISTORY_AFTER=' + $after)
            Write-Output ('BETA_101_CONNECTED_NEW=' + ($connectedAfter - $connectedBefore))
            Write-Output ('BETA_101_UNKNOWN_NEW=' + ($unknownAfter - $unknownBefore))
            if ($connectedAfter -le $connectedBefore -or $unknownAfter -le $unknownBefore) {
                throw 'BETA_ACCEPTED_AGENT_CONNECTION_OR_UNKNOWN_NOTIFICATION_NOT_OBSERVED'
            }
            $serverEvidence = Get-Content -LiteralPath $serverStdout -Raw
            if ($serverEvidence -notmatch 'MOCK_UPGRADE_ACCEPTED') {
                throw 'BETA_101_HANDSHAKE_NOT_PROVEN'
            }
            Write-Output 'BETA_AUTHENTICATED_SESSION_EVENT_HISTORY_VERIFIED'
        }
    } finally {
        if ($agentProcess -and -not $agentProcess.HasExited) {
            Stop-Process -Id $agentProcess.Id -Force -ErrorAction SilentlyContinue
        }
        if ($serverProcess -and -not $serverProcess.HasExited) {
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
try {
    & $registrar -Operation Register -Executable $toast | Out-Host
    $registered = $true
    Run-SyntheticCase -Mode reject
    Run-SyntheticCase -Mode accept
    $scriptSuccess = $true
    Write-Output 'BETA_LOOPBACK_END_TO_END_VERIFIED'
    Write-Output 'BETA_NATIVE_POPUP_VISIBILITY_NOT_HUMAN_CONFIRMED'
} finally {
    if ($registered -and $createdHere -and -not $KeepRegistration) {
        & $registrar -Operation Unregister | Out-Host
    }
    if (-not $KeepEvidence -and $scriptSuccess) {
        Remove-Item -LiteralPath $evidence -Recurse -Force -ErrorAction Stop
    } else {
        Write-Output ('BETA_EVIDENCE_DIRECTORY=' + $evidence)
    }
}
