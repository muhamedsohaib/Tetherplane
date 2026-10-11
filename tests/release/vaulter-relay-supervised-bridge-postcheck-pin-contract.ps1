# Independent postcheck must be verified BEFORE execution from review repo.
# No Vaulter task, auth or production process is invoked.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourcePath=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervised-bridge-handover.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $sourcePath).Path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'Bridge handover parse failure.'}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $sourcePath).Path)
foreach($token in @('Assert-PinnedPostcheck','PostcheckSha256','RunnerIntegritySha256','Get-FileHash')){
  if(-not $source.Contains($token)){throw "RED: protected postcheck pin missing: $token"}
}
$verifyIndex=$source.IndexOf('Assert-PinnedPostcheck -RepoRoot',[StringComparison]::Ordinal)
$invokeIndex=$source.IndexOf('Invoke-PinnedPostcheck -Path $script:Postcheck',[StringComparison]::Ordinal)
if($verifyIndex -lt 0 -or $invokeIndex -lt 0 -or $verifyIndex -ge $invokeIndex){
  throw 'RED: postcheck can run before source hash validation.'
}
foreach($name in @('Require','Assert-FileHash','Assert-PinnedPostcheck')){
  $fn=$ast.Find({
    param($n)
    $n -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $n.Name -ceq $name
  }.GetNewClosure(),$true)
  if($null -eq $fn){throw "RED: missing postcheck validation helper $name"}
  Invoke-Expression $fn.Extent.Text
}
$repo=Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-postcheck-pin-'+[Guid]::NewGuid().ToString('N'))
$folder=Join-Path $repo 'scripts'
try{
  New-Item -ItemType Directory -Path $folder -Force -ErrorAction Stop | Out-Null
  $postcheck=Join-Path $folder 'vaulter-tether-auth-supervised-postcheck.ps1'
  $runner=Join-Path $folder 'vaulter-tether-auth-runner-integrity.ps1'
  [IO.File]::WriteAllText($postcheck,'# synthetic postcheck; never executed')
  [IO.File]::WriteAllText($runner,'# synthetic validator; never executed')
  $postHash=(Get-FileHash -LiteralPath $postcheck -Algorithm SHA256).Hash
  $runnerHash=(Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash
  $path=Assert-PinnedPostcheck -RepoRoot $repo -ExpectedPostcheckSha256 $postHash -ExpectedRunnerIntegritySha256 $runnerHash
  if($path -cne $postcheck){throw 'Verified independent postcheck did not return its exact source path.'}
  [IO.File]::AppendAllText($postcheck,'# changed')
  $rejected=$false
  try{Assert-PinnedPostcheck -RepoRoot $repo -ExpectedPostcheckSha256 $postHash -ExpectedRunnerIntegritySha256 $runnerHash|Out-Null}catch{$rejected=$true}
  if(-not $rejected){throw 'Changed postcheck executed without pinned hash.'}
  [IO.File]::WriteAllText($postcheck,'# synthetic postcheck; never executed')
  [IO.File]::AppendAllText($runner,'# changed')
  $rejected=$false
  try{Assert-PinnedPostcheck -RepoRoot $repo -ExpectedPostcheckSha256 $postHash -ExpectedRunnerIntegritySha256 $runnerHash|Out-Null}catch{$rejected=$true}
  if(-not $rejected){throw 'Changed postcheck dependency accepted.'}
  Write-Output 'VAULTER BRIDGE POSTCHECK PIN CONTRACT PASS'
}finally{Remove-Item -LiteralPath $repo -Recurse -Force -ErrorAction SilentlyContinue}
