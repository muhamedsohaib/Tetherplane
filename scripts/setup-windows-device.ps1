# Tetherplane device setup entrypoint (Windows, per-user, managed install)
#
# End-to-end flow on a NEW controlled computer:
#   verify package -> managed install -> local identity -> pair (explicit) ->
#   owner approval via the connected ChatGPT plugin -> finalize agent task.
#
# New installs receive an explicit least-privilege launch-bound principal
# (device.status acceptance only). Existing principals are never rewritten.
# resolved by the caller.
param(
    [switch]$Run,
    [string]$PackagePath = "",
    [string]$DeviceId = "",
    [string]$InstallPrefix = "",
    [string]$StateDir = "",
    [string]$RelayUrl = "wss://vaulter.tailf65eba.ts.net:10000/device",
    [string]$PairingOrigin = "https://vaulter.tailf65eba.ts.net",
    [switch]$Pair,
    [switch]$Finalize
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 can inherit a PowerShell 7 PSModulePath (for example
# when launched from a pwsh terminal) and then autoload incompatible core
# modules. Repin to Windows PowerShell's own module directories for this
# process only when a foreign-version core module would be resolved.
if ($PSVersionTable.PSEdition -eq "Desktop") {
    $coreModuleNames = @("Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Management", "Microsoft.PowerShell.Security")
    $foreignCore = @(Get-Module -ListAvailable -Name $coreModuleNames | Where-Object { $_.Version.Major -ne 3 })
    if ($foreignCore.Count -gt 0) {
        $env:PSModulePath = "$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\system32\WindowsPowerShell\v1.0\Modules"
        foreach ($coreName in $coreModuleNames) {
            $loaded = Get-Module -Name $coreName
            if ($loaded -and $loaded.Version.Major -ne 3) { Remove-Module -Name $coreName -Force -ErrorAction SilentlyContinue }
        }
        foreach ($coreName in $coreModuleNames) { Import-Module -Name $coreName -ErrorAction Stop }
    }
}

$ManagedFiles = @(
    "bin\tetherd.exe",
    "launch\tetherplane-agent.ps1",
    "manifest.json",
    "setup-windows-device.ps1",
    "pair-windows-device.ps1",
    "doctor-tetherplane.ps1",
    "connection-profile.json"
)

function Write-Utf8NoBomJson {
    param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$LiteralPath)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText(
        $LiteralPath,
        (($Value | ConvertTo-Json -Depth 6) + "`n"),
        $utf8NoBom
    )
}


function Assert-DevicePathNotRedirected {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $current = [IO.Path]::GetFullPath($LiteralPath)
    $root = [IO.Path]::GetPathRoot($current)
    while ($current) {
        $item = $null
        try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch [System.Management.Automation.ItemNotFoundException] { }
        if ($item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "refusing redirected device path (reparse point): $current"
        }
        if ($current -eq $root) { break }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-ManagedDeviceDestinations {
    param([Parameter(Mandatory = $true)][string]$InstallPrefix)
    Assert-DevicePathNotRedirected -LiteralPath $InstallPrefix
    Assert-DevicePathNotRedirected -LiteralPath (Join-Path $InstallPrefix "config\install.json")
    Assert-DevicePathNotRedirected -LiteralPath (Join-Path $InstallPrefix "config\agent-args.json")
    foreach ($file in $ManagedFiles) {
        Assert-DevicePathNotRedirected -LiteralPath (Join-Path $InstallPrefix $file)
    }
}

function Confirm-ManagedDeviceReceipt {
    param([Parameter(Mandatory = $true)][string]$InstallPrefix)
    $install = [IO.Path]::GetFullPath($InstallPrefix)
    $receiptPath = Join-Path $install "config\install.json"
    Assert-DevicePathNotRedirected -LiteralPath $receiptPath
    try {
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        if ([string]$receipt.managed_by -cne "setup-windows-device.ps1") { throw "foreign receipt" }
        $recorded = [IO.Path]::GetFullPath([string]$receipt.install_prefix).TrimEnd("\")
        if ($recorded -ine $install.TrimEnd("\")) { throw "receipt prefix mismatch" }
    } catch {
        throw "install receipt does not prove ownership of this prefix; refusing repair: $install"
    }
}

function Get-CurrentUserSid {
    return ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
}

function Confirm-DevicePackage {
    param([Parameter(Mandatory = $true)][string]$PackagePath)
    $package = [IO.Path]::GetFullPath($PackagePath)
    $manifestPath = Join-Path $package "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "package manifest is missing: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($field in @("name", "version", "platform", "architecture", "default_mcp_tools")) {
        if (-not $manifest.$field) { throw "package manifest is missing required field: $field" }
    }
    if (-not [string]$manifest.source_commit) {
        throw "package manifest is missing source commit evidence"
    }
    if ([string]$manifest.platform -ne "windows") {
        throw "package platform is $($manifest.platform); this setup supports windows packages only"
    }
    if ([string]$manifest.architecture -ne "x64") {
        throw "package architecture is $($manifest.architecture); this computer requires an x64 package"
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw "this computer is not running a 64-bit OS; refusing an x64 package"
    }
    $expectedTools = @("batch", "browser", "desktop", "device", "files", "process")
    $actualTools = @($manifest.default_mcp_tools | Sort-Object)
    $toolDiff = @(Compare-Object $actualTools $expectedTools)
    if ($toolDiff.Count -ne 0) {
        throw "package default tool surface differs from the canonical six tools"
    }
    $hashPath = Join-Path $package "manifest.sha256"
    if (-not (Test-Path -LiteralPath $hashPath -PathType Leaf)) {
        throw "package hash manifest is missing: manifest.sha256 is required"
    }
    $covered = @{}
    foreach ($line in (Get-Content -LiteralPath $hashPath)) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        $parts = $trimmed -split "\s+", 2
        if ($parts.Count -ne 2) { throw "package hash manifest is malformed" }
        $rel = $parts[1] -replace "/", "\"
        if ([IO.Path]::IsPathRooted($rel) -or $rel -match "(^|\\)\.\.(\\|$)" -or $rel -match "^[A-Za-z]:") {
            throw "package hash manifest rejects unsafe entry: $($parts[1])"
        }
        $target = Join-Path $package $rel
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "package hash manifest lists a missing file: $($parts[1])"
        }
        $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $parts[0].ToLowerInvariant()) {
            throw "package integrity failure: $($parts[1]) does not match its recorded SHA-256"
        }
        $covered[$rel] = $true
    }
    foreach ($required in $ManagedFiles) {
        if (-not $covered[$required]) {
            throw "package hash manifest does not cover required kit file: $required"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $package $required))) {
            throw "package is missing required artifact: $required"
        }
    }
    return [ordered]@{
        ok = $true
        name = [string]$manifest.name
        version = [string]$manifest.version
        source_commit = [string]$manifest.source_commit
    }
}

function Install-ManagedDeviceFiles {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$InstallPrefix
    )
    $package = [IO.Path]::GetFullPath($PackagePath)
    $install = [IO.Path]::GetFullPath($InstallPrefix)
    Assert-ManagedDeviceDestinations -InstallPrefix $install
    Confirm-DevicePackage -PackagePath $package | Out-Null
    $receiptPath = Join-Path $install "config\install.json"
    if ((Test-Path -LiteralPath $install)) {
        $existing = @(Get-ChildItem -LiteralPath $install -Force -ErrorAction SilentlyContinue)
        $managed = (Test-Path -LiteralPath $receiptPath -PathType Leaf)
        if ($existing.Count -gt 0 -and -not $managed) {
            throw "install prefix holds files this setup did not install; refusing to touch an unmanaged prefix: $install"
        }
        if ($existing.Count -gt 0 -and $managed) {
            Confirm-ManagedDeviceReceipt -InstallPrefix $install
            Repair-ManagedDeviceFiles -PackagePath $package -InstallPrefix $install
            return [ordered]@{ ok = $true; repaired = $true; install_prefix = $install }
        }
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $install "bin"),(Join-Path $install "launch"),(Join-Path $install "config") | Out-Null
    foreach ($file in $ManagedFiles) {
        $source = Join-Path $package $file
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $destination = Join-Path $install $file
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
    $tetherd = Join-Path $install "bin\tetherd.exe"
    if (-not (Test-Path -LiteralPath $tetherd -PathType Leaf)) {
        throw "managed install failed: agent binary is missing after copy"
    }
    Write-InstallReceipt -PackagePath $package -InstallPrefix $install
    return [ordered]@{ ok = $true; repaired = $false; install_prefix = $install }
}

function Repair-ManagedDeviceFiles {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$InstallPrefix
    )
    $package = [IO.Path]::GetFullPath($PackagePath)
    $install = [IO.Path]::GetFullPath($InstallPrefix)
    Assert-ManagedDeviceDestinations -InstallPrefix $install
    Confirm-ManagedDeviceReceipt -InstallPrefix $install
    Confirm-DevicePackage -PackagePath $package | Out-Null
    foreach ($file in $ManagedFiles) {
        $source = Join-Path $package $file
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $destination = Join-Path $install $file
        $refresh = $true
        if ((Test-Path -LiteralPath $destination -PathType Leaf)) {
            $refresh = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
        } else {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        }
        if ($refresh) { Copy-Item -LiteralPath $source -Destination $destination -Force }
    }
    Write-InstallReceipt -PackagePath $package -InstallPrefix $install
}

