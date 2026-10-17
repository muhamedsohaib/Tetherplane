$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "helpers.ps1")

function Get-OwnAgents($install) {
    return @(Get-Process -Name tetherd -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -like ($install + "*") } catch { $false }
    })
}

function Split-CommandLine($commandLine) {
    $tokens = @()
    foreach ($match in [regex]::Matches($commandLine, '"([^"]*)"|(\S+)')) {
        if ($match.Groups[1].Success) { $tokens += $match.Groups[1].Value } else { $tokens += $match.Groups[2].Value }
    }
    return $tokens
}

Describe "packaged supervisor launches the agent with the generated arguments" {
    It "passes each generated argument intact and never starts a duplicate agent" {
        $tetherd = Join-Path $repo "target\release\tetherd.exe"
        if (-not (Test-Path -LiteralPath $tetherd -PathType Leaf)) {
            throw "built tetherd is required for this acceptance test; run cargo build --release -p tetherd first"
        }
        . (Join-Path $repo "scripts\setup-windows-device.ps1")
        $base = Join-Path ([IO.Path]::GetTempPath()) ("tp sup " + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $base | Out-Null
        $install = Join-Path $base "install dir"
        $state = Join-Path $base "state dir"
        $supervisors = @()
        try {
            New-Item -ItemType Directory -Force -Path (Join-Path $install "bin"),(Join-Path $install "launch"),(Join-Path $install "config") | Out-Null
            Copy-Item -LiteralPath $tetherd -Destination (Join-Path $install "bin\tetherd.exe")
            Copy-Item -LiteralPath (Join-Path $repo "packaging\windows\tetherplane-agent.ps1") -Destination (Join-Path $install "launch\tetherplane-agent.ps1")
            Install-DeviceIdentity -StateDir $state -DeviceId "TESTPC01" | Out-Null
            Mock Get-ScheduledTask { return $null }
            Mock Register-ScheduledTask { return $null }
            Mock Start-ScheduledTask { return $null }
            Install-DeviceAgentTask -InstallPrefix $install -StateDir $state -DeviceId "TESTPC01" -RelayUrl "wss://127.0.0.1:9/device" | Out-Null

            $expected = @(Get-Content -LiteralPath (Join-Path $install "config\agent-args.json") -Raw | ConvertFrom-Json | ForEach-Object { $_ } | ForEach-Object { [string]$_ })
            $expected.Count | Should BeGreaterThan 8

            $supervisorPath = Join-Path $install "launch\tetherplane-agent.ps1"
            $argLine = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $supervisorPath)
            $first = Start-Process -FilePath "powershell.exe" -ArgumentList $argLine -WindowStyle Hidden -PassThru
            $supervisors += $first

            $agent = $null
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while ([DateTime]::UtcNow -lt $deadline) {
                $agents = @(Get-OwnAgents $install)
                if ($agents.Count -ge 1) { $agent = $agents[0]; break }
                Start-Sleep -Milliseconds 300
            }
            if (-not $agent) { throw "the supervisor did not start the agent within 30 seconds" }

            $cim = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $agent.Id)
            $tokens = @(Split-CommandLine ([string]$cim.CommandLine))
            $tokens.Count | Should Be ($expected.Count + 1)
            $tokens[0] | Should Be (Join-Path $install "bin\tetherd.exe")
            (($tokens | Select-Object -Skip 1) -join "|") | Should Be ($expected -join "|")

            $second = Start-Process -FilePath "powershell.exe" -ArgumentList $argLine -WindowStyle Hidden -PassThru
            $supervisors += $second
            $secondExited = $second.WaitForExit(15000)
            $secondExited | Should Be $true
            Start-Sleep -Milliseconds 1500
            @(Get-OwnAgents $install).Count | Should Be 1
        } finally {
            foreach ($supervisor in $supervisors) {
                if ($supervisor -and -not $supervisor.HasExited) { try { $supervisor.Kill() } catch { } }
            }
            foreach ($child in @(Get-OwnAgents $install)) { try { $child.Kill() } catch { } }
            Start-Sleep -Milliseconds 800
            Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
