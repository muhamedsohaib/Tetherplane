# Verified bridge child action; no credentials, task edits or live process actions.
function Get-VerifiedBridgeChildAction {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$StageDirectory,[string]$WorkingDirectory='')
  if(-not(Test-Path -LiteralPath $StageDirectory -PathType Container) -or
    (Get-Item -LiteralPath $StageDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
    -not (Get-Acl -LiteralPath $StageDirectory).AreAccessRulesProtected){
    throw 'Private bridge stage unavailable or unprotected.'
  }
  $launcher=Join-Path $StageDirectory 'vaulter-relay-bridge-launcher.ps1'
  $helper=Join-Path $StageDirectory 'vaulter-relay-supervised-bridge-child.ps1'
  $config=Join-Path $StageDirectory 'bridge-child.json'
  $manifestPath=Join-Path $StageDirectory 'manifest.json'
  foreach($file in @($launcher,$helper,$config,$manifestPath)){
    if(-not(Test-Path -LiteralPath $file -PathType Leaf) -or
      (Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
      throw 'Bridge source file missing or untrusted.'
    }
  }
  $manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -ErrorAction Stop
  foreach($pair in @(@($launcher,'BridgeLauncherSha256'),@($helper,'BridgeHelperSha256'),@($config,'BridgeConfigSha256'))){
    $digest=[string]$manifest.($pair[1])
    if($digest -notmatch '^[0-9A-Fa-f]{64}$' -or
      (Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -cne $digest.ToUpperInvariant()){
      throw 'Protected bridge file digest mismatch.'
    }
  }
  $c=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json -ErrorAction Stop
  foreach($key in @('NodeExecutablePath','NodeExecutableSha256','RelayEntrypointPath',
    'ExpectedEntrypointSha256','AuthConfigPath','BaselineAuthConfigPath','StateFilePath')){
    if($null -eq $c.PSObject.Properties[$key] -or
      [string]::IsNullOrWhiteSpace([string]$c.$key)){throw 'Incomplete bridge child configuration.'}
  }
  foreach($key in @('NodeExecutablePath','RelayEntrypointPath','AuthConfigPath',
    'BaselineAuthConfigPath','StateFilePath')){
    $path=[string]$c.$key
    if(-not [IO.Path]::IsPathRooted($path) -or
      -not(Test-Path -LiteralPath $path -PathType Leaf) -or
      (Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
      throw 'Untrusted bridge runtime path.'
    }
  }
  if([IO.Path]::GetFileName([string]$c.NodeExecutablePath) -ine 'node.exe'){
    throw 'Untrusted Node executable name.'
  }
  foreach($pair in @(@([string]$c.NodeExecutablePath,[string]$c.NodeExecutableSha256),
    @([string]$c.RelayEntrypointPath,[string]$c.ExpectedEntrypointSha256))){
    if($pair[1] -notmatch '^[0-9A-Fa-f]{64}$' -or
      (Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -cne $pair[1].ToUpperInvariant()){
      throw 'Bridge Node executable or CLI hash mismatch.'
    }
  }
  if(-not [string]::IsNullOrWhiteSpace($WorkingDirectory) -and
    -not [IO.Path]::IsPathRooted($WorkingDirectory)){throw 'Working directory must be absolute.'}
  $values=@($launcher,[string]$c.NodeExecutablePath,[string]$c.RelayEntrypointPath,
    [string]$c.AuthConfigPath,[string]$c.BaselineAuthConfigPath,[string]$c.StateFilePath)
  foreach($value in $values){if($value -match '["\r\n]'){throw 'Unsafe bridge action path.'}}
  $trusted=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if(-not(Test-Path -LiteralPath $trusted -PathType Leaf)){throw 'Windows PowerShell missing.'}
  $args='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$launcher+'" -Serve -Supervised'
  $args+=' -NodeExecutablePath "'+[string]$c.NodeExecutablePath+'"'
  $args+=' -RelayEntrypointPath "'+[string]$c.RelayEntrypointPath+'"'
  $args+=' -ExpectedEntrypointSha256 '+[string]$c.ExpectedEntrypointSha256
  $args+=' -AuthConfigPath "'+[string]$c.AuthConfigPath+'"'
  $args+=' -BaselineAuthConfigPath "'+[string]$c.BaselineAuthConfigPath+'"'
  $args+=' -StateFilePath "'+[string]$c.StateFilePath+'"'
  return [pscustomobject]@{Executable=$trusted;Arguments=$args;WorkingDirectory=$WorkingDirectory}
}
