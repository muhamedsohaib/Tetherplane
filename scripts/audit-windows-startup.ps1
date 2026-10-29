# Read-only Windows Task Scheduler / process audit. No secrets in output.
[CmdletBinding()]
param(
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA 'Programs\Tetherplane')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function TaskScript($action) {
    if (-not $action) { return $null }
    if ([IO.Path]::GetFileName([string]$action.Execute) -notin
        @('powershell.exe', 'pwsh.exe')) { return $null }
    $m = [regex]::Match([string]$action.Arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))')
    if (-not $m.Success) { return $null }
    return ($m.Groups[1].Value + $m.Groups[2].Value)
}
$tasks = @(
    Get-ScheduledTask -ErrorAction Stop |
    Where-Object {
        $_.TaskName -match '^(?i:Tetherplane|Tethrd)(?:\s|$)' -and
        $_.TaskPath -eq '\'
    } |
    Sort-Object TaskName |
    ForEach-Object {
        $a = @($_.Actions)
        $launcher = if ($a.Count -eq 1) { TaskScript $a[0] } else { $null }
        [ordered]@{
            name = [string]$_.TaskName
            state = [string]$_.State
            actionCount = $a.Count
            actionProgram = if ($a.Count -eq 1) {
                [IO.Path]::GetFileName([string]$a[0].Execute)
            } else { 'ambiguous' }
            # Launcher path is not a secret; command arguments are.
            launcherPath = $launcher
            requestsHiddenWindow = [bool]($a.Count -eq 1 -and
                [string]$a[0].Arguments -match '(?i)(?:^|\s)-WindowStyle\s+Hidden(?:\s|$)')
            requestedNonInteractive = [bool]($a.Count -eq 1 -and
                [string]$a[0].Arguments -match '(?i)(?:^|\s)-NonInteractive(?:\s|$)')
            multipleInstances = [string]$_.Settings.MultipleInstances
            protected = [bool]($_.TaskName -in @(
                'Tetherplane Emergency Relay',
                'Tetherplane Browser Bridge',
                'Tethrd - Device Gateway'
            ))
        }
    }
)
$exe = Join-Path $InstallPrefix 'bin\tetherd.exe'
$launch = Join-Path $InstallPrefix 'launch\tetherplane-agent.ps1'
$signature = if (Test-Path -LiteralPath $exe -PathType Leaf) {
    Get-AuthenticodeSignature -LiteralPath $exe
} else { $null }
$hash = if ($signature) {
    (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
} else { $null }
$launcherHash = if (Test-Path -LiteralPath $launch -PathType Leaf) {
    (Get-FileHash -LiteralPath $launch -Algorithm SHA256).Hash
} else { $null }
$receipt = Join-Path $InstallPrefix 'config\install.json'
$receiptTask = if (Test-Path -LiteralPath $receipt) {
    try {
        [string](Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json).scheduled_task
    } catch { 'invalid_install_receipt' }
} else { $null }
$argsFile = Join-Path $InstallPrefix 'config\agent-args.json'
$argumentFlags = @()
$relayConfigured = $false
$credentialFileConfigured = $false
if (Test-Path -LiteralPath $argsFile -PathType Leaf) {
    try {
        $tokens = @(Get-Content -LiteralPath $argsFile -Raw | ConvertFrom-Json)
        $argumentFlags = @($tokens | Where-Object {
            $_ -is [string] -and $_ -match '^--[a-z][-a-z]*$'
        } | Select-Object -Unique)
        $relayConfigured = $argumentFlags -contains '--relay-url'
        $credentialFileConfigured = $argumentFlags -contains '--device-credential-file'
    } catch {
        $argumentFlags = @('invalid_json')
    }
}
$processInventoryAvailable = $true
$agentProcesses = @()
$powershellProcesses = @()
try {
    # Do not output any Win32_Process.CommandLine or credential values.
    $p = @(Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { $_.Name -in @('tetherd.exe','powershell.exe','pwsh.exe') })
    $agentProcesses = @($p | Where-Object { $_.Name -eq 'tetherd.exe' } |
        ForEach-Object { [ordered]@{
            pid = [int]$_.ProcessId
            executablePath = [string]$_.ExecutablePath
        } })
    $powershellProcesses = @($p |
        Where-Object { $_.Name -in @('powershell.exe','pwsh.exe') } |
        ForEach-Object {
            $cmdline = [string]$_.CommandLine
            $owningTasks = @($tasks | Where-Object {
                $scriptPath = [string]$_.launcherPath
                $scriptPath -and $cmdline.IndexOf(
                    $scriptPath, [StringComparison]::OrdinalIgnoreCase
                ) -ge 0
            } | ForEach-Object { $_.name })
            [ordered]@{
                pid = [int]$_.ProcessId
                parentPid = [int]$_.ParentProcessId
                matchingTetherplaneTaskNames = $owningTasks
                cmdMentionsTetherplane = [bool](
                    $cmdline -match '(?i:tetherplane|tethrd)')
                # A process alone cannot establish a visible terminal.
                visibleWindowVerified = $false
            }
        })
} catch { $processInventoryAvailable = $false }
[ordered]@{
    schema = 1
    mode = 'audit_only'
    machine = $env:COMPUTERNAME
    installedAgentPath = $exe
    installedAgentSha256 = $hash
    signatureStatus = if ($signature) { [string]$signature.Status } else { 'missing' }
    signerThumbprint = if ($signature -and $signature.SignerCertificate) {
        [string]$signature.SignerCertificate.Thumbprint
    } else { $null }
    installedLauncherSha256 = $launcherHash
    installerReceiptTask = $receiptTask
    configuredArgumentFlags = $argumentFlags
    relayFlagPresent = $relayConfigured
    credentialFileFlagPresent = $credentialFileConfigured
    tasks = $tasks
    processInventoryAvailable = $processInventoryAvailable
    tetherdProcesses = $agentProcesses
    powershellProcesses = $powershellProcesses
    summary = 'No task changes; no credentials or command line values disclosed.'
} | ConvertTo-Json -Depth 7
