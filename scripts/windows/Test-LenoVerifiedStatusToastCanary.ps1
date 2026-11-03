# Manual, single-shot Leno status-notification canary.
# The observer MUST have just independently checked device.status through an
# authenticated, authorized Tetherplane connection. This script cannot make or
# authenticate that request; it is a user-session presentation test only.
# No persistent watcher, agent launch, OAuth modification, network call or startup edit.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$KitZip,
    [Parameter(Mandatory=$true)][string]$ExpectedKitSha256,
    [Parameter(Mandatory=$true)][string]$ObservedAtUtc,
    [Parameter(Mandatory=$true)][string]$AgentVersion,
    [Parameter(Mandatory=$true)][ValidateSet('authenticated')][string]$Transport,
    [Parameter(Mandatory=$true)][ValidateSet('ready')][string]$AgentState
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$appId = 'ARCUSLabs.Tetherplane.DevBeta'
$sourceId = 'manually-verified-tetherplane-mcp-snapshot'
$registrar = Join-Path $PSScriptRoot 'Register-TetherplaneToastBeta.ps1'
if(-not(Test-Path -LiteralPath $registrar -PathType Leaf)) {throw 'BETA_REGISTRAR_NOT_FOUND'}
if(-not [IO.Path]::IsPathRooted($KitZip) -or -not (Test-Path -LiteralPath $KitZip -PathType Leaf)) {
    throw 'BETA_KIT_REQUIRED'
}
if($ExpectedKitSha256 -notmatch '^[0-9a-fA-F]{64}$' -or
   (Get-FileHash -LiteralPath $KitZip -Algorithm SHA256).Hash -ine $ExpectedKitSha256) {
    throw 'BETA_KIT_HASH_MISMATCH'
}
if($AgentVersion -notmatch '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}([-.][A-Za-z0-9.-]+)?$') {
    throw 'INVALID_AGENT_VERSION'
}
try {
    $observed = [DateTimeOffset]::Parse($ObservedAtUtc,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
} catch {throw 'INVALID_OBSERVATION_TIMESTAMP'}
$ageSeconds=([DateTimeOffset]::UtcNow - $observed).TotalSeconds
if($ageSeconds -lt -15 -or $ageSeconds -gt 90) {
    throw 'STALE_OR_FUTURE_AUTHENTICATED_STATUS_EVIDENCE'
}
$temporary = Join-Path $env:TEMP ('TPVerifiedStatusToast-' + [guid]::NewGuid().ToString('N'))
$link=Join-Path ([Environment]::GetFolderPath('Programs')) 'Tetherplane Developer Beta.lnk'
$createdHere= -not(Test-Path -LiteralPath $link)
$registered=$false
$finished=$false
New-Item -ItemType Directory -Path $temporary -ErrorAction Stop | Out-Null
try {
    Expand-Archive -LiteralPath $KitZip -DestinationPath $temporary -ErrorAction Stop
    $exe=Join-Path $temporary 'bin\tetherplane-toast-smoke.exe'
    $evidence=Join-Path $temporary 'toast-beta-build-evidence.txt'
    if(-not(Test-Path -LiteralPath $exe -PathType Leaf) -or
       -not(Test-Path -LiteralPath $evidence -PathType Leaf)) {
        throw 'BETA_KIT_CONTENTS_INCOMPLETE'
    }
    $declared = Get-Content -LiteralPath $evidence | Where-Object {$_ -match '^sha256='} | Select-Object -First 1
    if(-not $declared -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ine $declared.Substring(7)) {
        throw 'BETA_KIT_BINARY_HASH_MISMATCH'
    }
    & $registrar -Operation Register -Executable $exe | Out-Host
    $registered=$true
    [void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
    [void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]
    $tag='status-'+$observed.ToUnixTimeSeconds()+'-'+([guid]::NewGuid().ToString('N').Substring(0,8))
    $title='Tetherplane / Leno - verified snapshot'
    $body=('Authenticated MCP device.status: '+$AgentState+' / '+$Transport+
        '; agent v'+$AgentVersion+' at '+$observed.ToUniversalTime().ToString('HH:mm:ss')+
        ' UTC. One-time check, not continuous monitoring.')
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $escapedTitle=[Security.SecurityElement]::Escape($title)
    $escapedBody=[Security.SecurityElement]::Escape($body)
    $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>'+ $escapedTitle + '</text><text>' + $escapedBody + '</text></binding></visual></toast>')
    $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
    $toast.Tag=$tag
    $toast.Group='tetherplane-verified-snapshot'
    $notifier=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
    $notifier.Show($toast)
    $history=[Windows.UI.Notifications.ToastNotificationManager]::History
    $verified=$false
    for($i=0;$i -lt 25;$i++){
        $match=@($history.GetHistory($appId) | Where-Object {$_.Tag -ceq $tag -and $_.Group -ceq 'tetherplane-verified-snapshot'})
        if($match.Count -eq 1){
            $stored=$match[0].Content.GetXml()
            if($stored -match [regex]::Escape('One-time check, not continuous monitoring.')){
                $verified=$true
                break
            }
        }
        Start-Sleep -Milliseconds 100
    }
    if(-not $verified){throw 'UNIQUE_LENO_STATUS_NOTIFICATION_HISTORY_NOT_VERIFIED'}
    Write-Output 'LENO_AUTHENTICATED_STATUS_SNAPSHOT_TOAST_STORED'
    Write-Output ('SOURCE=' + $sourceId)
    Write-Output ('OBSERVED_AT_UTC=' + $observed.ToUniversalTime().ToString('o'))
    Write-Output ('NOTIFICATION_TAG=' + $tag)
    Write-Output 'HUMAN_VISIBLE_POPUP_NOT_VERIFIED'
    $finished=$true
} finally {
    if($registered -and $createdHere){
        & $registrar -Operation Unregister | Out-Host
    }
    if($finished -and (Test-Path -LiteralPath $temporary)){
        Remove-Item -LiteralPath $temporary -Force -Recurse -ErrorAction Stop
        Write-Output 'CANARY_SCRATCH_CLEANED'
    }elseif(-not $finished){
        Write-Output ('CANARY_FAILURE_EVIDENCE=' + $temporary)
    }
}