function Write-InstallReceipt {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$InstallPrefix
    )
    $tetherd = Join-Path ([IO.Path]::GetFullPath($InstallPrefix)) "bin\tetherd.exe"
    $receipt = [ordered]@{
        install_prefix = [IO.Path]::GetFullPath($InstallPrefix)
        managed_by = "setup-windows-device.ps1"
        source_commit = (Confirm-DevicePackage -PackagePath $PackagePath).source_commit
        tetherd_sha256 = (Get-FileHash -LiteralPath $tetherd -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Write-Utf8NoBomJson -Value $receipt -LiteralPath (Join-Path ([IO.Path]::GetFullPath($InstallPrefix)) "config\install.json")
}

function Protect-DeviceDirectory {
    param([Parameter(Mandatory = $true)][string]$StateDir)
    $sid = Get-CurrentUserSid
    icacls $StateDir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F" /grant:r "*S-1-5-32-544:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "failed to restrict directory $StateDir" }
    # /inheritance:r removes inherited grants; /grant:r does not remove an
    # explicit grant to another principal. Verify the directory before a
    # credential is ever created, rather than protecting only the final file.
    if (-not (Test-RestrictedCredentialFile -CredentialPath $StateDir)) {
        throw "device state directory has unexpected explicit access rules; refusing credential creation"
    }
}

