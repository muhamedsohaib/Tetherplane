[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceHtml)
$ErrorActionPreference = 'Stop'
$expected = '4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8'
$source = (Resolve-Path -LiteralPath $SourceHtml).Path
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $expected) { throw 'The source is not the approved original Tetherplane HTML. Nothing was copied.' }
$root = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $root 'public\index.html'
if (Test-Path -LiteralPath $destination) {
  $current = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($current -ne $expected) { throw 'A different public/index.html already exists. No overwrite performed.' }
  Write-Output 'Approved HTML already installed. No files changed.'
  exit 0
}
Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
$newHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
if ($newHash -ne $expected) { throw 'Post-copy hash verification failed.' }
Write-Output "Approved HTML installed and verified: $destination"
