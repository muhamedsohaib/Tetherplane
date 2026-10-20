[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceHtml)
$ErrorActionPreference = 'Stop'
$expected = '36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82'
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
