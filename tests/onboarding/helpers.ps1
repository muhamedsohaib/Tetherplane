function New-TestPackage($tempRoot) {
    $pkg = Join-Path $tempRoot "pkg"
    New-Item -ItemType Directory -Force -Path (Join-Path $pkg "bin"),(Join-Path $pkg "launch") | Out-Null
    Set-Content -LiteralPath (Join-Path $pkg "bin\tetherd.exe") -Value "fake-binary" -Encoding Ascii -NoNewline
    Set-Content -LiteralPath (Join-Path $pkg "launch\tetherplane-agent.ps1") -Value "fake-supervisor" -Encoding Ascii -NoNewline
    Set-Content -LiteralPath (Join-Path $pkg "setup-windows-device.ps1") -Value "x" -Encoding Ascii -NoNewline
    Set-Content -LiteralPath (Join-Path $pkg "pair-windows-device.ps1") -Value "x" -Encoding Ascii -NoNewline
    Set-Content -LiteralPath (Join-Path $pkg "doctor-tetherplane.ps1") -Value "x" -Encoding Ascii -NoNewline
    Set-Content -LiteralPath (Join-Path $pkg "connection-profile.json") -Value "{}" -Encoding Ascii -NoNewline
    @{ name = "Tetherplane"; version = "0.1.0"; source_commit = "test"; platform = "windows"; architecture = "x64"; node_runtime_required = $false; default_mcp_tools = @("device","files","process","browser","desktop","batch") } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $pkg "manifest.json") -Encoding UTF8
    Write-TestSha256 $pkg
    return $pkg
}

function Write-TestSha256($pkg) {
    $lines = @()
    foreach ($rel in @("bin\tetherd.exe", "launch\tetherplane-agent.ps1", "manifest.json", "setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1", "connection-profile.json")) {
        $hash = (Get-FileHash -LiteralPath (Join-Path $pkg $rel) -Algorithm SHA256).Hash.ToLowerInvariant()
        $lines += "$hash  $($rel -replace '\\', '/')"
    }
    Set-Content -LiteralPath (Join-Path $pkg "manifest.sha256") -Value ($lines -join "`n") -Encoding Ascii
}

function Start-MockRelay($dir) {
    Set-Content -LiteralPath (Join-Path $dir "mode.txt") -Value "ok" -Encoding Ascii
    Remove-Item -LiteralPath (Join-Path $dir "stop.txt") -Force -ErrorAction SilentlyContinue
    $port = 0
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        $candidate = 18700 + (Get-Random -Minimum 0 -Maximum 500)
        $trial = New-Object System.Net.HttpListener
        $trial.Prefixes.Add("http://127.0.0.1:$candidate/")
        try { $trial.Start(); $trial.Stop(); $trial.Close(); $port = $candidate; break } catch { }
    }
    if ($port -eq 0) { throw "no free loopback port for mock relay" }
    $job = Start-Job -ScriptBlock {
        param($rootDir, $port)
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://127.0.0.1:$port/")
        $listener.Start()
        Set-Content -LiteralPath (Join-Path $rootDir "ready.txt") -Value "up" -Encoding Ascii
        $async = $null
        try {
            while ($listener.IsListening) {
                if (Test-Path -LiteralPath (Join-Path $rootDir "stop.txt")) { break }
                if ($null -eq $async) { $async = $listener.BeginGetContext($null, $null) }
                if (-not $async.AsyncWaitHandle.WaitOne(250)) { continue }
                try {
                    $ctx = $listener.EndGetContext($async)
                } finally {
                    $async = $null
                }
                try {
                    $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream)
                    $body = $reader.ReadToEnd()
                    $reader.Close()
                    $mode = (Get-Content -LiteralPath (Join-Path $rootDir "mode.txt") -Raw).Trim()
                    $code = 200
                    if ($ctx.Request.Url.AbsolutePath -eq "/pair/start" -and $ctx.Request.HttpMethod -eq "POST") {
                        Add-Content -LiteralPath (Join-Path $rootDir "requests.log") -Value $body -Encoding UTF8
                        if ($mode -eq "expired") { $code = 410; $out = '{"error":{"code":"expired","message":"pairing code expired"}}' }
                        elseif ($mode -eq "paired") { $code = 409; $out = '{"error":{"code":"conflict","message":"device is already paired"}}' }
                        else { $out = '{"userCode":"ABCD-1234","expiresAt":"2099-01-01T00:00:00Z"}' }
                    } elseif ($ctx.Request.Url.AbsolutePath -eq "/devices" -and $ctx.Request.HttpMethod -eq "GET") {
                        if ($ctx.Request.Headers["Authorization"] -eq "Bearer owner-token") { $code = 200; $out = '{"devices":[{"deviceId":"TESTPC01"}]}' }
                        else { $code = 401; $out = '{"error":"unauthorized"}' }
                    } else { $code = 404; $out = '{"error":"not_found"}' }
                    $bytes = [Text.Encoding]::UTF8.GetBytes($out)
                    $ctx.Response.StatusCode = $code
                    $ctx.Response.ContentType = "application/json"
                    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                    $ctx.Response.Close()
                } catch { }
            }
        } finally {
            try { $listener.Stop() } catch { }
            try { $listener.Close() } catch { }
        }
    } -ArgumentList $dir, $port
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ((Test-Path -LiteralPath (Join-Path $dir "ready.txt"))) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-Path -LiteralPath (Join-Path $dir "ready.txt"))) {
        try { Stop-Job $job -ErrorAction SilentlyContinue } catch { }
        try { Remove-Job $job -Force -ErrorAction SilentlyContinue } catch { }
        throw "mock relay did not become ready"
    }
    return [pscustomobject]@{ Url = "http://127.0.0.1:$port"; Job = $job; Dir = $dir }
}

function Stop-MockRelay($mock) {
    if ($null -eq $mock) { return }
    try { Set-Content -LiteralPath (Join-Path $mock.Dir "stop.txt") -Value "stop" -Encoding Ascii -ErrorAction SilentlyContinue } catch { }
    try { Stop-Job $mock.Job -ErrorAction SilentlyContinue } catch { }
    $stopped = Wait-Job $mock.Job -Timeout 5 -ErrorAction SilentlyContinue
    if (-not $stopped) { try { Stop-Job $mock.Job -Force -ErrorAction SilentlyContinue } catch { } }
    try { Remove-Job $mock.Job -Force -ErrorAction SilentlyContinue } catch { }
}
