param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Prefix,
    [switch]$BackgroundOnly,
    [int]$LifetimeMs = 45000,
    [string]$StopPath = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

if ($BackgroundOnly) {
    # Keep the owned acceptance fixture off-screen and incapable of activation.
    Add-Type -TypeDefinition @'
using System.Windows.Forms;
public sealed class TetherplaneNoActivateForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams parameters = base.CreateParams;
            parameters.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            return parameters;
        }
    }
}
'@ -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll')
    $form = New-Object TetherplaneNoActivateForm
} else {
    $form = New-Object System.Windows.Forms.Form
}
$form.Text = $Title
$form.Name = $Prefix + "Form"
$form.AccessibleName = $Prefix + " Form"
$form.Width = 520
$form.Height = 360
if ($BackgroundOnly) {
    $form.StartPosition = "Manual"
    $form.Location = New-Object System.Drawing.Point(-24000, -24000)
    $form.ShowInTaskbar = $false
} else {
    $form.StartPosition = "CenterScreen"
}

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
$script:selectionEventCount = 0
$selection.Add_SelectedIndexChanged({ $script:selectionEventCount++ })

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

$startedAt = [Environment]::TickCount64
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
    $state = @{
        ready = $true
        focused = $form.ContainsFocus
        text = $value.Text
        selected = if ($selection.SelectedItem) { $selection.SelectedItem.ToString() } else { $null }
        selected_index = $selection.SelectedIndex
        selection_events = $script:selectionEventCount
        status = $status.Text
        pid = $PID
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($StatePath, $state)
    if ($BackgroundOnly -and (
        ($StopPath -and [System.IO.File]::Exists($StopPath)) -or
        ($LifetimeMs -gt 0 -and ([Environment]::TickCount64 - $startedAt) -ge $LifetimeMs)
    )) {
        $form.Close()
    }
})
$timer.Start()

$form.Add_Shown({
    if (-not $BackgroundOnly) { $form.Activate() }
})

[System.Windows.Forms.Application]::Run($form)
