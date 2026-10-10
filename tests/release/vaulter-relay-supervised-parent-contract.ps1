# Synthetic supervised native bridge ownership: no local tasks/processes accessed.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-bridge-launcher.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'Native launcher parse failed.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path)
foreach($needed in @('[switch]$Supervised','Assert-SupervisedBridgeOwnership','Get-CimInstance',
    'ParentProcessId','CreationDate','relay-supervisor-bridge','pre-supervisor-task.xml',
    'Get-ScheduledTask','Export-ScheduledTask','-Serve -Bridge')){
  if(-not $source.Contains($needed)){throw "RED: native supervised bridge ownership guard missing $needed"}
}
$function=$ast.Find({
  param($n)
  $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $n.Name -ceq 'Assert-SupervisedBridgeOwnership'
},$true)
if($null -eq $function){throw 'RED: testable native bridge ownership guard missing.'}
Invoke-Expression $function.Extent.Text
$supervisorPath='C:\protected\relay-supervisor-bridge\vaulter-relay-bounded-supervisor.ps1'
$launcherPath='C:\protected\relay-supervisor-bridge\vaulter-relay-bridge-launcher.ps1'
$exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$expectedArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$supervisorPath+'" -Serve -Bridge'
$old='<Task><Settings><Count>10</Count></Settings><Actions><Exec><Command>powershell.exe</Command><Arguments>-File original.ps1</Arguments><WorkingDirectory>C:\trusted</WorkingDirectory></Exec></Actions></Task>'
$new='<Task><Settings><Count>10</Count></Settings><Actions><Exec><Command>powershell.exe</Command><Arguments>'+[Security.SecurityElement]::Escape($expectedArgs)+'</Arguments><WorkingDirectory>C:\trusted</WorkingDirectory></Exec></Actions></Task>'
$parent=[pscustomobject]@{
  Name='powershell.exe';ProcessId=121;CreationDate=([datetime]'2026-10-10T10:00:00Z')
  ExecutablePath=$exe
  CommandLine=('"'+$exe+'" '+$expectedArgs)
}
$self=[pscustomobject]@{
  Name='powershell.exe';ProcessId=122;ParentProcessId=121
  CreationDate=([datetime]'2026-10-10T10:01:00Z')
  ExecutablePath=$exe
  CommandLine=('"'+$exe+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$launcherPath+'" -Serve -Supervised')
}
$task=[pscustomobject]@{
  State='Running'
  Settings=[pscustomobject]@{Enabled=$true;MultipleInstances='IgnoreNew'}
  Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments=$expectedArgs;WorkingDirectory='C:\trusted'})
}
$arguments=@{SelfProcess=$self;ParentProcess=$parent;Task=$task;
    OriginalTaskXml=$old;CurrentTaskXml=$new;
    SupervisorPath=$supervisorPath;LauncherPath=$launcherPath}
Assert-SupervisedBridgeOwnership @arguments
function MustReject([string]$name,[hashtable]$changes) {
  $args=@{};foreach($key in $arguments.Keys){$args[$key]=$arguments[$key]}
  foreach($key in $changes.Keys){$args[$key]=$changes[$key]}
  $rejected=$false
  try{Assert-SupervisedBridgeOwnership @args | Out-Null}catch{$rejected=$true}
  if(-not $rejected){throw "Unsafe supervised bridge ownership accepted: $name"}
}
$badChild=[pscustomobject]@{Name='powershell.exe';ProcessId=122;ParentProcessId=999;CreationDate=$self.CreationDate;ExecutablePath=$exe;CommandLine=$self.CommandLine}
MustReject 'parent PID spoofing' @{SelfProcess=$badChild}
$badParent=[pscustomobject]@{Name='powershell.exe';ProcessId=121;CreationDate=$parent.CreationDate;ExecutablePath=$exe;CommandLine=('"'+$exe+'" '+$expectedArgs.Replace(' -Bridge',''))}
MustReject 'missing bridge opt-in' @{ParentProcess=$badParent}
$badParent=[pscustomobject]@{Name='powershell.exe';ProcessId=121;CreationDate=$parent.CreationDate;ExecutablePath=$exe;CommandLine=('"'+$exe+'" '+$expectedArgs+' -EncodedCommand AAAA')}
MustReject 'trailing injected argument' @{ParentProcess=$badParent}
$badParent=[pscustomobject]@{Name='powershell.exe';ProcessId=121;CreationDate=$parent.CreationDate;ExecutablePath=$exe;CommandLine=('"'+$exe+'" '+$expectedArgs.Replace($supervisorPath,'C:\other\vaulter-relay-bounded-supervisor.ps1'))}
MustReject 'other PowerShell parent' @{ParentProcess=$badParent}
$badParent=[pscustomobject]@{Name='powershell.exe';ProcessId=121;CreationDate=$parent.CreationDate;ExecutablePath='C:\untrusted\powershell.exe';CommandLine=$parent.CommandLine}
MustReject 'untrusted parent executable' @{ParentProcess=$badParent}
$badParent=[pscustomobject]@{Name='powershell.exe';ProcessId=121;CreationDate=([datetime]'2026-10-10T11:00:00Z');ExecutablePath=$exe;CommandLine=$parent.CommandLine}
MustReject 'future parent creation' @{ParentProcess=$badParent}
$badSelf=[pscustomobject]@{Name='powershell.exe';ProcessId=122;ParentProcessId=121;CreationDate=$self.CreationDate;ExecutablePath=$exe;CommandLine=('"'+$exe+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\untrusted\vaulter-relay-bridge-launcher.ps1" -Serve -Supervised')}
MustReject 'untrusted native script' @{SelfProcess=$badSelf}
$badTask=[pscustomobject]@{State='Ready';Settings=$task.Settings;Actions=$task.Actions}
MustReject 'task not running' @{Task=$badTask}
$badTask=[pscustomobject]@{State='Running';Settings=[pscustomobject]@{Enabled=$false;MultipleInstances='IgnoreNew'};Actions=$task.Actions}
MustReject 'disabled task' @{Task=$badTask}
$badTask=[pscustomobject]@{State='Running';Settings=$task.Settings;Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments=$expectedArgs.Replace(' -Bridge','');WorkingDirectory='C:\trusted'})}
MustReject 'wrong registered action' @{Task=$badTask}
MustReject 'drifted retry settings' @{CurrentTaskXml=$new.Replace('<Count>10</Count>','<Count>99</Count>')}
MustReject 'untrusted original executable' @{OriginalTaskXml=$old.Replace('powershell.exe','cmd.exe')}
MustReject 'wrong working directory' @{CurrentTaskXml=$new.Replace('<WorkingDirectory>C:\trusted</WorkingDirectory>','<WorkingDirectory>C:\other</WorkingDirectory>')}
Write-Output 'VAULTER SUPERVISED BRIDGE PARENT CONTRACT PASS'
