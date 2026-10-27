$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Isolated tests only. Never install anything on user devices.
if ($env:GITHUB_ACTIONS -cne 'true' -or
    $env:GITHUB_EVENT_NAME -cne 'pull_request' -or
    $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [string]::IsNullOrEmpty($env:RUNNER_TEMP) -or
    -not $env:GITHUB_HEAD_REF.StartsWith('fix/windows-scheduled-agent-preflight-')) {
    throw 'SCHEDULED_PREFLIGHT_TEST_DENIED: disposable same-repo PR runner only'
}

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$installer = Join-Path $repo 'scripts\install-windows.ps1'
$root = Join-Path $env:RUNNER_TEMP ('tp-task-preflight-' + [guid]::NewGuid().ToString('N'))
$package = Join-Path $root 'package'
$global:TP_CI_SacMode = 0

# Shadow only this shell process's registry reader for the synthetic SAC
# test. Never change the real machine registry or Windows security policy.
function global:Get-ItemProperty {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Name)
    if ($LiteralPath -ne 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -or
        $Name -ne 'VerifiedAndReputablePolicyState') {
        throw 'Synthetic SAC mock queried unexpected key'
    }
    [pscustomobject]@{ VerifiedAndReputablePolicyState = $global:TP_CI_SacMode }
}

function Invoke-TestPreflight {
    param(
        [string]$Label,
        [string]$Json,
        [bool]$ShouldPass
    )
    $argsFile = Join-Path $root ("args-" + $Label + ".json")
    $install = Join-Path $root ("no-install-" + $Label)
    $state = Join-Path $root ("no-state-" + $Label)
    [IO.File]::WriteAllText($argsFile, $Json, [Text.UTF8Encoding]::new($false))
    $errorText = $null
    $result = $null
    try {
        $result = & $installer -PackagePath $package -InstallPrefix $install -StateDir $state -InstallScheduledTask -AgentArgumentsFile $argsFile -PreflightOnly
    } catch {
        $errorText = [string]$_.Exception.Message
    }
    if ($ShouldPass) {
        if ($null -ne $errorText -or [string]($result -join ' ') -notmatch 'TETHERPLANE_INSTALL_PREFLIGHT_PASS') {
            throw ('Valid synthetic preflight did not pass: ' + $Label)
        }
    } else {
        if ($null -eq $errorText -or $errorText -notmatch '^SCHEDULED_AGENT_PREFLIGHT_NO_GO') {
            throw ('Invalid synthetic preflight was not refused: ' + $Label)
        }
        if ($errorText -match 'localhost[.]invalid|test-only[.]credential|SYNTHETIC_PRIVATE_VALUE') {
            throw 'Preflight failure leaked source arguments'
        }
        if ($Label -eq 'sac-unsigned-pe-denied' -and $errorText -notmatch 'SAC is On') {
            throw 'Synthetic SAC enforcement did not reach native signature admission gate'
        }
    }
    if ((Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $state)) {
        throw ('Preflight unexpectedly created install/state files: ' + $Label)
    }
}

try {
    foreach ($required in @(
        'bin\tetherd.exe',
        'adapters\compact-mcp\dist\stdio-server.js',
        'protocol\schemas\result.schema.json',
        'launch\tetherplane-mcp.ps1',
        'manifest.json'
    )) {
        $file = Join-Path $package $required
        [IO.Directory]::CreateDirectory((Split-Path -Parent $file)) | Out-Null
        # The "PE" is deliberately NON-EXECUTABLE and unsigned.
        [IO.File]::WriteAllText($file, 'synthetic test fixture', [Text.UTF8Encoding]::new($false))
    }
    $global:TP_CI_SacMode = 0
    Invoke-TestPreflight 'empty' '[]' $false
    Invoke-TestPreflight 'no-relay-mode' '["--device-id","Leno"]' $false
    Invoke-TestPreflight 'missing-device-id' '["--relay-url","wss://localhost.invalid/device","--device-credential-file","C:\\test-only.credential"]' $false
    Invoke-TestPreflight 'missing-credential-file' '["--relay-url","wss://localhost.invalid/device","--device-id","Leno"]' $false
    Invoke-TestPreflight 'double-transport' '["--stdio-rpc","--relay-url","wss://localhost.invalid/device","--device-id","Leno","--device-credential-file","C:\\test-only.credential"]' $false
    Invoke-TestPreflight 'duplicate-device-id' '["--relay-url","wss://localhost.invalid/device","--device-id","Leno","--device-id","Leno","--device-credential-file","C:\\test-only.credential"]' $false
    Invoke-TestPreflight 'missing-value' '["--relay-url","--device-id","Leno","--device-credential-file","C:\\test-only.credential"]' $false
    Invoke-TestPreflight 'stdio-not-a-background-agent' '["--stdio-rpc"]' $false
    $remoteValid = '["--relay-url","wss://localhost.invalid/device","--device-id","Leno","--device-credential-file","C:\\test-only.credential"]'
    Invoke-TestPreflight 'valid-remote' $remoteValid $true

    $global:TP_CI_SacMode = 1
    Invoke-TestPreflight 'sac-unsigned-pe-denied' $remoteValid $false

    Write-Output 'WINDOWS_AGENT_PREFLIGHT_TEST_PASS: 10 synthetic cases, no install/state/task actions'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-ItemProperty -Force -ErrorAction SilentlyContinue
    Remove-Variable -Name TP_CI_SacMode -Scope Global -Force -ErrorAction SilentlyContinue
}
