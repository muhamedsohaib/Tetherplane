# Read-only VAULTER receipt for the existing owner-managed relay authority.
# Never displays token contents, OAuth client IDs, principal IDs, command lines or paths.
# This does not discover or register OAuth clients or activate grants.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpectedExistingOwnerClientId,

    [string]$AuthorityConfigPath = ''
)

$ErrorActionPreference = 'Stop'

function Out-Receipt([string]$Key, [object]$Value) {
    Write-Output ($Key + '=' + [string]$Value)
}

Out-Receipt 'HOST_IS_VAULTER' ($env:COMPUTERNAME -ieq 'VAULTER')

$nodeProcesses = @()
try {
    $nodeProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -Property ProcessId, Name, CommandLine)
} catch {
    Out-Receipt 'RELAY_PROCESS_METADATA' 'UNAVAILABLE'
    return
}

$relays = @($nodeProcesses | Where-Object {
    $line = [string]$_.CommandLine
    $line -match '(?i)(?:relay[\\/](?:dist[\\/])?cli\.(?:js|mjs)|tether-relay)'
})

$withFlag = @($relays | Where-Object {
    [string]$_.CommandLine -match '(?i)(?:^|\s)--authority-config\s+'
})

Out-Receipt 'RELAY_PROCESS_COUNT' $relays.Count
Out-Receipt 'RELAY_WITH_OWNER_CONFIG_COUNT' $withFlag.Count

# The effective owner-binding source is unverified unless there is exactly
# one uniquely identified running relay process with the expected flag.
$liveConfigPath = $null
if ($relays.Count -eq 1 -and $withFlag.Count -eq 1) {
    $match = [regex]::Match(
        [string]$withFlag[0].CommandLine,
        '(?i)(?:^|\s)--authority-config\s+(?:"([^"]+)"|''([^'']+)''|(\S+))'
    )
    if ($match.Success) {
        foreach ($group in @(1,2,3)) {
            if ($match.Groups[$group].Success) {
                $liveConfigPath = [Environment]::ExpandEnvironmentVariables(
                    $match.Groups[$group].Value
                )
                break
            }
        }
    }
}

$effective = $false
$configPath = $null
if (-not [string]::IsNullOrWhiteSpace($AuthorityConfigPath)) {
    $configPath = [Environment]::ExpandEnvironmentVariables($AuthorityConfigPath)
    if ($liveConfigPath) {
        $effective = [string]::Equals(
            [IO.Path]::GetFullPath($configPath),
            [IO.Path]::GetFullPath($liveConfigPath),
            [StringComparison]::OrdinalIgnoreCase
        )
    }
} elseif ($liveConfigPath) {
    $configPath = $liveConfigPath
    $effective = $true
}

Out-Receipt 'RUNNING_RELAY_OWNER_CONFIG_VERIFIED' $effective

if (-not $configPath -or -not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Out-Receipt 'OWNER_CONFIG_EXISTS' $false
    Out-Receipt 'OWNER_CLIENT_MATCHES_RECORDED_EXISTING_ID' 'UNVERIFIED'
    Out-Receipt 'OWNER_ACCOUNT_AND_PRINCIPAL_CONFIGURED' 'UNVERIFIED'
    Out-Receipt 'ENFORCEMENT_STATE' 'UNVERIFIED'
    return
}
Out-Receipt 'OWNER_CONFIG_EXISTS' $true

$cfg = $null
try {
    $cfg = ConvertFrom-Json -InputObject (
        Get-Content -LiteralPath $configPath -Raw
    )
} catch {
    Out-Receipt 'OWNER_CONFIG_VALID_JSON' $false
    return
}

$validShape = (
    $cfg -and $cfg.owner -and
    @($cfg.PSObject.Properties.Name | Where-Object {
        $_ -notin @('owner','stateFile')
    }).Count -eq 0 -and
    @($cfg.owner.PSObject.Properties.Name | Where-Object {
        $_ -notin @('accountId','clientId','principalId')
    }).Count -eq 0
)
Out-Receipt 'OWNER_CONFIG_SHAPE_VALID' ([bool]$validShape)
if (-not $validShape) { return }

$matchClient = [string]::Equals(
    [string]$cfg.owner.clientId,
    $ExpectedExistingOwnerClientId,
    [StringComparison]::Ordinal
)
$hasIdentity = (
    -not [string]::IsNullOrWhiteSpace([string]$cfg.owner.accountId) -and
    -not [string]::IsNullOrWhiteSpace([string]$cfg.owner.principalId)
)
Out-Receipt 'OWNER_CLIENT_MATCHES_RECORDED_EXISTING_ID' $matchClient
Out-Receipt 'OWNER_ACCOUNT_AND_PRINCIPAL_CONFIGURED' $hasIdentity

$stateFile = [string]$cfg.stateFile
if ([string]::IsNullOrWhiteSpace($stateFile) -or
    -not [IO.Path]::IsPathRooted($stateFile)) {
    Out-Receipt 'OWNER_STATE_PATH_VALID' $false
    return
}
Out-Receipt 'OWNER_STATE_PATH_VALID' $true

if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
    Out-Receipt 'ENFORCEMENT_STATE' 'NOT_INITIALIZED_OR_MISSING'
    return
}

try {
    $state = ConvertFrom-Json -InputObject (
        Get-Content -LiteralPath $stateFile -Raw
    )
    if ($state.version -ne 1 -or $state.enabled -isnot [bool] -or
        $state.revision -isnot [int] -or
        $state.revision -lt 0 -or $null -eq $state.grants) {
        Out-Receipt 'ENFORCEMENT_STATE' 'INVALID'
        return
    }
    Out-Receipt 'ENFORCEMENT_STATE' $(if ($state.enabled) { 'ENABLED' } else { 'DISABLED' })
    Out-Receipt 'OWNER_GRANT_REVISION' ([int]$state.revision)
    Out-Receipt 'OWNER_GRANT_COUNT' (@($state.grants).Count)
} catch {
    Out-Receipt 'ENFORCEMENT_STATE' 'UNREADABLE_OR_INVALID'
}
