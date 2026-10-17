$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "helpers.ps1")

function New-RpcLine($requestId, $capability, $arguments) {
    return (@{
        protocol_version = "1.0"
        request_id = $requestId
        device_id = "TESTPC01"
        capability = $capability
        arguments = $arguments
        actor = @{ id = "test"; kind = "ai_client" }
        session_id = $null
        response_mode = "compact"
        idempotency_key = $null
        preconditions = @()
        expectations = @()
    } | ConvertTo-Json -Depth 6 -Compress)
}

function Read-SharedLines($path) {
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    $stream = $null
    try {
        $stream = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $reader = New-Object IO.StreamReader($stream)
        $text = $reader.ReadToEnd()
        $reader.Close()
        return @($text -split "`r?`n" | Where-Object { $_.Trim() })
    } catch {
        return @()
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

Describe "real agent readiness with a generated least-privilege profile" {
    It "runs device.status and denies process.run through the built tetherd" {
        $tetherd = Join-Path $repo "target\release\tetherd.exe"
        if (-not (Test-Path -LiteralPath $tetherd -PathType Leaf)) {
            throw "built tetherd is required for this acceptance test; run cargo build --release -p tetherd first"
        }
        . (Join-Path $repo "scripts\setup-windows-device.ps1")
        $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-real-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
        $proc = $null
        try {
            $install = Join-Path $tempRoot "install"
            New-Item -ItemType Directory -Force -Path (Join-Path $install "bin"),(Join-Path $install "launch"),(Join-Path $install "config") | Out-Null
            Copy-Item -LiteralPath $tetherd -Destination (Join-Path $install "bin\tetherd.exe")
            Set-Content -LiteralPath (Join-Path $install "launch\tetherplane-agent.ps1") -Value "# test supervisor" -Encoding Ascii
            $state = Join-Path $tempRoot "state"
            Install-DeviceIdentity -StateDir $state -DeviceId "TESTPC01" | Out-Null
            Mock Get-ScheduledTask { return $null }
            Mock Register-ScheduledTask { return $null }
            Mock Start-ScheduledTask { return $null }
            Install-DeviceAgentTask -InstallPrefix $install -StateDir $state -DeviceId "TESTPC01" -RelayUrl "wss://example.invalid/device" | Out-Null

            $principalPath = Join-Path $state "principal.json"
            $profileBytes = [IO.File]::ReadAllBytes($principalPath)
            ($profileBytes[0] -eq 0xEF -and $profileBytes[1] -eq 0xBB -and $profileBytes[2] -eq 0xBF) | Should Be $false

            $agentArgs = @(Get-Content -LiteralPath (Join-Path $install "config\agent-args.json") -Raw | ConvertFrom-Json | ForEach-Object { $_ } | ForEach-Object { [string]$_ })
            $profileArg = ""
            $allowArg = ""
            for ($i = 0; $i -lt $agentArgs.Count; $i++) {
                if ([string]$agentArgs[$i] -eq "--principal-profile") { $profileArg = [string]$agentArgs[$i + 1] }
                if ([string]$agentArgs[$i] -eq "--allow") { $allowArg = [string]$agentArgs[$i + 1] }
            }
            $profileArg | Should Be $principalPath

            $statusId = [Guid]::NewGuid().ToString()
            $deniedId = [Guid]::NewGuid().ToString()
            $inFile = Join-Path $tempRoot "rpc-in.jsonl"
            $outFile = Join-Path $tempRoot "rpc-out.jsonl"
            $errFile = Join-Path $tempRoot "rpc-err.log"
            $requests = (New-RpcLine $statusId "device.status" @{}) + "`n" + (New-RpcLine $deniedId "process.run" @{ program = "cmd.exe" }) + "`n"
            [IO.File]::WriteAllText($inFile, $requests, (New-Object System.Text.UTF8Encoding($false)))

            $argumentLine = ('--stdio-rpc --principal-profile "{0}" --allow "{1}"' -f $profileArg, $allowArg)
            $proc = Start-Process -FilePath (Join-Path $install "bin\tetherd.exe") -ArgumentList $argumentLine -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru

            $lines = @()
            $deadline = [DateTime]::UtcNow.AddSeconds(20)
            while ([DateTime]::UtcNow -lt $deadline) {
                $lines = @(Read-SharedLines $outFile)
                if ($lines.Count -ge 2) { break }
                if ($proc.HasExited) {
                    Start-Sleep -Milliseconds 300
                    $lines = @(Read-SharedLines $outFile)
                    break
                }
                Start-Sleep -Milliseconds 200
            }

            $stderrText = ""
            if (Test-Path -LiteralPath $errFile) { $stderrText = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue) }
            $statusLine = @($lines | Where-Object { $_ -match [regex]::Escape($statusId) })
            $deniedLine = @($lines | Where-Object { $_ -match [regex]::Escape($deniedId) })
            if ($statusLine.Count -ne 1 -or $deniedLine.Count -ne 1) {
                throw ("agent responses did not correlate to the requests. stdout: " + ($lines -join " | ") + " stderr: " + $stderrText)
            }
            $status = $statusLine[0] | ConvertFrom-Json
            $status.status | Should Be "success"
            $status.data.policy_mode | Should Be "background_only"
            $denied = $deniedLine[0] | ConvertFrom-Json
            $denied.status | Should Be "error"
            $denied.error.code | Should Be "permission_denied"
        } finally {
            if ($proc) {
                if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }
                try { [void]$proc.WaitForExit(5000) } catch { }
                $proc.Dispose()
            }
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
