# RED/GREEN: supervised bridge child action must be source-pinned and secret-free.
# Synthetic fixtures only. No relay task or Vaulter services are contacted.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=Join-Path $PSScriptRoot '..\..'
$helper=Join-Path $root 'scripts\vaulter-relay-supervised-bridge-child.ps1'
$supervisor=Join-Path $root 'scripts\vaulter-relay-bounded-supervisor.ps1'
if(-not(Test-Path -LiteralPath $helper -PathType Leaf)){throw 'RED: protected supervised bridge child helper absent.'}
$supervisorText=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $supervisor).Path)
foreach($required in @('[switch]$Bridge','Get-VerifiedBridgeChildAction','Start-VerifiedOriginalRelayChild','Invoke-BoundedRelaySupervisor', 'relay-supervisor-bridge')){
  if(-not $supervisorText.Contains($required)){throw "RED: supervisor integration missing $required"}
}
if($supervisorText -match '(?i)bridge-token\.secret|TETHERPLANE_AUTH_BRIDGE_TOKEN'){
  throw 'Supervisor must not load or name credentials.'
}
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $helper).Path,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){throw 'Bridge child helper does not parse.'}
$fn=$ast.Find({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Get-VerifiedBridgeChildAction'
},$true)
if($null -eq $fn){throw 'RED: verified bridge child action function missing.'}
Invoke-Expression $fn.Extent.Text
function MustFail([scriptblock]$action,[string]$why){
  $rejected=$false
  try{& $action | Out-Null}catch{$rejected=$true}
  if(-not $rejected){throw "Unsafe bridge action accepted: $why"}
}
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('tetherplane-bridge-child-'+[Guid]::NewGuid().ToString('N'))
$stage=Join-Path $fixture 'relay-supervisor-bridge'
try{
  New-Item -ItemType Directory -Path $fixture -ErrorAction Stop | Out-Null
  New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
  $acl=Get-Acl -LiteralPath $stage
  $acl.SetAccessRuleProtection($true,$true)
  Set-Acl -LiteralPath $stage -AclObject $acl
  $native=Join-Path $stage 'vaulter-relay-bridge-launcher.ps1'
  $helperInstalled=Join-Path $stage 'vaulter-relay-supervised-bridge-child.ps1'
  $node=Join-Path $fixture 'node.exe'
  $entry=Join-Path $fixture 'cli.js'
  $auth=Join-Path $fixture 'auth-candidate.json'
  $baseline=Join-Path $fixture 'auth-baseline.json'
  $registry=Join-Path $fixture 'registry.json'
  $cfgPath=Join-Path $stage 'bridge-child.json'
  $manifestPath=Join-Path $stage 'manifest.json'
  [IO.File]::WriteAllText($native,'exit 37')
  [IO.File]::WriteAllText($helperInstalled,'# signed helper')
  [IO.File]::WriteAllText($node,'# fake runtime; not executed')
  [IO.File]::WriteAllText($entry,'# fake relay CLI; not executed')
  [IO.File]::WriteAllText($auth,'{"oidc":{"issuer":"https://tetherplane-dev.eu.auth0.com/"}}')
  [IO.File]::WriteAllText($baseline,'{"oidc":{"issuer":"https://tetherplane-dev.eu.auth0.com/"}}')
  [IO.File]::WriteAllText($registry,'{"version":1,"devices":[]}')
  $cfg=[ordered]@{
    NodeExecutablePath=$node
    NodeExecutableSha256=(Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash
    RelayEntrypointPath=$entry
    ExpectedEntrypointSha256=(Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
    AuthConfigPath=$auth
    BaselineAuthConfigPath=$baseline
    StateFilePath=$registry
  }
  [IO.File]::WriteAllText($cfgPath,($cfg | ConvertTo-Json -Compress))
  $manifest=[ordered]@{
    BridgeHelperSha256=(Get-FileHash -LiteralPath $helperInstalled -Algorithm SHA256).Hash
    BridgeLauncherSha256=(Get-FileHash -LiteralPath $native -Algorithm SHA256).Hash
    BridgeConfigSha256=(Get-FileHash -LiteralPath $cfgPath -Algorithm SHA256).Hash
    AuthConfigSha256=(Get-FileHash -LiteralPath $auth -Algorithm SHA256).Hash
    BaselineAuthConfigSha256=(Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash
  }
  [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Compress))
  $action=Get-VerifiedBridgeChildAction -StageDirectory $stage -WorkingDirectory $fixture
  if($action.Executable -ine (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -or
    $action.WorkingDirectory -cne $fixture -or
    $action.Arguments -notmatch '(?i)-File\s+"[^"]+vaulter-relay-bridge-launcher\.ps1"\s+-Serve\s+-Supervised\s+' -or
    $action.Arguments -notmatch '(?i)--?NodeExecutablePath' -or
    $action.Arguments -notmatch '(?i)--?ExpectedEntrypointSha256' -or
    $action.Arguments -notmatch '(?i)--?StateFilePath' -or
    $action.Arguments -match 'TETHERPLANE_AUTH_BRIDGE_TOKEN|bridge-token\.secret'){
    throw 'Bridge supervised child action lost trusted executable, arguments, working directory or secret isolation.'
  }
  $child=New-Object System.Diagnostics.Process
  $child.StartInfo.FileName=$action.Executable
  $child.StartInfo.Arguments=$action.Arguments
  $child.StartInfo.WorkingDirectory=$action.WorkingDirectory
  $child.StartInfo.UseShellExecute=$false
  $child.StartInfo.CreateNoWindow=$true
  try{
    if(-not $child.Start()){throw 'Synthetic bridge child did not launch.'}
    $child.WaitForExit()
    if($child.ExitCode -ne 37){throw 'Bridge child did not propagate the real child exit code.'}
  }finally{$child.Dispose()}
  $originalCandidate=[IO.File]::ReadAllText($auth)
  [IO.File]::WriteAllText($auth,$originalCandidate.Replace('"subject":"fixture"','"subject":"unauthorized"'))
  MustFail {Get-VerifiedBridgeChildAction -StageDirectory $stage -WorkingDirectory $fixture} 'changed Auth0 candidate file'
  [IO.File]::WriteAllText($auth,$originalCandidate)
  $originalBaseline=[IO.File]::ReadAllText($baseline)
  [IO.File]::WriteAllText($baseline,$originalBaseline.Replace('"subject":"fixture"','"subject":"unauthorized"'))
  MustFail {Get-VerifiedBridgeChildAction -StageDirectory $stage -WorkingDirectory $fixture} 'changed original Auth0 baseline file'
  [IO.File]::WriteAllText($baseline,$originalBaseline)
  $save=[IO.File]::ReadAllText($cfgPath)
  [IO.File]::AppendAllText($cfgPath,' ')
  MustFail {Get-VerifiedBridgeChildAction -StageDirectory $stage -WorkingDirectory $fixture} 'tampered config'
  [IO.File]::WriteAllText($cfgPath,$save)
  [IO.File]::AppendAllText($native,'tamper')
  MustFail {Get-VerifiedBridgeChildAction -StageDirectory $stage -WorkingDirectory $fixture} 'tampered launcher'
  [IO.File]::WriteAllText($native,'exit 37')
  $save=[IO.File]::ReadAllText($node)
  [IO.File]::AppendAllText($node,'tamper')
  MustFail {Get-VerifiedBridgeChildAction -StageDirectory $stage -WorkingDirectory $fixture} 'tampered node runtime'
  [IO.File]::WriteAllText($node,$save)
  $badCfg=[ordered]@{}; foreach($key in $cfg.Keys){$badCfg[$key]=$cfg[$key]}
  $badCfg.NodeExecutablePath='.\node.exe'
  [IO.File]::WriteAllText($cfgPath,($badCfg | ConvertTo-Json -Compress))
  $manifest.BridgeConfigSha256=(Get-FileHash -LiteralPath $cfgPath -Algorithm SHA256).Hash
  [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Compress))
  MustFail {Get-VerifiedBridgeChildAction -StageDirectory $stage -WorkingDirectory $fixture} 'relative node runtime path'
  Write-Output 'VAULTER SUPERVISED BRIDGE CHILD CONTRACT PASS'
}finally{
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
