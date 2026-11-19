param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Prefix,
    [ValidateSet("WinForms", "Wpf")][string]$Framework = "WinForms",
    [switch]$InitializeOnly,
    [switch]$NoActivate,
    [switch]$SelfTestTimer
)

$stateDir = Split-Path -Parent $StatePath
if ($stateDir -and -not (Test-Path -LiteralPath $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}
$tmpStatePath = "$StatePath.$PID.tmp"
$stopPath = "$StatePath.stop"
$startupPath = "$StatePath.startup.txt"

function Write-FixtureStartupStage {
    param([string]$Stage)
    [IO.File]::WriteAllText($startupPath, ("framework=" + $Framework + ";pid=" + $PID + ";stage=" + $Stage))
}

Write-FixtureStartupStage 'script-started'

# Surface constructor/property failures in retained guest diagnostics instead
# of leaving a running process without an owned.json readiness file.
$ErrorActionPreference = 'Stop'
trap {
    $startupError = ($_ | Out-String)
    try {
        [IO.File]::WriteAllText("$startupPath.error.txt", $startupError)
        Write-FixtureStartupStage 'fatal-error'
    } catch {
        # Preserve the original failure even if diagnostic IO fails.
    }
    Write-Error $startupError -ErrorAction Continue
    exit 1
}

# Shared mutable state container so .NET event scriptblocks mutate counters
# directly without PowerShell child-scope scalar copying.
$fixtureRuntime = @{
    state_seq = 0
    tick_count = 0
    content_rendered = $false
    activated_events = 0
    deactivated_events = 0
    write_errors = 0
    last_write_error = $null
    last_source = 'init'
    native_helper_available = $false
    native_helper_error = $null
    timer = $null
}

# Strictly read-only Win32 foreground observation plus atomic file replacement
# for this disposable fixture's own state JSON. Never manipulates focus/input.
$nativeHelperSource = @'
using System;
using System.Runtime.InteropServices;

public sealed class TetherplaneG4ForegroundSnapshot
{
    public long Hwnd;
    public uint Pid;
}

public static class TetherplaneG4FixtureNative
{
    private const uint MoveFileReplaceExisting = 0x1;
    private const uint MoveFileWriteThrough = 0x8;

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool MoveFileExW(string existingFileName, string newFileName, uint flags);

    public static TetherplaneG4ForegroundSnapshot ReadForeground()
    {
        IntPtr fg = GetForegroundWindow();
        uint pid = 0;
        if (fg != IntPtr.Zero)
        {
            GetWindowThreadProcessId(fg, out pid);
        }
        TetherplaneG4ForegroundSnapshot snapshot = new TetherplaneG4ForegroundSnapshot();
        snapshot.Hwnd = fg.ToInt64();
        snapshot.Pid = pid;
        return snapshot;
    }

    public static int AtomicReplaceFile(string sourcePath, string destinationPath)
    {
        if (MoveFileExW(sourcePath, destinationPath, MoveFileReplaceExisting | MoveFileWriteThrough))
        {
            return 0;
        }
        return Marshal.GetLastWin32Error();
    }
}
'@

try {
    if (-not ('TetherplaneG4FixtureNative' -as [type])) {
        Add-Type -TypeDefinition $nativeHelperSource -Language CSharp
    }
    $fixtureRuntime['native_helper_available'] = $true
} catch {
    $fixtureRuntime['native_helper_available'] = $false
    $fixtureRuntime['native_helper_error'] = $_.Exception.Message
    $fixtureRuntime['last_write_error'] = 'native-helper: ' + $_.Exception.Message
}

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-FixtureState {
    param(
        [bool]$WindowIsActive,
        [bool]$WindowIsKeyboardFocusWithin,
        [int64]$WindowHwnd,
        [string]$TextValue,
        $SelectedValue,
        [string]$StatusText,
        [string]$Source = 'timer'
    )

    $osForegroundAvailable = [bool]$fixtureRuntime['native_helper_available']
    $osForegroundHwnd = [int64]0
    $osForegroundPid = [uint32]0
    if ($osForegroundAvailable) {
        try {
            $fg = [TetherplaneG4FixtureNative]::ReadForeground()
            $osForegroundHwnd = [int64]$fg.Hwnd
            $osForegroundPid = [uint32]$fg.Pid
        } catch {
            $osForegroundAvailable = $false
            $fixtureRuntime['last_write_error'] = 'foreground-read: ' + $_.Exception.Message
        }
    }

    $osForegroundMatchesWindow = (
        $osForegroundAvailable -and
        $WindowHwnd -ne 0 -and
        $osForegroundHwnd -eq $WindowHwnd
    )
    $osForegroundMatchesProcess = (
        $osForegroundAvailable -and
        $osForegroundPid -eq [uint32]$PID
    )
    # Use kernel foreground ground truth when available so two top-level
    # windows on the same desktop cannot simultaneously report focused=true,
    # while still exposing raw framework activation state for diagnostics.
    $effectiveFocused = if ($osForegroundAvailable -and $WindowHwnd -ne 0) {
        [bool]$osForegroundMatchesWindow
    } else {
        [bool]$WindowIsActive
    }
    $focusMismatch = (
        $osForegroundAvailable -and
        $WindowHwnd -ne 0 -and
        ([bool]$WindowIsActive -ne [bool]$osForegroundMatchesWindow)
    )

    $nextSeq = [int]$fixtureRuntime['state_seq'] + 1
    $fixtureRuntime['state_seq'] = $nextSeq
    $fixtureRuntime['last_source'] = $Source

    $state = [ordered]@{
        ready = [bool]$fixtureRuntime['content_rendered']
        content_rendered = [bool]$fixtureRuntime['content_rendered']
        focused = $effectiveFocused
        window_is_active = [bool]$WindowIsActive
        window_is_keyboard_focus_within = [bool]$WindowIsKeyboardFocusWithin
        hwnd = $WindowHwnd
        os_foreground_available = $osForegroundAvailable
        os_foreground_hwnd = $osForegroundHwnd
        os_foreground_pid = [int64]$osForegroundPid
        os_foreground_matches_window = [bool]$osForegroundMatchesWindow
        os_foreground_matches_process = [bool]$osForegroundMatchesProcess
        focus_mismatch = [bool]$focusMismatch
        state_seq = $nextSeq
        tick_count = [int]$fixtureRuntime['tick_count']
        activated_events = [int]$fixtureRuntime['activated_events']
        deactivated_events = [int]$fixtureRuntime['deactivated_events']
        write_errors = [int]$fixtureRuntime['write_errors']
        last_write_error = $fixtureRuntime['last_write_error']
        last_source = $Source
        updated_at_utc = [DateTime]::UtcNow.ToString('o')
        text = $TextValue
        selected = $SelectedValue
        status = $StatusText
        pid = $PID
        framework = $Framework
    } | ConvertTo-Json -Compress

    $wrote = $false
    $lastErr = $null
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        try {
            [System.IO.File]::WriteAllText($tmpStatePath, $state, $utf8NoBom)
            if ($fixtureRuntime['native_helper_available']) {
                $win32Err = [TetherplaneG4FixtureNative]::AtomicReplaceFile($tmpStatePath, $StatePath)
                if ($win32Err -eq 0) {
                    $wrote = $true
                    break
                }
                $lastErr = "MoveFileExW failed with Win32 error $win32Err"
            } else {
                [System.IO.File]::Copy($tmpStatePath, $StatePath, $true)
                Remove-Item -LiteralPath $tmpStatePath -Force -ErrorAction SilentlyContinue
                $wrote = $true
                break
            }
        } catch {
            $lastErr = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 15
    }

    if (-not $wrote) {
        $fixtureRuntime['write_errors'] = [int]$fixtureRuntime['write_errors'] + 1
        $fixtureRuntime['last_write_error'] = $lastErr
    }
}

if ($Framework -eq "Wpf") {
    Write-FixtureStartupStage 'before-assembly-load'
    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName PresentationCore
    Add-Type -AssemblyName WindowsBase
    Write-FixtureStartupStage 'assemblies-loaded'

    $window = [System.Windows.Window]::new()
    $window.Title = $Title
    $window.Width = 520
    $window.Height = 360
    $window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::CenterScreen
    if ($NoActivate) {
        $window.ShowActivated = $false
    }
    [System.Windows.Automation.AutomationProperties]::SetName($window, "$Prefix Form")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($window, "$($Prefix)Form")
    Write-FixtureStartupStage 'window-created'

    Write-FixtureStartupStage 'before-stackpanel-constructor'
    $panel = [System.Windows.Controls.StackPanel]::new()
    Write-FixtureStartupStage 'stackpanel-created'
    $panel.Margin = [System.Windows.Thickness]::new(16)
    Write-FixtureStartupStage 'stackpanel-margin-set'

    $value = [System.Windows.Controls.TextBox]::new()
    Write-FixtureStartupStage 'textbox-created'
    $value.Name = "$($Prefix)Value"
    $value.Text = "$Prefix-initial"
    $value.Margin = [System.Windows.Thickness]::new(0, 0, 0, 12)
    [System.Windows.Automation.AutomationProperties]::SetName($value, "$Prefix Value")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($value, "$($Prefix)Value")

    $invoke = [System.Windows.Controls.Button]::new()
    Write-FixtureStartupStage 'button-created'
    $invoke.Name = "$($Prefix)Invoke"
    $invoke.Content = "$Prefix Invoke"
    $invoke.Width = 180
    $invoke.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
    $invoke.Margin = [System.Windows.Thickness]::new(0, 0, 0, 12)
    [System.Windows.Automation.AutomationProperties]::SetName($invoke, "$Prefix Invoke")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($invoke, "$($Prefix)Invoke")

    $selection = [System.Windows.Controls.ListBox]::new()
    Write-FixtureStartupStage 'listbox-created'
    $selection.Name = "$($Prefix)Selection"
    $selection.Width = 220
    $selection.Height = 110
    $selection.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
    $selection.Margin = [System.Windows.Thickness]::new(0, 0, 0, 12)
    [System.Windows.Automation.AutomationProperties]::SetName($selection, "$Prefix Selection")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($selection, "$($Prefix)Selection")

    $itemAlpha = [System.Windows.Controls.ListBoxItem]::new()
    Write-FixtureStartupStage 'alpha-item-created'
    $itemAlpha.Content = "$Prefix Alpha"
    [System.Windows.Automation.AutomationProperties]::SetName($itemAlpha, "$Prefix Alpha")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($itemAlpha, "$($Prefix)Alpha")

    $itemBeta = [System.Windows.Controls.ListBoxItem]::new()
    Write-FixtureStartupStage 'beta-item-created'
    $itemBeta.Content = "$Prefix Beta"
    [System.Windows.Automation.AutomationProperties]::SetName($itemBeta, "$Prefix Beta")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($itemBeta, "$($Prefix)Beta")

    [void]$selection.Items.Add($itemAlpha)
    [void]$selection.Items.Add($itemBeta)
    $selection.SelectedIndex = 0

    $status = [System.Windows.Controls.TextBlock]::new()
    $status.Name = "$($Prefix)Status"
    $status.Text = "idle"
    [System.Windows.Automation.AutomationProperties]::SetName($status, "$Prefix Status")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($status, "$($Prefix)Status")

    $readWpfSelected = {
        if ($selection.SelectedItem -is [System.Windows.Controls.ListBoxItem]) {
            [string]$selection.SelectedItem.Content
        } elseif ($selection.SelectedItem) {
            $selection.SelectedItem.ToString()
        } else {
            $null
        }
    }

    $readWpfHwnd = {
        try {
            ([System.Windows.Interop.WindowInteropHelper]::new($window)).Handle.ToInt64()
        } catch {
            [int64]0
        }
    }

    $publishWpfState = {
        param([string]$Source)
        Write-FixtureState `
            -WindowIsActive ([bool]$window.IsActive) `
            -WindowIsKeyboardFocusWithin ([bool]$window.IsKeyboardFocusWithin) `
            -WindowHwnd (& $readWpfHwnd) `
            -TextValue $value.Text `
            -SelectedValue (& $readWpfSelected) `
            -StatusText $status.Text `
            -Source $Source
    }

    $invoke.Add_Click({
        $status.Text = "invoked"
        if ($fixtureRuntime['content_rendered']) {
            & $publishWpfState 'click'
        }
    })
    $value.Add_TextChanged({
        if ($fixtureRuntime['content_rendered']) {
            & $publishWpfState 'text-changed'
        }
    })
    $selection.Add_SelectionChanged({
        if ($fixtureRuntime['content_rendered']) {
            & $publishWpfState 'selection-changed'
        }
    })
    $window.Add_Activated({
        $fixtureRuntime['activated_events'] = [int]$fixtureRuntime['activated_events'] + 1
        if ($fixtureRuntime['content_rendered']) {
            & $publishWpfState 'activated'
        }
    })
    $window.Add_Deactivated({
        $fixtureRuntime['deactivated_events'] = [int]$fixtureRuntime['deactivated_events'] + 1
        if ($fixtureRuntime['content_rendered']) {
            & $publishWpfState 'deactivated'
        }
    })
    $window.Add_ContentRendered({
        Write-FixtureStartupStage 'content-rendered'
        if (-not $NoActivate) {
            $null = $window.Activate()
            $null = $value.Focus()
        }
        $fixtureRuntime['content_rendered'] = $true
        & $publishWpfState 'content-rendered'
    })
    $window.Add_Closed({
        if ($fixtureRuntime['timer']) {
            $fixtureRuntime['timer'].Stop()
        }
        [System.Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvokeShutdown(
            [System.Windows.Threading.DispatcherPriority]::Background
        )
    })

    [void]$panel.Children.Add($value)
    [void]$panel.Children.Add($invoke)
    [void]$panel.Children.Add($selection)
    [void]$panel.Children.Add($status)
    $window.Content = $panel
    Write-FixtureStartupStage 'controls-created'
    if ($InitializeOnly) { return }

    if ($SelfTestTimer) {
        # Nonvisible DispatcherTimer + atomic Write-FixtureState verification
        # for headless Windows CI. Opens zero windows.
        Write-FixtureStartupStage 'selftest-timer-start'
        $fixtureRuntime['content_rendered'] = $true
        $frame = [System.Windows.Threading.DispatcherFrame]::new()
        $selfTimer = [System.Windows.Threading.DispatcherTimer]::new(
            [System.Windows.Threading.DispatcherPriority]::Normal
        )
        $selfTimer.Interval = [TimeSpan]::FromMilliseconds(40)
        $selfTimer.Add_Tick({
            $fixtureRuntime['tick_count'] = [int]$fixtureRuntime['tick_count'] + 1
            & $publishWpfState 'selftest-timer'
            if ([int]$fixtureRuntime['tick_count'] -ge 3) {
                $selfTimer.Stop()
                $frame.Continue = $false
            }
        })
        $selfTimer.Start()
        try {
            [System.Windows.Threading.Dispatcher]::PushFrame($frame)
        } finally {
            $selfTimer.Stop()
            Remove-Item -LiteralPath $tmpStatePath -Force -ErrorAction SilentlyContinue
        }
        Write-FixtureStartupStage 'selftest-timer-done'
        exit 0
    }

    $timer = [System.Windows.Threading.DispatcherTimer]::new(
        [System.Windows.Threading.DispatcherPriority]::Normal
    )
    $timer.Interval = [TimeSpan]::FromMilliseconds(100)
    $fixtureRuntime['timer'] = $timer
    $timer.Add_Tick({
        if (Test-Path -LiteralPath $stopPath) {
            Write-FixtureStartupStage 'cooperative-stop'
            $timer.Stop()
            $window.Close()
            return
        }
        $fixtureRuntime['tick_count'] = [int]$fixtureRuntime['tick_count'] + 1
        try {
            & $publishWpfState 'timer'
        } catch {
            $fixtureRuntime['write_errors'] = [int]$fixtureRuntime['write_errors'] + 1
            $fixtureRuntime['last_write_error'] = $_.Exception.Message
        }
    })
    $timer.Start()

    try {
        # Use non-modal Show() + Dispatcher.Run() so Window.ShowActivated=$false
        # genuinely opens the owned fixture via SW_SHOWNOACTIVATE without
        # stealing OS foreground from the launcher or human fixture.
        Write-FixtureStartupStage 'entering-dispatcher'
        $window.Show()
        [System.Windows.Threading.Dispatcher]::Run()
        Write-FixtureStartupStage 'returned-from-dispatcher'
    } finally {
        $timer.Stop()
        Remove-Item -LiteralPath $tmpStatePath -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Name = $Prefix + "Form"
$form.AccessibleName = $Prefix + " Form"
$form.Width = 520
$form.Height = 360
$form.StartPosition = "CenterScreen"

$value = New-Object System.Windows.Forms.TextBox
$value.Name = $Prefix + "Value"
$value.AccessibleName = $Prefix + " Value"
$value.Text = $Prefix + "-initial"
$value.Left = 24
$value.Top = 24
$value.Width = 440

$invoke = New-Object System.Windows.Forms.Button
$invoke.Name = $Prefix + "Invoke"
$invoke.AccessibleName = $Prefix + " Invoke"
$invoke.Text = $Prefix + " Invoke"
$invoke.Left = 24
$invoke.Top = 72
$invoke.Width = 180

$selection = New-Object System.Windows.Forms.ListBox
$selection.Name = $Prefix + "Selection"
$selection.AccessibleName = $Prefix + " Selection"
$selection.Left = 24
$selection.Top = 120
$selection.Width = 220
$selection.Height = 100
[void]$selection.Items.Add($Prefix + " Alpha")
[void]$selection.Items.Add($Prefix + " Beta")
$selection.SelectedIndex = 0

$status = New-Object System.Windows.Forms.Label
$status.Name = $Prefix + "Status"
$status.AccessibleName = $Prefix + " Status"
$status.Text = "idle"
$status.Left = 24
$status.Top = 240
$status.Width = 300

$readWinFormsSelected = {
    if ($selection.SelectedItem) {
        $selection.SelectedItem.ToString()
    } else {
        $null
    }
}

$readWinFormsHwnd = {
    if ($form.IsHandleCreated) {
        $form.Handle.ToInt64()
    } else {
        [int64]0
    }
}

$publishWinFormsState = {
    param([string]$Source)
    $containsFocus = [bool]$form.ContainsFocus
    Write-FixtureState `
        -WindowIsActive $containsFocus `
        -WindowIsKeyboardFocusWithin $containsFocus `
        -WindowHwnd (& $readWinFormsHwnd) `
        -TextValue $value.Text `
        -SelectedValue (& $readWinFormsSelected) `
        -StatusText $status.Text `
        -Source $Source
}

$invoke.Add_Click({
    $status.Text = "invoked"
    if ($fixtureRuntime['content_rendered']) {
        & $publishWinFormsState 'click'
    }
})
$value.Add_TextChanged({
    if ($fixtureRuntime['content_rendered']) {
        & $publishWinFormsState 'text-changed'
    }
})
$selection.Add_SelectedIndexChanged({
    if ($fixtureRuntime['content_rendered']) {
        & $publishWinFormsState 'selection-changed'
    }
})
$form.Add_Activated({
    $fixtureRuntime['activated_events'] = [int]$fixtureRuntime['activated_events'] + 1
    if ($fixtureRuntime['content_rendered']) {
        & $publishWinFormsState 'activated'
    }
})
$form.Add_Deactivate({
    $fixtureRuntime['deactivated_events'] = [int]$fixtureRuntime['deactivated_events'] + 1
    if ($fixtureRuntime['content_rendered']) {
        & $publishWinFormsState 'deactivated'
    }
})
$form.Add_Shown({
    Write-FixtureStartupStage 'winforms-shown'
    if (-not $NoActivate) {
        $form.Activate()
    }
    $fixtureRuntime['content_rendered'] = $true
    & $publishWinFormsState 'winforms-shown'
})

$form.Controls.AddRange(@($value, $invoke, $selection, $status))
Write-FixtureStartupStage 'winforms-controls-created'
if ($InitializeOnly) { return }

if ($SelfTestTimer) {
    Write-FixtureStartupStage 'winforms-selftest-timer-start'
    $fixtureRuntime['content_rendered'] = $true
    $appCtx = [System.Windows.Forms.ApplicationContext]::new()
    $selfTimer = New-Object System.Windows.Forms.Timer
    $selfTimer.Interval = 40
    $selfTimer.Add_Tick({
        $fixtureRuntime['tick_count'] = [int]$fixtureRuntime['tick_count'] + 1
        & $publishWinFormsState 'selftest-timer'
        if ([int]$fixtureRuntime['tick_count'] -ge 3) {
            $selfTimer.Stop()
            $appCtx.ExitThread()
        }
    })
    $selfTimer.Start()
    try {
        [System.Windows.Forms.Application]::Run($appCtx)
    } finally {
        $selfTimer.Stop()
        $selfTimer.Dispose()
        $appCtx.Dispose()
        Remove-Item -LiteralPath $tmpStatePath -Force -ErrorAction SilentlyContinue
    }
    Write-FixtureStartupStage 'winforms-selftest-timer-done'
    exit 0
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$fixtureRuntime['timer'] = $timer
$timer.Add_Tick({
    if (Test-Path -LiteralPath $stopPath) {
        Write-FixtureStartupStage 'cooperative-stop'
        $timer.Stop()
        $form.Close()
        return
    }
    $fixtureRuntime['tick_count'] = [int]$fixtureRuntime['tick_count'] + 1
    try {
        & $publishWinFormsState 'timer'
    } catch {
        $fixtureRuntime['write_errors'] = [int]$fixtureRuntime['write_errors'] + 1
        $fixtureRuntime['last_write_error'] = $_.Exception.Message
    }
})
$timer.Start()

try {
    Write-FixtureStartupStage 'winforms-run'
    [System.Windows.Forms.Application]::Run($form)
} finally {
    $timer.Stop()
    $timer.Dispose()
    Remove-Item -LiteralPath $tmpStatePath -Force -ErrorAction SilentlyContinue
}
