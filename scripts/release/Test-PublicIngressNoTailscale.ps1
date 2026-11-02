# Read-only Windows 11 guest check. Never runs on host as a substitute for guest acceptance.
# No authentication, VM mutations, registry changes, DNS writes or firewall changes.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]{2,252}$')]
    [string]$HostName,
    [switch]$DescribeOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-GloballyRoutableIp {
    param([Parameter(Mandatory=$true)][System.Net.IPAddress]$IP)
    $bytes = $IP.GetAddressBytes()
    if ($IP.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        $a = [int]$bytes[0]; $b = [int]$bytes[1]
        return !($a -eq 0 -or $a -eq 10 -or $a -eq 127 -or
            $a -ge 224 -or $a -eq 192 -and $b -eq 168 -or
            $a -eq 169 -and $b -eq 254 -or
            $a -eq 172 -and $b -ge 16 -and $b -le 31 -or
            $a -eq 100 -and $b -ge 64 -and $b -le 127 -or
            $a -eq 192 -and ($b -eq 0 -or $b -eq 88 -and $bytes[2] -eq 99) -or
            $a -eq 198 -and ($b -eq 18 -or $b -eq 19) -or
            $a -eq 198 -and $b -eq 51 -and $bytes[2] -eq 100 -or
            $a -eq 203 -and $b -eq 0 -and $bytes[2] -eq 113)
    }
    if ($IP.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        return !($IP.IsIPv6LinkLocal -or $IP.IsIPv6SiteLocal -or $IP.IsIPv6Multicast -or
            $IP.Equals([Net.IPAddress]::IPv6Loopback) -or
            $IP.Equals([Net.IPAddress]::IPv6None) -or
            (($bytes[0] -band 0xfe) -eq 0xfc) -or
            (($bytes[0] -band 0xe0) -ne 0x20) -or
            ($bytes[0] -eq 0x20 -and $bytes[1] -eq 0x01 -and
              $bytes[2] -eq 0x0d -and $bytes[3] -eq 0xb8))
    }
    return $false
}

$parsedIp = $null
if ($HostName.EndsWith('.ts.net', [System.StringComparison]::OrdinalIgnoreCase) -or
    $HostName -match '(?i)(^|\.)localhost$' -or
    [System.Net.IPAddress]::TryParse($HostName, [ref]$parsedIp)) {
    throw 'A distinct public DNS hostname is required; Tailscale Funnel and IP-literal addresses are not valid for this canary.'
}

if ($DescribeOnly) {
    Write-Output 'READ_ONLY_GUEST_PUBLIC_INGRESS_PROBE=True'
    Write-Output 'REQUIRES_WINDOWS_11_GUEST_WITHOUT_TAILSCALE=True'
    Write-Output 'DOES_NOT_TEST_PAIRING_OR_OAUTH=True'
    exit 0
}

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
if ([int]$os.BuildNumber -lt 22000) {
    throw 'This proof requires a supported clean Windows 11 guest, not the Surface Windows 10 host.'
}
if (Get-Service -Name Tailscale -ErrorAction SilentlyContinue) {
    throw 'Tailscale service exists in the guest; the no-client baseline failed.'
}
if (Get-Process -Name tailscale,tailscaled,tailscale-ipn -ErrorAction SilentlyContinue) {
    throw 'A Tailscale process is present inside the guest.'
}
if (Get-Command tailscale.exe -ErrorAction SilentlyContinue) {
    throw 'A Tailscale client is present on the guest PATH.'
}

$answers = @([System.Net.Dns]::GetHostAddresses($HostName))
if ($answers.Count -eq 0) { throw 'No DNS answers for the canary host.' }
foreach ($ip in $answers) {
    if (-not (Test-GloballyRoutableIp $ip)) {
        throw 'Nonpublic IP address returned; verify guest DNS and host routing.'
    }
}
$uri = 'https://' + $HostName + '/healthz'
$response = & curl.exe --noproxy '*' --silent --show-error --max-time 10 --output NUL --write-out '%{http_code}' $uri 2>&1
$code = $LASTEXITCODE
if ($code -ne 0 -or ($response | Select-Object -Last 1) -cne '200') {
    throw ('Public HTTPS health check failed; curl exit=' + $code)
}

# A 200 health probe is only TLS/ingress evidence. Do not claim authenticated
# MCP, cross-account isolation, browser authorization or WebSocket acceptance.
Write-Output ('TEST_UTC=' + [DateTime]::UtcNow.ToString('o'))
Write-Output ('GUEST_HOST=' + $env:COMPUTERNAME)
Write-Output ('PUBLIC_DNS_ANSWER_COUNT=' + $answers.Count)
Write-Output 'GUEST_TAILSCALE_CLIENT_ABSENT=True'
Write-Output 'PUBLIC_TLS_HEALTH_200=True'
Write-Output 'AUTHENTICATED_DEVICE_PAIRING_NOT_TESTED=True'