function Test-RestrictedCredentialFile {
    param([Parameter(Mandatory = $true)][string]$CredentialPath)
    $acl = Get-Acl -LiteralPath $CredentialPath
    if (-not $acl.AreAccessRulesProtected) { return $false }
    $sids = @($acl.Access | ForEach-Object {
        try { ([Security.Principal.SecurityIdentifier]$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier])).Value } catch { "" }
    })
    $want = @((Get-CurrentUserSid); "S-1-5-18"; "S-1-5-32-544")
    if ($sids.Count -ne 3) { return $false }
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }
        $full = [Security.AccessControl.FileSystemRights]::FullControl
        if (($rule.FileSystemRights -band $full) -ne $full) { return $false }
    }
    foreach ($required in $want) {
        if ($sids -notcontains $required) { return $false }
    }
    return $true
}

function Install-DeviceIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$StateDir,
        [Parameter(Mandatory = $true)][string]$DeviceId
    )
    if ($DeviceId -notmatch "^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$") {
        throw "device ID must start alphanumeric and contain only letters, digits, dash or underscore (max 63 chars)"
    }
    $state = [IO.Path]::GetFullPath($StateDir)
    Assert-DevicePathNotRedirected -LiteralPath $state
    foreach ($leaf in @("device-id.txt", "device.credential", "principal.json", "agent")) {
        Assert-DevicePathNotRedirected -LiteralPath (Join-Path $state $leaf)
    }
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    try {
        Protect-DeviceDirectory -StateDir $state
    } catch {
        throw "failed to restrict the device state directory; refusing to write a credential into an unprotected directory"
    }
    $idPath = Join-Path $state "device-id.txt"
    $credentialPath = Join-Path $state "device.credential"
    if ((Test-Path -LiteralPath $idPath -PathType Leaf)) {
        $existing = (Get-Content -LiteralPath $idPath -Raw).Trim()
        if ($existing -cne $DeviceId) {
            throw "conflicting device identity: state already belongs to '$existing'. Re-run with the same device ID to repair, or revoke and re-pair explicitly; identity is never overwritten."
        }
        if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
            throw "device identity exists but its credential file is missing; restore device.credential from backup or revoke and re-pair explicitly."
        }
        $credential = (Get-Content -LiteralPath $credentialPath -Raw).Trim()
        if ($credential.Length -lt 16 -or $credential -match "[\r\n]") {
            throw "stored device credential is malformed; restore device.credential from backup or revoke and re-pair explicitly."
        }
        if (-not (Test-RestrictedCredentialFile -CredentialPath $credentialPath)) {
            throw "stored credential file ACL is not restricted to this user, SYSTEM and Administrators; repair permissions or restore from backup before continuing."
        }
        return [ordered]@{ ok = $true; reused = $true; device_id = $existing }
    }
    if ((Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
        throw "a device credential exists without a device identity; remove the orphaned device.credential or restore device-id.txt before continuing."
    }
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $credential = ([Convert]::ToBase64String($bytes)).Replace("+", "-").Replace("/", "_").TrimEnd("=")
    Set-Content -LiteralPath $credentialPath -Value $credential -Encoding Ascii -NoNewline
    $sid = Get-CurrentUserSid
    icacls $credentialPath /inheritance:r /grant:r "*${sid}:F" /grant:r "*S-1-5-18:F" /grant:r "*S-1-5-32-544:F" | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-RestrictedCredentialFile -CredentialPath $credentialPath)) {
        Remove-Item -LiteralPath $credentialPath -Force -ErrorAction SilentlyContinue
        throw "failed to restrict the credential file; the generated secret was discarded and nothing was kept"
    }
    Set-Content -LiteralPath $idPath -Value $DeviceId -Encoding Ascii -NoNewline
    return [ordered]@{ ok = $true; reused = $false; device_id = $DeviceId }
}

