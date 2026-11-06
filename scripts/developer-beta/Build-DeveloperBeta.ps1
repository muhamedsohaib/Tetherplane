[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$OutputPath,
 [Parameter(Mandatory=$true)][string]$NodeLicenseFile,
 [string]$PublicRelayUrl = '',
 [string]$NodeExecutable = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$dest=[IO.Path]::GetFullPath($OutputPath)
if(Test-Path -LiteralPath $dest){throw 'BETA_BUILD_REFUSES_EXISTING_DESTINATION'}
$parent=Split-Path -Parent $dest
if(-not(Test-Path -LiteralPath $parent -PathType Container)){throw 'BETA_BUILD_PARENT_MUST_EXIST'}
if(([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'BETA_BUILD_PARENT_IS_REPARSE_POINT'}
$head=(git -C $repo rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $head -cnotmatch '^[a-f0-9]{40}$'){throw 'BETA_BUILD_GIT_SHA_UNVERIFIED'}
if(@(git -C $repo status --porcelain).Count -ne 0){throw 'BETA_BUILD_SOURCE_WORKTREE_NOT_CLEAN'}
$node=if($NodeExecutable){(Resolve-Path -LiteralPath $NodeExecutable).Path}else{(Get-Command node.exe -ErrorAction Stop).Source}
if((Get-AuthenticodeSignature -LiteralPath $node).Status -ne 'Valid'){throw 'BETA_NODE_RUNTIME_SIGNATURE_NOT_VALID'}
$version=& $node --version
if($LASTEXITCODE -ne 0 -or $version -cnotmatch '^v(2[2-9]|[3-9][0-9])\.'){throw 'BETA_NODE_VERSION_UNSUPPORTED'}
$license=(Resolve-Path -LiteralPath $NodeLicenseFile).Path
if((Get-Item -LiteralPath $license).Length -lt 1000){throw 'BETA_NODE_LICENSE_INCOMPLETE'}
if(-not ((Get-Content -LiteralPath $license -TotalCount 8) -join ' ' -match '(?i)node')){throw 'BETA_NODE_LICENSE_IDENTITY_UNEXPECTED'}
$relay=$PublicRelayUrl
if($relay){
 $uri=$null
 if(-not [uri]::TryCreate($relay,[UriKind]::Absolute,[ref]$uri) -or
   $uri.Scheme -cne 'wss' -or $uri.AbsolutePath -cne '/device' -or
   $uri.Query -or $uri.Fragment -or $uri.UserInfo -or $relay.Length -gt 300){throw 'BETA_RELAY_URL_INVALID'}
}
$bin=@(
 @{name='tetherd-agentw.exe';src=(Join-Path $repo 'target\release\tetherd-agentw.exe')},
 @{name='tetherplane-setupw.exe';src=(Join-Path $repo 'target\release\tetherplane-setupw.exe')}
)
foreach($entry in $bin){if(-not(Test-Path -LiteralPath $entry.src -PathType Leaf) -or (Get-Item -LiteralPath $entry.src).Length -lt 50000){throw ('BETA_NATIVE_BINARY_MISSING_'+$entry.name)}}
$appNames=@('runtime-app.mjs','state-security.mjs','setup.html','setup-client.js','setup.css')
$sourceApp=Join-Path $repo 'packaging\msix-store-runtime\app'
$stage=Join-Path $repo 'scripts\developer-beta\stage-beta-wizard.mjs'
$start=Join-Path $repo 'packaging\developer-beta\START HERE.cmd'
$preflight=Join-Path $repo 'packaging\developer-beta\preflight.mjs'
$readme=Join-Path $repo 'packaging\developer-beta\README-FIRST.md'
foreach($file in @($stage,$start,$preflight,$readme)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'BETA_BUILDER_SOURCE_MISSING'}}
New-Item -ItemType Directory -Path $dest -ErrorAction Stop|Out-Null
foreach($sub in @('bin','runtime','app','app\assets')){
 New-Item -ItemType Directory -Path (Join-Path $dest $sub) -Force -ErrorAction Stop|Out-Null
}
foreach($entry in $bin){Copy-Item -LiteralPath $entry.src -Destination (Join-Path $dest ('bin\'+$entry.name)) -ErrorAction Stop}
Copy-Item -LiteralPath $node -Destination (Join-Path $dest 'runtime\node.exe') -ErrorAction Stop
Copy-Item -LiteralPath $license -Destination (Join-Path $dest 'runtime\LICENSE.node.txt') -ErrorAction Stop
foreach($name in $appNames){
 Copy-Item -LiteralPath (Join-Path $sourceApp $name) -Destination (Join-Path $dest ('app\'+$name)) -ErrorAction Stop
}
foreach($icon in @('brand-32.png','brand-128.png')){
 Copy-Item -LiteralPath (Join-Path $sourceApp ('assets\'+$icon)) -Destination (Join-Path $dest ('app\assets\'+$icon)) -ErrorAction Stop
}
Copy-Item -LiteralPath $preflight -Destination (Join-Path $dest 'app\preflight.mjs') -ErrorAction Stop
Copy-Item -LiteralPath $start -Destination (Join-Path $dest 'START HERE.cmd') -ErrorAction Stop
Copy-Item -LiteralPath $readme -Destination (Join-Path $dest 'README-FIRST.md') -ErrorAction Stop
& $node $stage --stage (Join-Path $dest 'app') $relay
if($LASTEXITCODE -ne 0){throw 'BETA_WIZARD_STAGE_FAILED'}
foreach($js in @('app\runtime-app.mjs','app\setup-client.js','app\preflight.mjs')){
 & $node --check (Join-Path $dest $js)
 if($LASTEXITCODE -ne 0){throw ('BETA_JS_SYNTAX_FAILED_'+$js)}
}
$hashFiles=@('bin/tetherd-agentw.exe','bin/tetherplane-setupw.exe','runtime/node.exe',
 'runtime/LICENSE.node.txt','app/preflight.mjs','app/runtime-app.mjs','app/state-security.mjs',
 'app/setup.html','app/setup-client.js','app/setup.css',
 'app/assets/brand-32.png','app/assets/brand-128.png','START HERE.cmd')
$hashes=[ordered]@{}
foreach($file in $hashFiles){
 $local=Join-Path $dest ($file.Replace('/','\'))
 $hashes[$file]=(Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLowerInvariant()
}
$record=[ordered]@{
 schema='tetherplane.developer-beta.package.v1'
 source_commit=$head
 node_version=$version
 signed_node_runtime_verified=$true
 tetherplane_product_signed=$false
 explicit_owner_pairing_required=$true
 public_relay_url=$relay
 default_share='user-profile/Tetherplane Shared (explicit opt-in)'
 no_automatic_startup_task=$true
 no_authentication_secrets_in_package=$true
 file_hashes=$hashes
}
[IO.File]::WriteAllText((Join-Path $dest 'developer-beta.json'),
 ($record|ConvertTo-Json -Depth 8 -Compress),
 (New-Object Text.UTF8Encoding($false)))
& (Join-Path $dest 'runtime\node.exe') (Join-Path $dest 'app\preflight.mjs') --check
if($LASTEXITCODE -ne 0){throw 'BETA_PACKAGE_INTEGRITY_SELFTEST_FAILED'}
[ordered]@{verdict='DEVELOPER_BETA_SOURCE_PACKAGE_READY_NOT_INSTALLED';source_commit=$head;package_path=$dest;files_verified=$hashFiles.Count;node_version=$version;relay_preset=[bool]$relay;owner_approval_required=$true}|ConvertTo-Json -Compress -Depth 4
