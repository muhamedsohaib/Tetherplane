# Tetherplane readiness doctor (Windows, read-only)
#
# Every check returns an ordered result with ok/next and never prints
# credentials, tokens, or bearer values. Checks that cannot be performed
# without owner authorization are reported skipped/unverified, never ok.
# Dot-source to use the Test-* functions, or run with -Run for a report.
param(
    [switch]$Run,
    [string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"),
    [string]$StateDir = "",
    [string]$ConnectionProfile = "",
    [string]$RelayHost = "",
    [int]$RelayPort = 0,
    [string]$TaskName = "Tetherplane Agent",
    [string]$BearerTokenFile = ""
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

function Test-DeviceInstall {
    param([string]$InstallPrefix = (Join-Path $env:LOCALAPPDATA "Programs\Tetherplane"))
    foreach ($required in @("bin\tetherd.exe", "manifest.json")) {
        if (-not (Test-Path -LiteralPath (Join-Path $InstallPrefix $required))) {
            return [ordered]@{ check = "install"; ok = $false; next = "install the Windows package with setup-windows-device.ps1 -PackagePath <package>" }
        }
    }
    return [ordered]@{ check = "install"; ok = $true; next = "" }
}

function Test-ConnectionProfile {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $profile = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if ([string]$profile.mcp_url -notmatch "^https://" -or [string]$profile.oidc_issuer -notmatch "^https://") {
            return [ordered]@{ check = "profile"; ok = $false; next = "repair connection-profile.json: public HTTPS endpoints are required" }
        }
    } catch {
        return [ordered]@{ check = "profile"; ok = $false; next = "repair connection-profile.json: $($_.Exception.Message)" }
    }
    return [ordered]@{ check = "profile"; ok = $true; next = "" }
}

function Test-PublicRelay {
    param([Parameter(Mandatory = $true)][string]$McpUrl)
    try {
        $meta = Invoke-RestMethod -Uri ($McpUrl.TrimEnd("/") -replace "/mcp$", "/.well-known/oauth-protected-resource/mcp") -TimeoutSec 15
        if ($meta.resource -ne $McpUrl) {
            return [ordered]@{ check = "public"; ok = $false; next = "relay metadata points elsewhere; verify the MCP URL before continuing" }
        }
    } catch {
        return [ordered]@{ check = "public"; ok = $false; next = "relay is unreachable over public HTTPS; check network/proxy, do not reinstall yet" }
    }
    return [ordered]@{ check = "public"; ok = $true; next = "" }
}

function Test-AnonymousTools {
    param([Parameter(Mandatory = $true)][string]$McpUrl)
    try {
        $base = $McpUrl.TrimEnd("/")
        $init = Invoke-WebRequest -Uri $base -Method POST -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream"; "MCP-Protocol-Version" = "2025-06-18" } -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"doctor","version":"1.0"}}}' -UseBasicParsing -TimeoutSec 20
        $session = $init.Headers["Mcp-Session-Id"]
        if (-not $session) {
            return [ordered]@{ check = "tools"; ok = $false; next = "relay did not open an anonymous discovery session; verify relay health before continuing" }
        }
        Invoke-WebRequest -Uri $base -Method POST -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream"; "MCP-Protocol-Version" = "2025-06-18"; "MCP-Session-Id" = $session } -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' -UseBasicParsing -TimeoutSec 20 | Out-Null
        $tools = Invoke-RestMethod -Uri $base -Method POST -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream"; "MCP-Protocol-Version" = "2025-06-18"; "MCP-Session-Id" = $session } -Body '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' -TimeoutSec 20
        $names = @($tools.result.tools | ForEach-Object { $_.name } | Sort-Object)
        $expected = @("batch", "browser", "desktop", "device", "files", "process")
        $toolDiff = @(Compare-Object $names $expected)
        if ($toolDiff.Count -ne 0) {
            return [ordered]@{ check = "tools"; ok = $false; next = "tool surface differs from the canonical six tools; verify the relay revision, do not reinstall blindly" }
        }
    } catch {
        return [ordered]@{ check = "tools"; ok = $false; next = "anonymous tool discovery failed; verify relay health before continuing" }
    }
    return [ordered]@{ check = "tools"; ok = $true; next = "" }
}

function Test-DeviceIdentity {
    param([Parameter(Mandatory = $true)][string]$StateDir)
    $idPath = Join-Path $StateDir "device-id.txt"
    $credentialPath = Join-Path $StateDir "device.credential"
    if (-not (Test-Path -LiteralPath $idPath -PathType Leaf) -or -not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
        return [ordered]@{ check = "identity"; ok = $false; next = "device identity is missing; run setup-windows-device.ps1 first (never copy another computer's credential)" }
    }
    return [ordered]@{ check = "identity"; ok = $true; next = "" }
}

function Test-AgentTask {
    param([string]$TaskName = "Tetherplane Agent")
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        return [ordered]@{ check = "agent-task"; ok = $false; next = "background agent task '$TaskName' is missing; finalize setup to create it, then re-run doctor" }
    }
    return [ordered]@{ check = "agent-task"; ok = $true; next = "" }
}