function Get-ApprovalInstruction {
    param([Parameter(Mandatory = $true)][string]$DeviceId, [Parameter(Mandatory = $true)][string]$UserCode)
    return (@(
        "Ask the already connected ChatGPT plugin to approve this pairing:",
        "device(op=""approve_pairing"", args={userCode:""$UserCode"", expectedDeviceId:""$DeviceId""})",
        "No token export or extra client is needed; approval binds to the authenticated ChatGPT account."
    ) -join "`n")
}

function Install-DeviceAgentTask {
    param(
        [Parameter(Mandatory = $true)][string]$InstallPrefix,
        [Parameter(Mandatory = $true)][string]$StateDir,
        [Parameter(Mandatory = $true)][string]$DeviceId,
        [Parameter(Mandatory = $true)][string]$RelayUrl,
        [string]$TaskName = "Tetherplane Agent"
    )
    $install = [IO.Path]::GetFullPath($InstallPrefix)
    $state = [IO.Path]::GetFullPath($StateDir)
    Assert-ManagedDeviceDestinations -InstallPrefix $install
    Assert-DevicePathNotRedirected -LiteralPath $state
    foreach ($leaf in @("device.credential", "principal.json", "agent")) {
        Assert-DevicePathNotRedirected -LiteralPath (Join-Path $state $leaf)
    }
    $tetherd = Join-Path $install "bin\tetherd.exe"
    $supervisor = Join-Path $install "launch\tetherplane-agent.ps1"
    $credentialFile = Join-Path $state "device.credential"
    foreach ($required in @($tetherd, $supervisor, $credentialFile)) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "finalize requires an installed agent and device identity; missing: $required"
        }
    }
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        $owner = [string]$existingTask.Principal.UserId
        $ownerNames = @((Get-CurrentUserSid), ([Security.Principal.WindowsIdentity]::GetCurrent()).Name, $env:USERNAME)
        $managed = $false
        try {
            $current = ((Get-ScheduledTask -TaskName $TaskName).Actions[0].Arguments)
            if ($current -match [regex]::Escape($install)) { $managed = $true }
        } catch { }
        if (-not $managed -or ($owner -and ($ownerNames -notcontains $owner))) {
            throw "scheduled task '$TaskName' already exists and is not this install's per-user task; refusing to replace or duplicate it"
        }
        $running = (Get-ScheduledTask -TaskName $TaskName).State -eq "Running"
        return [ordered]@{ ok = $true; reused = $true; task = $TaskName; started = $running; start_pending = (-not $running); principal_kept = $true }
    }
    $principalPath = Join-Path $state "principal.json"
    $principalKept = $false
    if (-not (Test-Path -LiteralPath $principalPath -PathType Leaf)) {
        [ordered]@{
            principal_id = "human:owner"
            authentication = "local_process_binding"
            allowed_devices = @($DeviceId)
            allowed_directories = @()
            allowed_capabilities = @("device.status")
        } | ConvertTo-Json -Depth 4 | ForEach-Object {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [IO.File]::WriteAllText($principalPath, ($_ + "`n"), $utf8NoBom)
        }
    } else {
        $principalKept = $true
    }
    $agentArgs = @(
        "--relay-url", $RelayUrl,
        "--device-id", $DeviceId,
        "--device-credential-file", $credentialFile,
        "--allow", $state,
        "--principal-profile", $principalPath,
        "--state-dir", (Join-Path $state "agent")
    )
    $agentArgs | ConvertTo-Json -Depth 4 | ForEach-Object {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText((Join-Path $install "config\agent-args.json"), ($_ + "`n"), $utf8NoBom)
    }
    try {
        $currentUser = ([Security.Principal.WindowsIdentity]::GetCurrent()).Name
        $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $install "launch\tetherplane-agent.ps1") + '"')
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
        $taskPrincipal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
        $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $taskSettings | Out-Null
    } catch {
        throw "scheduled task registration failed or raced with another registration; re-run to adopt the existing task instead of duplicating it ($($_.Exception.Message))"
    }
    $started = $false
    $pending = ""
    try {
        Start-ScheduledTask -TaskName $TaskName | Out-Null
        $started = $true
    } catch {
        $pending = "task registered but did not start now; it starts at next logon or run Start-ScheduledTask '$TaskName' manually"
    }
    return [ordered]@{ ok = $true; reused = $false; task = $TaskName; started = $started; start_pending = $pending; principal_kept = $principalKept; agent_args = $agentArgs }
}

