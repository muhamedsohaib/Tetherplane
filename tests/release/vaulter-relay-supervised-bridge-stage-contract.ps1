# Synthetic original supervisor snapshot and candidate safety contract.
# Never accesses Vaulter tasks, credentials, or live services.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-supervised-bridge-handover.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $path).Path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'Handover PowerShell parse errors.'}
foreach($name in @('Require','Get-OriginalAction','Assert-BridgeCandidate')){
  $fn=$ast.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ceq $name
  }.GetNewClosure(),$true)
  if($null -eq $fn){throw "Required helper missing: $name"}
  Invoke-Expression $fn.Extent.Text
}
$script:OriginalSupervisor='C:\protected\relay-supervisor\vaulter-relay-bounded-supervisor.ps1'
$expected='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script:OriginalSupervisor+'" -Serve'
$script:BaselineXml='<Task><Actions><Exec><Command>powershell.exe</Command><Arguments>'+
  [Security.SecurityElement]::Escape($expected)+
  '</Arguments><WorkingDirectory>C:\trusted</WorkingDirectory></Exec></Actions></Task>'
$action=Get-OriginalAction
if([string]$action.Execute -cne 'powershell.exe' -or
  [string]$action.Arguments -cne $expected -or
  [string]$action.WorkingDirectory -cne 'C:\trusted'){
  throw 'Original supervised Auth0 task action was not reconstructed exactly.'
}
$script:BaselineXml=$script:BaselineXml.Replace(' -Serve</Arguments>',' -Serve -Bridge</Arguments>')
$rejected=$false
try{Get-OriginalAction | Out-Null}catch{$rejected=$true}
if(-not $rejected){throw 'Bridge task action cannot be accepted as the Auth0 rollback target.'}
$script:BaselineXml=$script:BaselineXml.Replace(' -Serve -Bridge</Arguments>',' -File original-unsupervised.ps1</Arguments>')
$rejected=$false
try{Get-OriginalAction | Out-Null}catch{$rejected=$true}
if(-not $rejected){throw 'Unsupervised original launcher cannot be accepted as rollback target.'}
$root=Join-Path ([IO.Path]::GetTempPath()) ('bridge-stage-fixture-'+[Guid]::NewGuid().ToString('N'))
try{
  New-Item -ItemType Directory -Path $root -ErrorAction Stop|Out-Null
  $candidate=Join-Path $root 'candidate.json'
  $baseline=Join-Path $root 'baseline.json'
  [IO.File]::WriteAllText($candidate,'{"oidc":{"issuer":"https://tetherplane-dev.eu.auth0.com/","audience":"https://vaulter.tailf65eba.ts.net/mcp","bindings":[{"subject":"test"}]},"deviceLoginBridge":{"tokenEnv":"TETHERPLANE_AUTH_BRIDGE_TOKEN"}}')
  [IO.File]::WriteAllText($baseline,'{"oidc":{"issuer":"https://tetherplane-dev.eu.auth0.com/","audience":"https://vaulter.tailf65eba.ts.net/mcp","bindings":[{"subject":"test"}]}}')
  Assert-BridgeCandidate $candidate $baseline
  $bad=[IO.File]::ReadAllText($candidate)
  [IO.File]::WriteAllText($candidate,$bad.Replace('tetherplane-dev.eu.auth0.com','untrusted.example.com'))
  $rejected=$false
  try{Assert-BridgeCandidate $candidate $baseline}catch{$rejected=$true}
  if(-not $rejected){throw 'Different issuer accepted by bridge stage.'}
  [IO.File]::WriteAllText($candidate,$bad.Replace('TETHERPLANE_AUTH_BRIDGE_TOKEN','OTHER_VARIABLE'))
  $rejected=$false
  try{Assert-BridgeCandidate $candidate $baseline}catch{$rejected=$true}
  if(-not $rejected){throw 'Untrusted bridge credential variable accepted.'}
  Write-Output 'VAULTER BRIDGE STAGING BASELINE CONTRACT PASS'
}finally{Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}
