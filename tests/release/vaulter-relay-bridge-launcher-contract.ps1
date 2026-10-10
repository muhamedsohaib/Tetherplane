# Source-level security contract for the sole production Vaulter bridge runner.
# Native subprocess behavior is exercised in vaulter-relay-bridge-native-contract.ps1.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$wrapper = Join-Path $PSScriptRoot '..\..\scripts\vaulter-relay-bridge-launcher.ps1'
if(-not (Test-Path -LiteralPath $wrapper -PathType Leaf)) { throw 'Wrapper absent.' }
$tokens=$null
$errorsFound=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $wrapper).Path,[ref]$tokens,[ref]$errorsFound)
if(@($errorsFound).Count -ne 0){throw 'Wrapper PowerShell parse failed.'}
$functions=@($ast.FindAll({
    param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst]
},$true) | ForEach-Object {$_.Name})
if($functions -contains 'Invoke-VerifiedRelayBridgeLauncher'){
    throw 'RED: ambiguous legacy launcher execution remains; the bridge config is not guaranteed to reach Node.'
}
if(@($functions | Where-Object {$_ -eq 'Invoke-VerifiedNativeRelayProcess'}).Count -ne 1){
    throw 'Missing single canonical native relay launch function.'
}
$names=@($ast.FindAll({
    param($n)
    $n -is [System.Management.Automation.Language.CommandAst]
},$true) | ForEach-Object {$_.GetCommandName()})
foreach($forbidden in @('Start-Process','Stop-Process','Set-ScheduledTask',
  'Start-ScheduledTask','Stop-ScheduledTask','Register-ScheduledTask',
  'Unregister-ScheduledTask','Invoke-Expression','Write-Host')){
    if($names -contains $forbidden){throw "Forbidden launcher command: $forbidden"}
}
$source=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $wrapper).Path)
foreach($required in @('Invoke-VerifiedNativeRelayProcess',
  'TETHERPLANE_AUTH_BRIDGE_TOKEN','deviceLoginBridge','bridge-token.secret',
  'AreAccessRulesProtected','Get-FileHash','ExpectedEntrypointSha256',
  'NodeExecutablePath','RelayEntrypointPath','StateFilePath',
  '--auth-config','--state-file','--allow-insecure-localhost',
  '127.0.0.1','8788','finally','Get-NetTCPConnection',
  'Get-ScheduledTask','-Serve:$Serve','No service started')){
    if($source.IndexOf($required,[StringComparison]::OrdinalIgnoreCase) -lt 0){
      throw "Missing required native relay guard: $required"
    }
}
if($source -match '(?i)gh auth token|funnel\s+reset|Stop-Process\s+-Name|Set-Clipboard'){
    throw 'Unsafe side effect in bridge launcher.'
}
Write-Output 'VAULTER RELAY BRIDGE SECURITY CONTRACT PASS'
