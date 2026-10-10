# Pure offline contract for Vaulter's existing Interactive relay task.
# No scheduled task, listener, process, token, or credential is accessed here.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-restart-settings-repair.ps1'
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){
  throw 'RED: guarded relay restart settings repair source is missing.'
}
$tokens=$null; $errorsFound=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$errorsFound)
if(@($errorsFound).Count -ne 0){throw 'Relay restart repair script does not parse.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($s in @('[switch]$Apply','if (-not $Apply)','Tetherplane Relay',
  'COMPUTERNAME','vaulter','Interactive','AreAccessRulesProtected',
  'RestartCount','RestartInterval','PT1M','999','255','Get-FileHash',
  'Get-NetTCPConnection','Get-ScheduledTask','Export-ScheduledTask','Set-ScheduledTask',
  'Get-CimInstance','CreationDate','Get-RestartNode','Test-RestartCountRange',
  'Test-OnlyRestartCountChanged','Invoke-GuardedSettingsCorrection',
  'VerifyBefore','BackupTask','VerifyAfter','VerifyRestored',
  'No changes made','ROLLBACK UNAVAILABLE')){
  if(-not $source.Contains($s)){throw "Missing relay safety contract: $s"}
}
$commands=@($ast.FindAll({param($node)
  $node -is [System.Management.Automation.Language.CommandAst]
},$true)|ForEach-Object{$_.GetCommandName()})
foreach($forbidden in @('Start-Process','Stop-Process','Register-ScheduledTask',
  'Unregister-ScheduledTask','Start-ScheduledTask','Stop-ScheduledTask',
  'Enable-ScheduledTask','Disable-ScheduledTask','Invoke-Expression',
  'Set-Clipboard','Write-Host')){
  if($commands -contains $forbidden){throw "Forbidden relay task operation: $forbidden"}
}
if($source -match '(?i)gh auth token|funnel\s+(reset|off)|Stop-Process\s+-Name'){
  throw 'Relay restart repair must never touch secrets, Funnel or unknown processes.'
}
foreach($funcName in @('Get-RestartNode','Test-RestartCountRange',
  'Test-OnlyRestartCountChanged','Invoke-GuardedSettingsCorrection')){
  $f=$ast.Find({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ceq $funcName
  }.GetNewClosure(),$true)
  if($null -eq $f){throw "Missing testable function: $funcName"}
  Invoke-Expression $f.Extent.Text
}
foreach($case in @(@(1,$true),@(10,$true),@(255,$true),
  @(0,$false),@(-1,$false),@(256,$false),@(999,$false))){
  if((Test-RestartCountRange -Count $case[0]) -ne $case[1]){
    throw "Invalid restart count schema bounds: $($case[0])"
  }
}
$before='<Task><Principals><Principal><LogonType>InteractiveToken</LogonType><UserId>PRIVATE</UserId></Principal></Principals><Settings><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Actions><Exec><Command>PRIVATE</Command><Arguments>PRIVATE</Arguments></Exec></Actions></Task>'
$after=$before.Replace('<Count>999</Count>','<Count>10</Count>')
if(-not(Test-OnlyRestartCountChanged -BeforeXml $before -AfterXml $after -OldCount 999 -NewCount 10)){
  throw 'Valid one-field restart correction rejected.'
}
foreach($bad in @(
  $after.Replace('<Interval>PT1M</Interval>','<Interval>PT2M</Interval>'),
  $after.Replace('<UserId>PRIVATE</UserId>','<UserId>OTHER</UserId>'),
  $after.Replace('<Command>PRIVATE</Command>','<Command>MODIFIED</Command>'),
  $after.Replace('<Arguments>PRIVATE</Arguments>','<Arguments>MODIFIED</Arguments>'),
  $after.Replace('<LogonTrigger>','<BootTrigger>'),
  $after.Replace('<Enabled>true</Enabled>','<Enabled>false</Enabled>')
)){
  if(Test-OnlyRestartCountChanged -BeforeXml $before -AfterXml $bad -OldCount 999 -NewCount 10){
    throw 'Unexpected non-count task modification accepted.'
  }
}
function Fixture([string[]]$fail){
  $events=New-Object 'System.Collections.Generic.List[string]'
  $ops=@{}
  foreach($step in @('VerifyBefore','BackupTask','ApplyCount','VerifyAfter',
                    'RestorePrior','VerifyRestored')){
    $name=$step
    $ops[$step]={
      $events.Add($name)
      if($fail -ccontains $name){throw ('simulated failure: '+$name)}
    }.GetNewClosure()
  }
  @{Ops=$ops;Events=$events}
}
$pass=Fixture @()
if((Invoke-GuardedSettingsCorrection -Operations $pass.Ops -OriginalCount 999) -cne 'corrected' -or
  ($pass.Events -join ',') -cne 'VerifyBefore,BackupTask,ApplyCount,VerifyAfter'){
  throw 'Safe nominal task settings transaction rejected.'
}
foreach($step in @('VerifyBefore','BackupTask')){
  $f=Fixture @($step)
  $rejected=$false
  try{Invoke-GuardedSettingsCorrection -Operations $f.Ops -OriginalCount 999|Out-Null}
  catch{$rejected=$true}
  if(-not $rejected -or $f.Events.Contains('ApplyCount')){
    throw "Unsafe precheck accepted: $step"
  }
}
foreach($step in @('ApplyCount','VerifyAfter')){
  $f=Fixture @($step)
  $reason=''
  try{Invoke-GuardedSettingsCorrection -Operations $f.Ops -OriginalCount 999|Out-Null}
  catch{$reason=$_.Exception.Message}
  if($reason -notmatch 'NO CHANGE VERIFIED' -or $f.Events.Contains('RestorePrior') -or
     -not $f.Events.Contains('VerifyRestored')){
    throw 'Invalid original restart count must not be rewritten during rollback.'
  }
}
$f=Fixture @('VerifyAfter','VerifyRestored')
$reason=''
try{Invoke-GuardedSettingsCorrection -Operations $f.Ops -OriginalCount 999|Out-Null}
catch{$reason=$_.Exception.Message}
if($reason -notmatch 'ROLLBACK UNAVAILABLE'){
  throw 'Unverified rollback of out-of-range count must fail closed.'
}
Write-Output 'VAULTER RELAY RESTART POLICY CONTRACT PASS'
