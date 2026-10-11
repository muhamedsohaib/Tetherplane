# RED/GREEN: script-level variables may not overwrite protected manifest paths.
# Uses synthetic files only. Does not inspect Vaulter or execute a task.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourcePath=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervised-bridge-handover.ps1'
$tokens=$null;$parseErrors=$null
$resolved=(Resolve-Path -LiteralPath $sourcePath).Path
$ast=[Management.Automation.Language.Parser]::ParseFile($resolved,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){throw 'Protected bridge handover source does not parse.'}
$scriptNames=@{}
$bareNames=@{}
$assignments=@($ast.FindAll({
  param($n)
  $n -is [Management.Automation.Language.AssignmentStatementAst]
},$true))
foreach($assignment in $assignments){
  $ancestor=$assignment.Parent
  $inFunction=$false
  while($null -ne $ancestor){
    if($ancestor -is [Management.Automation.Language.FunctionDefinitionAst]){
      $inFunction=$true;break
    }
    $ancestor=$ancestor.Parent
  }
  if($inFunction){continue}
  $lhs=$assignment.Left.Extent.Text.Trim()
  $scoped=[regex]::Match($lhs,'(?i)^\$script:([a-z_][a-z_0-9]*)$')
  $bare=[regex]::Match($lhs,'(?i)^\$([a-z_][a-z_0-9]*)$')
  if($scoped.Success){$scriptNames[$scoped.Groups[1].Value]=$assignment.Extent.StartLineNumber}
  elseif($bare.Success){$bareNames[$bare.Groups[1].Value]=$assignment.Extent.StartLineNumber}
}
foreach($name in $scriptNames.Keys){
  if($bareNames.ContainsKey($name)){
    throw ('RED: top-level assignment $'+$name+' collides with $script:'+$name+
      ' (case-insensitive PowerShell scope).')
  }
}
$source=[IO.File]::ReadAllText($resolved)
if($source -match '(?i)\$script:Manifest\b'){
  throw 'RED: manifest file path uses the ambiguous Manifest variable.'
}
foreach($expected in @('$script:ManifestPath','[IO.File]::WriteAllText($script:ManifestPath',
   'Get-Content -LiteralPath $script:ManifestPath')){
  if(-not $source.Contains($expected)){throw "Protected manifest path is not used consistently: $expected"}
}
# Exercise the ACTUAL script path assignment and write statement in a synthetic directory.
$pathAssignment=@($source -split '\r?\n' | Where-Object {
  $_ -match '^\s*\$script:ManifestPath=Join-Path \$script:StageDir ''manifest.json''\s*$'
})
$writeStatement=@($source -split '\r?\n' | Where-Object {
  $_ -match '^\s*\[IO\.File\]::WriteAllText\(\$script:ManifestPath,\[string\]\$stageManifestJson,'
})
if($pathAssignment.Count -ne 1 -or $writeStatement.Count -ne 1){
  throw 'Manifest path declaration or exact writer was not recognized.'
}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-manifest-scope-'+[Guid]::NewGuid().ToString('N'))
try{
  New-Item -ItemType Directory -Path $temp -ErrorAction Stop | Out-Null
  $script:StageDir=$temp
  Invoke-Expression $pathAssignment[0]
  $originalPath=Join-Path $temp 'manifest.json'
  $stageManifestJson='{"ReviewedCommit":"synthetic","TaskSha256":"not-a-secret"}'
  Invoke-Expression $writeStatement[0]
  if(-not(Test-Path -LiteralPath $originalPath -PathType Leaf)){
    throw 'Manifest bytes were not written to the requested protected path.'
  }
  if($script:ManifestPath -cne $originalPath){throw 'Protected manifest path was overwritten by JSON.'}
  $stagedManifestData=Get-Content -LiteralPath $script:ManifestPath -Raw | ConvertFrom-Json
  if($stagedManifestData.ReviewedCommit -cne 'synthetic' -or
    $script:ManifestPath -cne $originalPath){
    throw 'Manifest read corrupted the protected path or returned wrong contents.'
  }
  Write-Output 'VAULTER BRIDGE MANIFEST SCOPE CONTRACT PASS'
}finally{
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