if ($MyInvocation.InvocationName -ne ".") {
    if (-not $PackagePath) {
        if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) {
            $PackagePath = $PSScriptRoot
        } else {
            throw "-PackagePath is required when this script is not run from an unpacked device kit"
        }
    }
    if (-not $DeviceId) { $DeviceId = $env:COMPUTERNAME }
    if (-not $InstallPrefix) { $InstallPrefix = Join-Path $env:LOCALAPPDATA "Programs\Tetherplane" }
    if (-not $StateDir) { $StateDir = Join-Path $env:LOCALAPPDATA "Tetherplane\device-state" }
    $manifest = Confirm-DevicePackage -PackagePath $PackagePath
    $install = Install-ManagedDeviceFiles -PackagePath $PackagePath -InstallPrefix $InstallPrefix
    $identity = Install-DeviceIdentity -StateDir $StateDir -DeviceId $DeviceId
    $result = [ordered]@{ ok = $true; package = $manifest; install = $install; identity = $identity }
    if ($Pair) {
        $pairScript = Join-Path $PSScriptRoot "pair-windows-device.ps1"
        $pairing = & $pairScript -Run -RelayUrl $PairingOrigin -DeviceId $identity.device_id -StateDir ([IO.Path]::GetFullPath($StateDir))
        $result["pairing"] = $pairing
        $result["approval_instruction"] = Get-ApprovalInstruction -DeviceId $identity.device_id -UserCode $pairing.userCode
    }
    if ($Finalize) {
        $task = Install-DeviceAgentTask -InstallPrefix $install.install_prefix -StateDir ([IO.Path]::GetFullPath($StateDir)) -DeviceId $identity.device_id -RelayUrl $RelayUrl
        $result["agent_task"] = $task
    }
    $result | ConvertTo-Json -Depth 5 | Write-Output
}