function Get-AgentProcesses {
    param([string]$InstallPrefix)
    $all = @(Get-Process tetherd -ErrorAction SilentlyContinue)
    if (-not $InstallPrefix) { return $all }
    return @($all | Where-Object {
        try { $_.Path -like ("*" + $InstallPrefix + "*") } catch { $false }
    })
}

function Test-DeviceOnline {
    param(
        [Parameter(Mandatory = $true)][string]$InstallPrefix,
        [Parameter(Mandatory = $true)][string]$RelayHost,
        [Parameter(Mandatory = $true)][int]$RelayPort,
        $ProcessList = $null,
        $ConnectionList = $null
    )
    $agents = @()
    if ($null -ne $ProcessList) { $agents = @($ProcessList) } else { $agents = Get-AgentProcesses -InstallPrefix $InstallPrefix }
    if ($agents.Count -eq 0) {
        return [ordered]@{ check = "online"; ok = $false; next = "managed agent is not running; start it (scheduled task or supervisor), then re-run doctor" }
    }
    $addresses = @($RelayHost)
    try { $addresses += @([Net.Dns]::GetHostAddresses($RelayHost) | ForEach-Object { $_.ToString() }) } catch { }
    $conns = @()
    if ($null -ne $ConnectionList) { $conns = @($ConnectionList) } else { $conns = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue) }
    foreach ($agent in $agents) {
        $link = $conns | Where-Object { $_.OwningProcess -eq $agent.Id -and $addresses -contains $_.RemoteAddress -and $_.RemotePort -eq $RelayPort } | Select-Object -First 1
        if ($link) {
            return [ordered]@{ check = "online"; ok = $true; transport = "tcp-established"; remote_functional = "unverified"; next = "local transport is up; remote functional status needs an owner account check" }
        }
    }
    return [ordered]@{ check = "online"; ok = $false; next = "agent runs but has no relay connection; check pairing approval and relay reachability" }
}

function Test-LocalPolicy {
    param([Parameter(Mandatory = $true)][string]$InstallPrefix)
    $argsPath = Join-Path $InstallPrefix "config\agent-args.json"
    if (-not (Test-Path -LiteralPath $argsPath -PathType Leaf)) {
        return [ordered]@{ check = "policy"; ok = $false; next = "launch arguments are missing; finalize setup to write them, then re-run doctor" }
    }
    try { $args = Get-Content -LiteralPath $argsPath -Raw | ConvertFrom-Json } catch {
        return [ordered]@{ check = "policy"; ok = $false; next = "launch arguments are unreadable; finalize setup again to rewrite them" }
    }
    $profileIndex = -1
    for ($i = 0; $i -lt $args.Count; $i++) {
        if ([string]$args[$i] -eq "--principal-profile" -and ($i + 1) -lt $args.Count) { $profileIndex = $i + 1 }
    }
    if ($profileIndex -lt 0) {
        return [ordered]@{ check = "policy"; ok = $false; next = "no launch-bound principal is configured; finalize setup to write the least-privilege principal" }
    }
    $principalPath = [string]$args[$profileIndex]
    if (-not (Test-Path -LiteralPath $principalPath -PathType Leaf)) {
        return [ordered]@{ check = "policy"; ok = $false; next = "launch-bound principal file is missing; restore it from backup (do not widen policy)" }
    }
    return [ordered]@{ check = "policy"; ok = $true; next = "" }
}

function Test-AccountPairing {
    param([Parameter(Mandatory = $true)][string]$RelayUrl, [string]$BearerTokenFile = "")
    if ([string]::IsNullOrWhiteSpace($BearerTokenFile) -or -not (Test-Path -LiteralPath $BearerTokenFile -PathType Leaf)) {
        return [ordered]@{ check = "account"; ok = $false; skipped = $true; next = "unverified from this computer: owner check required. Ask the connected ChatGPT plugin to approve the pending code, or to run device(op=""status"", device=""<this device ID>"")" }
    }
    try {
        $bearer = (Get-Content -LiteralPath $BearerTokenFile -Raw).Trim()
        if (-not $bearer) { throw "bearer file is empty" }
        $headers = @{ Authorization = ("Bearer " + $bearer) }
        $devices = Invoke-RestMethod -Uri ($RelayUrl.TrimEnd("/") + "/devices") -Headers $headers -TimeoutSec 15
        $paired = @($devices.devices).Count
    } catch {
        return [ordered]@{ check = "account"; ok = $false; skipped = $false; next = "account check failed; verify owner authorization and relay reachability" }
    }
    return [ordered]@{ check = "account"; ok = $true; skipped = $false; devices = $paired; next = "" }
}

