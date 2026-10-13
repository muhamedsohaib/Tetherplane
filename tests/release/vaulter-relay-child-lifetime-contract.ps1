# Isolated real process-tree regression; never evaluate the live entrypoint.
param([string]$HostExecutable=(Get-Process -Id $PID).Path,[ValidateSet('stop','exit')][string[]]$Modes=@('stop','exit'))
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$source=(Resolve-Path (Join-Path $PSScriptRoot '../../scripts/vaulter-relay-bounded-supervisor.ps1')).Path
$root=Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-child-lifetime-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
$owned=New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
function Start-Fixture([string]$Path,[string]$Arguments=''){
  $psi=New-Object Diagnostics.ProcessStartInfo
  $psi.FileName=$HostExecutable
  $psi.Arguments='-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "'+$Path+'" '+$Arguments
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $process=[Diagnostics.Process]::Start($psi)
  $owned.Add($process)
  return $process
}
function Wait-File([string]$Path){
  $deadline=[datetime]::UtcNow.AddSeconds(20)
  while(-not(Test-Path -LiteralPath $Path)){
    if([datetime]::UtcNow -gt $deadline){throw 'Fixture startup deadline exceeded'}
    Start-Sleep -Milliseconds 100
  }
}
try{
  $leaf=Join-Path $root 'leaf.ps1'
  [IO.File]::WriteAllText($leaf,(@(
    'param([string]$Ready)'
    '[IO.File]::WriteAllText($Ready,[string]$PID)'
    'Start-Sleep -Seconds 60'
  ) -join [Environment]::NewLine))
  $launcher=Join-Path $root 'launcher.ps1'
  [IO.File]::WriteAllText($launcher,(@(
    'param([string]$Leaf,[string]$Ready,[string]$LauncherReady,[string]$Mode)'
    '[IO.File]::WriteAllText($LauncherReady,[string]$PID)'
    '$psi=New-Object Diagnostics.ProcessStartInfo'
    '$psi.FileName=Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"'
    '$psi.Arguments=''-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "''+$Leaf+''" -Ready "''+$Ready+''"'''
    '$psi.UseShellExecute=$false'
    '$psi.CreateNoWindow=$true'
    '$child=[Diagnostics.Process]::Start($psi)'
    'if($Mode -eq "exit"){'
    '  $deadline=[datetime]::UtcNow.AddSeconds(15)'
    '  while(-not(Test-Path -LiteralPath $Ready)){'
    '    if([datetime]::UtcNow -gt $deadline){exit 98}'
    '    Start-Sleep -Milliseconds 100'
    '  }'
    '  exit 37'
    '}'
    '$child.WaitForExit()'
  ) -join [Environment]::NewLine))
  $harness=Join-Path $root 'supervisor.ps1'
  [IO.File]::WriteAllText($harness,(@(
    'param([string]$Source,[string]$Launcher,[string]$Leaf,[string]$Ready,[string]$LauncherReady,[string]$Mode,[string]$Result)'
    '$ErrorActionPreference="Stop"'
    '$tokens=$null;$errors=$null'
    '$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)'
    'if($errors.Count){throw "Source parse failed"}'
    'foreach($definition in $ast.EndBlock.Statements){'
    '  if($definition -is [Management.Automation.Language.FunctionDefinitionAst]){'
    '    Invoke-Expression $definition.Extent.Text'
    '  }'
    '}'
    '$action=[pscustomobject]@{Executable="powershell.exe";Arguments=''-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "''+$Launcher+''" -Leaf "''+$Leaf+''" -Ready "''+$Ready+''" -LauncherReady "''+$LauncherReady+''" -Mode ''+$Mode}'
    '$resultObject=Start-VerifiedOriginalRelayChild -Action $action'
    '[IO.File]::WriteAllText($Result,[string]$resultObject.ExitCode)'
  ) -join [Environment]::NewLine))
  $controlReady=Join-Path $root 'control.txt'
  $control=Start-Fixture $leaf ('-Ready "'+$controlReady+'"')
  Wait-File $controlReady
  foreach($mode in $Modes){
    $ready=Join-Path $root ($mode+'-leaf.txt')
    $launcherReady=Join-Path $root ($mode+'-launcher.txt')
    $result=Join-Path $root ($mode+'-result.txt')
    $arguments='-Source "'+$source+'" -Launcher "'+$launcher+'" -Leaf "'+$leaf+'" -Ready "'+$ready+'" -LauncherReady "'+$launcherReady+'" -Mode '+$mode+' -Result "'+$result+'"'
    $supervisor=Start-Fixture $harness $arguments
    Wait-File $ready
    Wait-File $launcherReady
    $childPid=[int][IO.File]::ReadAllText($ready)
    $launcherPid=[int][IO.File]::ReadAllText($launcherReady)
    $descendants=New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
    foreach($fixturePid in @($launcherPid,$childPid)){
      $fixture=Get-Process -Id $fixturePid -ErrorAction SilentlyContinue
      if($null -ne $fixture){
        if($fixture.StartTime -lt $supervisor.StartTime){throw 'Fixture PID identity mismatch'}
        $cim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$fixturePid)
        if($fixture.HasExited){$fixture.Dispose();continue}
        if(([string]$cim.CommandLine).IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'Fixture path identity mismatch'}
        $owned.Add($fixture)
        $descendants.Add($fixture)
      }
    }
    if($mode -eq 'stop'){
      if($descendants.Count -ne 2){throw 'Stop fixture must prove both descendants alive first'}
      $supervisor.Kill()
      $null=$supervisor.WaitForExit(5000)
    }else{
      Wait-File $result
      if([IO.File]::ReadAllText($result) -cne '37'){throw 'Child exit code not preserved'}
    }
    $deadline=[datetime]::UtcNow.AddSeconds(5)
    do{
      $survivors=@($descendants | Where-Object {-not $_.HasExited})
      if($survivors.Count -eq 0){break}
      Start-Sleep -Milliseconds 100
    }while([datetime]::UtcNow -lt $deadline)
    if($control.HasExited){throw 'Unrelated fixture was terminated'}
    if($survivors.Count -gt 0){throw ('RED: '+$mode+' left owned launcher/descendant alive after supervisor lifetime ended.')}
    Write-Output ('CHILD LIFETIME PASS: '+$mode+'; unrelated fixture preserved')
  }
}finally{
  foreach($process in $owned){
    if(-not $process.HasExited){$process.Kill();$null=$process.WaitForExit(5000)}
    $process.Dispose()
  }
  $resolved=[IO.Path]::GetFullPath($root)
  $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
  if(-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or
     [IO.Path]::GetFileName($resolved) -notmatch '^tetherplane-child-lifetime-[a-f0-9]{32}$'){throw 'Unsafe fixture cleanup path'}
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

