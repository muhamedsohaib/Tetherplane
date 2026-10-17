param(
    [Parameter(Mandatory = $true)][string]$MarkerPath,
    [Parameter(Mandatory = $true)][string]$SnapshotPath,
    [Parameter(Mandatory = $true)][string]$StopPath,
    [ValidateRange(250, 120000)][int]$LifetimeMs = 30000,
    [ValidateRange(1, 1000)][int]$SampleIntervalMs = 50,
    [ValidateRange(0, 2147483647)][int]$OwnedPid = 0
)

$ErrorActionPreference = "Stop"

# Read metadata only. This helper never moves the cursor, sets foreground
# focus, injects input, opens the clipboard, or records raw input values.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TetherplaneOperatorActivityProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LastInput {
        public uint Size;
        public uint Tick;
    }

    public struct Sample {
        public int X;
        public int Y;
        public uint InputTick;
        public uint ClipboardSequence;
        public uint ForegroundProcessId;
    }

    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput lastInput);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();

    public static Sample Observe() {
        Point point;
        LastInput lastInput = new LastInput {
            Size = (uint)Marshal.SizeOf(typeof(LastInput))
        };
        if (!GetCursorPos(out point) || !GetLastInputInfo(ref lastInput)) {
            throw new InvalidOperationException("read-only desktop activity unavailable");
        }
        uint pid = 0;
        IntPtr foreground = GetForegroundWindow();
        if (foreground != IntPtr.Zero) {
            GetWindowThreadProcessId(foreground, out pid);
        }
        return new Sample {
            X = point.X,
            Y = point.Y,
            InputTick = lastInput.Tick,
            ClipboardSequence = GetClipboardSequenceNumber(),
            ForegroundProcessId = pid
        };
    }
}
'@

$phases = @("baseline", "set_value", "invoke", "select", "post")
$phaseSamples = [ordered]@{}
foreach ($phase in $phases) {
    $phaseSamples[$phase] = [ordered]@{
        sample_count = 0
        cursor_motion_samples = 0
        input_change_samples = 0
        first_sample_ms = $null
        last_sample_ms = $null
    }
}
$sampleCount = 0
$motionCount = 0
$inputCount = 0
$clipboardCount = 0
$ownedForegroundCount = 0
$activePhase = "baseline"
$lastPublishedPhase = ""
$finished = $false
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$previous = [TetherplaneOperatorActivityProbe]::Observe()
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Observation {
    $summary = [ordered]@{
        ready = ($sampleCount -gt 0)
        active_phase = $activePhase
        sample_count = $sampleCount
        cursor_motion_samples = $motionCount
        input_change_samples = $inputCount
        clipboard_change_samples = $clipboardCount
        owned_foreground_samples = $ownedForegroundCount
        phase_samples = $phaseSamples
        elapsed_ms = [int]$clock.ElapsedMilliseconds
        finished = $finished
    }
    $json = ConvertTo-Json -InputObject $summary -Depth 7 -Compress
    [System.IO.File]::WriteAllText($SnapshotPath, $json, $utf8)
}

try {
    while ($clock.ElapsedMilliseconds -lt $LifetimeMs -and
           -not [System.IO.File]::Exists($StopPath)) {
        if ([System.IO.File]::Exists($MarkerPath)) {
            $marker = $null
            try {
                $marker = [System.IO.File]::ReadAllText($MarkerPath).Trim()
            } catch {
                # Node can briefly hold an exclusive handle while writing
                # the test-owned phase marker. Do not kill a read-only
                # sampler for that temporary sharing violation; preserve
                # the prior phase. Any real access or parse error still fails.
                $cause = $_.Exception.GetBaseException()
                if (-not ($cause -is [System.IO.IOException])) { throw }
            }
            if ($null -ne $marker) {
                if ($phases -contains $marker) {
                    $activePhase = $marker
                } elseif ($marker -match "^prepare:(set_value|invoke|select)$") {
                    $activePhase = $marker
                } elseif ($marker.Length -gt 0) {
                    throw "invalid activity-phase marker"
                }
            }
        }
        $current = [TetherplaneOperatorActivityProbe]::Observe()
        $bucketPhase = if ($activePhase.StartsWith("prepare:")) { "baseline" } else { $activePhase }
        $bucket = $phaseSamples[$bucketPhase]
        $firstSample = $null -eq $bucket.first_sample_ms
        $sampleTime = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($firstSample) { $bucket.first_sample_ms = $sampleTime }
        $bucket.last_sample_ms = $sampleTime
        $bucket.sample_count++
        $sampleCount++

        if (-not $firstSample -and ($current.X -ne $previous.X -or $current.Y -ne $previous.Y)) {
            $motionCount++
            $bucket.cursor_motion_samples++
        }
        if (-not $firstSample -and $current.InputTick -ne $previous.InputTick) {
            $inputCount++
            $bucket.input_change_samples++
        }
        if ($current.ClipboardSequence -ne $previous.ClipboardSequence) {
            $clipboardCount++
        }
        if ($OwnedPid -ne 0 -and [int]$current.ForegroundProcessId -eq $OwnedPid) {
            $ownedForegroundCount++
        }
        $previous = $current
        # Sampling must stay faster than short semantic RPCs. Serialize JSON
        # less often, but publish each phase transition for acknowledgment.
        if ($activePhase -ne $lastPublishedPhase -or ($sampleCount % 8) -eq 0) {
            Write-Observation
            $lastPublishedPhase = $activePhase
        }
        Start-Sleep -Milliseconds $SampleIntervalMs
    }
} finally {
    $finished = $true
    Write-Observation
}
