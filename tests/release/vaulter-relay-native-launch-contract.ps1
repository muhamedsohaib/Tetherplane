# Native boundary verification using a real isolated child; no live task calls.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$source=(Resolve-Path (Join-Path $PSScriptRoot '../../scripts/vaulter-relay-bounded-supervisor.ps1')).Path
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Supervisor parse failure'}
foreach($definition in $ast.EndBlock.Statements){
  if($definition -is [Management.Automation.Language.FunctionDefinitionAst]){
    Invoke-Expression $definition.Extent.Text
  }
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-native-launch-'+[guid]::NewGuid().ToString('N'))
$previous=[Environment]::GetEnvironmentVariable('TETHERPLANE_CONTRACT_CANARY','Process')
$null=New-Item -ItemType Directory -Path $root
try{
  $working=Join-Path $root 'working with spaces'
  $null=New-Item -ItemType Directory -Path $working
  $child=Join-Path $root 'child with spaces.ps1'
  $output=Join-Path $root 'observed.json'
  [IO.File]::WriteAllText($child,@'
param([string]$Value,[string]$Output)
$data=@{cwd=[Environment]::CurrentDirectory;value=$Value;canary=$env:TETHERPLANE_CONTRACT_CANARY}
[IO.File]::WriteAllText($Output,($data|ConvertTo-Json -Compress))
exit 37
'@)
  [Environment]::SetEnvironmentVariable('TETHERPLANE_CONTRACT_CANARY','synthetic-inherited-value','Process')
  $action=[pscustomobject]@{
    Executable='powershell.exe'
    Arguments='-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "'+$child+'" -Value "literal & $(never) with spaces" -Output "'+$output+'"'
    WorkingDirectory=$working
  }
  $result=Start-VerifiedOriginalRelayChild -Action $action
  $observed=[IO.File]::ReadAllText($output)|ConvertFrom-Json
  if($result.ExitCode -ne 37 -or $result.DurationSeconds -lt 0){throw 'Native exit status lost'}
  if($observed.cwd -cne $working){throw 'Native working directory changed'}
  if($observed.value -cne 'literal & $(never) with spaces'){throw 'Raw argv quoting changed'}
  if($observed.canary -cne 'synthetic-inherited-value'){throw 'Process environment not inherited'}
  $failureOutput=Join-Path $root 'must-not-exist.json'
  $action.Arguments=$action.Arguments.Replace($output,$failureOutput)
  $action.WorkingDirectory=Join-Path $root 'absent-directory'
  $failure=''
  try{Start-VerifiedOriginalRelayChild -Action $action|Out-Null}catch{$failure=$_.Exception.Message}
  if($failure -notmatch 'contained creation failed' -or (Test-Path -LiteralPath $failureOutput)){
    throw 'Failed native launch must throw without an uncontained fallback'
  }
  if($failure.Contains('$(never)') -or $failure.Contains($root)){
    throw 'Native error must not disclose action arguments'
  }
  Write-Output 'NATIVE LAUNCH PASS: cwd, literal argv, inherited environment, exit code, fail-closed creation'
}finally{
  [Environment]::SetEnvironmentVariable('TETHERPLANE_CONTRACT_CANARY',$previous,'Process')
  $resolved=[IO.Path]::GetFullPath($root)
  $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
  if(-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or
     [IO.Path]::GetFileName($resolved) -notmatch '^tetherplane-native-launch-[a-f0-9]{32}$'){throw 'Unsafe fixture cleanup path'}
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