function Get-RelayEndpoint {
    param([Parameter(Mandatory = $true)][string]$ProfilePath)
    $profile = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json
    $device = [Uri][string]$profile.device_transport.relay_url
    $mcp = [Uri][string]$profile.mcp_url
    return [ordered]@{
        host = $device.Host
        port = $device.Port
        pairing_origin = ("https://" + $mcp.Authority)
        mcp_url = [string]$profile.mcp_url
    }
}

function Test-RelayTransport {
    param(
        [Parameter(Mandatory = $true)][string]$RelayHost,
        [Parameter(Mandatory = $true)][int]$RelayPort,
        [int]$TimeoutMs = 5000
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect($RelayHost, $RelayPort, $null, $null)
        if ($pending.AsyncWaitHandle.WaitOne($TimeoutMs) -and $client.Connected) {
            return [ordered]@{ check = "relay-transport"; ok = $true; next = "" }
        }
    } catch {
    } finally {
        $client.Close()
    }
    return [ordered]@{ check = "relay-transport"; ok = $false; next = "this computer cannot reach the relay device endpoint ${RelayHost}:${RelayPort}; join the same Tailscale tailnet as the relay, then re-run doctor" }
}

function Test-BrowserProvider {
    return [ordered]@{ check = "browser"; ok = $false; skipped = $true; next = "unverified: the browser provider is optional; check it only if browser automation is needed" }
}

function Get-CheckStatus {
    param($Result)
    if ($Result.Contains("skipped") -and $Result.skipped) { return "unverified" }
    if ($Result.ok) { return "pass" }
    return "FAIL"
}

if ($MyInvocation.InvocationName -ne ".") {
    if (-not $StateDir) { $StateDir = Join-Path $env:LOCALAPPDATA "Tetherplane\device-state" }
    if (-not $ConnectionProfile) {
        foreach ($candidate in @((Join-Path $PSScriptRoot "connection-profile.json"), (Join-Path $PSScriptRoot "..\docs\remote\connection-profile.json"))) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $ConnectionProfile = (Resolve-Path -LiteralPath $candidate).Path; break }
        }
    }
    $results = @()
    $results += Test-DeviceInstall -InstallPrefix $InstallPrefix
    $results += Test-DeviceIdentity -StateDir $StateDir
    $endpoint = $null
    if ($ConnectionProfile) {
        $profileResult = Test-ConnectionProfile -Path $ConnectionProfile
        $results += $profileResult
        if ($profileResult.ok) { $endpoint = Get-RelayEndpoint -ProfilePath $ConnectionProfile }
    } else {
        $results += [ordered]@{ check = "profile"; ok = $false; next = "connection-profile.json was not found next to this script; run doctor from the unpacked device kit" }
    }
    $transportHost = $RelayHost
    $transportPort = $RelayPort
    if ($endpoint) {
        if (-not $transportHost) { $transportHost = $endpoint.host }
        if (-not $transportPort) { $transportPort = $endpoint.port }
        $results += Test-PublicRelay -McpUrl $endpoint.mcp_url
        $results += Test-AnonymousTools -McpUrl $endpoint.mcp_url
    }
    if ($transportHost -and $transportPort) { $results += Test-RelayTransport -RelayHost $transportHost -RelayPort $transportPort }
    $results += Test-AgentTask -TaskName $TaskName
    if ($transportHost -and $transportPort) { $results += Test-DeviceOnline -InstallPrefix $InstallPrefix -RelayHost $transportHost -RelayPort $transportPort }
    $results += Test-LocalPolicy -InstallPrefix $InstallPrefix
    $pairingOrigin = ""
    if ($endpoint) { $pairingOrigin = $endpoint.pairing_origin }
    $results += Test-AccountPairing -RelayUrl $pairingOrigin -BearerTokenFile $BearerTokenFile
    $results += Test-BrowserProvider
    $results | ForEach-Object { [pscustomobject]@{ check = $_.check; status = (Get-CheckStatus $_); next = $_.next } } | Format-Table -AutoSize -Wrap | Out-String | Write-Output
    $failed = @($results | Where-Object { -not $_.ok -and -not ($_.Contains("skipped") -and $_.skipped) })
    if ($failed.Count -gt 0) {
        Write-Output ("NEXT ACTION: " + $failed[0].next)
        exit 1
    }
    Write-Output "No failing checks. Items marked unverified need an owner check; ask the connected ChatGPT plugin to run device(op=""status"", device=""<this device ID>"")."
}
