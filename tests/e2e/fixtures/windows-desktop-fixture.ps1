param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Prefix,
    [ValidateSet("WinForms", "Wpf")][string]$Framework = "WinForms"
)

$stateDir = Split-Path -Parent $StatePath
if ($stateDir -and -not (Test-Path -LiteralPath $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}
$tmpStatePath = "$StatePath.$PID.tmp"

function Write-FixtureState {
    param(
        [bool]$Focused,
        [string]$TextValue,
        $SelectedValue,
        [string]$StatusText
    )
    $state = @{
        ready = $true
        focused = $Focused
        text = $TextValue
        selected = $SelectedValue
        status = $StatusText
        pid = $PID
        framework = $Framework
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($tmpStatePath, $state)
    Move-Item -LiteralPath $tmpStatePath -Destination $StatePath -Force
}

if ($Framework -eq "Wpf") {
    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName PresentationCore
    Add-Type -AssemblyName WindowsBase

    $window = New-Object System.Windows.Window
    $window.Title = $Title
    $window.Width = 520
    $window.Height = 360
    $window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::CenterScreen
    [System.Windows.Automation.AutomationProperties]::SetName($window, "$Prefix Form")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($window, "$($Prefix)Form")

    $panel = New-Object System.Windows.Controls.StackPanel
    $panel.Margin = New-Object System.Windows.Thickness(16)

    $value = New-Object System.Windows.Controls.TextBox
    $value.Name = "$($Prefix)Value"
    $value.Text = "$Prefix-initial"
    $value.Margin = New-Object System.Windows.Thickness(0, 0, 0, 12)
    [System.Windows.Automation.AutomationProperties]::SetName($value, "$Prefix Value")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($value, "$($Prefix)Value")

    $invoke = New-Object System.Windows.Controls.Button
    $invoke.Name = "$($Prefix)Invoke"
    $invoke.Content = "$Prefix Invoke"
    $invoke.Width = 180
    $invoke.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
    $invoke.Margin = New-Object System.Windows.Thickness(0, 0, 0, 12)
    [System.Windows.Automation.AutomationProperties]::SetName($invoke, "$Prefix Invoke")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($invoke, "$($Prefix)Invoke")

    $selection = New-Object System.Windows.Controls.ListBox
    $selection.Name = "$($Prefix)Selection"
    $selection.Width = 220
    $selection.Height = 110
    $selection.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
    $selection.Margin = New-Object System.Windows.Thickness(0, 0, 0, 12)
    [System.Windows.Automation.AutomationProperties]::SetName($selection, "$Prefix Selection")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($selection, "$($Prefix)Selection")

    $itemAlpha = New-Object System.Windows.Controls.ListBoxItem
    $itemAlpha.Content = "$Prefix Alpha"
    [System.Windows.Automation.AutomationProperties]::SetName($itemAlpha, "$Prefix Alpha")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($itemAlpha, "$($Prefix)Alpha")

    $itemBeta = New-Object System.Windows.Controls.ListBoxItem
    $itemBeta.Content = "$Prefix Beta"
    [System.Windows.Automation.AutomationProperties]::SetName($itemBeta, "$Prefix Beta")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($itemBeta, "$($Prefix)Beta")

    [void]$selection.Items.Add($itemAlpha)
    [void]$selection.Items.Add($itemBeta)
    $selection.SelectedIndex = 0

    $status = New-Object System.Windows.Controls.TextBlock
    $status.Name = "$($Prefix)Status"
    $status.Text = "idle"
    [System.Windows.Automation.AutomationProperties]::SetName($status, "$Prefix Status")
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($status, "$($Prefix)Status")

    $invoke.Add_Click({
        $status.Text = "invoked"
    })

    [void]$panel.Children.Add($value)
    [void]$panel.Children.Add($invoke)
    [void]$panel.Children.Add($selection)
    [void]$panel.Children.Add($status)
    $window.Content = $panel

    $readWpfSelected = {
        if ($selection.SelectedItem -is [System.Windows.Controls.ListBoxItem]) {
            [string]$selection.SelectedItem.Content
        } elseif ($selection.SelectedItem) {
            $selection.SelectedItem.ToString()
        } else {
            $null
        }
    }

    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(100)
    $timer.Add_Tick({
        Write-FixtureState `
            -Focused ([bool]$window.IsActive) `
            -TextValue $value.Text `
            -SelectedValue (& $readWpfSelected) `
            -StatusText $status.Text
    })
    $timer.Start()

    $window.Add_ContentRendered({
        $null = $window.Activate()
        $null = $value.Focus()
        Write-FixtureState `
            -Focused ([bool]$window.IsActive) `
            -TextValue $value.Text `
            -SelectedValue (& $readWpfSelected) `
            -StatusText $status.Text
    })

    try {
        $null = $window.ShowDialog()
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

$invoke.Add_Click({
    $status.Text = "invoked"
})

$form.Controls.AddRange(@($value, $invoke, $selection, $status))

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
    $selectedText = if ($selection.SelectedItem) { $selection.SelectedItem.ToString() } else { $null }
    Write-FixtureState `
        -Focused ([bool]$form.ContainsFocus) `
        -TextValue $value.Text `
        -SelectedValue $selectedText `
        -StatusText $status.Text
})
$timer.Start()

$form.Add_Shown({
    $form.Activate()
    $selectedText = if ($selection.SelectedItem) { $selection.SelectedItem.ToString() } else { $null }
    Write-FixtureState `
        -Focused ([bool]$form.ContainsFocus) `
        -TextValue $value.Text `
        -SelectedValue $selectedText `
        -StatusText $status.Text
})

try {
    [System.Windows.Forms.Application]::Run($form)
} finally {
    $timer.Stop()
    Remove-Item -LiteralPath $tmpStatePath -Force -ErrorAction SilentlyContinue
}
