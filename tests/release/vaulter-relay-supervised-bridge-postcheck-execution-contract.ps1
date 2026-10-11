# Postcheck is invoked in an isolated, per-process policy-scoped Windows PowerShell.
# This is entirely synthetic: no Vaulter task or network endpoint is contacted.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourcePath=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervised-bridge-handover.ps1'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $sourcePath).Path,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){throw 'Bridge handover PowerShell parser rejected source.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $sourcePath).Path)
if($source -notmatch 'Invoke-PinnedPostcheck' -or
   $source -notmatch '(?i)-ExecutionPolicy\s+Bypass' -or
   $source -notmatch '(?i)-NonInteractive' -or
   $source -match '\$null\s*=\s*&\s*\$script:Postcheck' -or
   $source -match '^\s*&\s*\$script:Postcheck' ){
  throw 'RED: protected postcheck still executes under the machine-restricted caller policy.'
}
$helper=$ast.Find({
  param($n)
  $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $n.Name -eq 'Invoke-PinnedPostcheck'
},$true)
if($null -eq $helper){throw 'RED: isolated postcheck execution helper absent.'}
Invoke-Expression $helper.Extent.Text
$dir=Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-postcheck-exec-'+[guid]::NewGuid().ToString('N'))
try{
  New-Item -ItemType Directory -Path $dir -ErrorAction Stop|Out-Null
  $okScript=Join-Path $dir 'ok.ps1'
  $badScript=Join-Path $dir 'exit37.ps1'
  $marker=Join-Path $dir 'ran.txt'
  $escaped=$marker.Replace("'","''")
  [IO.File]::WriteAllText($okScript,('[IO.File]::WriteAllText('''+$escaped+''',''ok'');exit 0'))
  [IO.File]::WriteAllText($badScript,'exit 37')
  $oldPolicy=Get-ExecutionPolicy -Scope Process
  Invoke-PinnedPostcheck -Path $okScript
  if(-not(Test-Path -LiteralPath $marker -PathType Leaf)){throw 'Child postcheck did not actually execute.'}
  if((Get-ExecutionPolicy -Scope Process) -cne $oldPolicy){throw 'Caller execution policy was modified.'}
  $failure=''
  try{Invoke-PinnedPostcheck -Path $badScript}catch{$failure=$_.Exception.Message}
  if($failure -notmatch 'postcheck' -or $failure -notmatch '37'){throw 'Postcheck nonzero exit was not rejected.'}
  $failure=''
  try{Invoke-PinnedPostcheck -Path (Join-Path $dir 'missing.ps1')}catch{$failure=$_.Exception.Message}
  if(-not $failure){throw 'Missing postcheck was not rejected.'}
  # Expected failing native-child fixture must not poison the CI step exit status.
  $global:LASTEXITCODE=0
  Write-Output 'VAULTER BRIDGE ISOLATED POSTCHECK EXECUTION CONTRACT PASS'
}finally{
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}
