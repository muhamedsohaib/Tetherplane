param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Prefix
)

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
    $state = @{
        ready = $true
        focused = $form.ContainsFocus
        text = $value.Text
        selected = if ($selection.SelectedItem) { $selection.SelectedItem.ToString() } else { $null }
        status = $status.Text
        pid = $PID
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($StatePath, $state)
})
$timer.Start()

$form.Add_Shown({
    $form.Activate()
})

[System.Windows.Forms.Application]::Run($form)
