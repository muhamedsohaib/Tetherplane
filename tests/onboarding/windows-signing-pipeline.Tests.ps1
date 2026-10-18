$pipelineRepo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$requestScript = Join-Path $pipelineRepo "scripts/new-windows-signing-request.ps1"
$adapterScript = Join-Path $pipelineRepo "scripts/invoke-windows-signing-adapter.ps1"
. $requestScript
. $adapterScript

# Policy fixtures model a signature-excluded digest. They do not claim to
# implement Windows SIP; the native cases below exercise that separate API.
function Get-PipelineFixtureContentDigest([string]$Path) {
    $content = [IO.File]::ReadAllText($Path)
    $marker = $content.IndexOf("signed-for-test:", [StringComparison]::Ordinal)
    if ($marker -ge 0) { $content = $content.Substring(0, $marker) }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($content)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

if (-not (Get-Command Get-WindowsSigningContentDigest -ErrorAction SilentlyContinue)) {
    function Get-WindowsSigningContentDigest { param([string]$Path) throw "native Windows SIP helper is not implemented" }
}

function New-PipelineFixture {
    $root = Join-Path ([IO.Path]::GetTempPath()) ("tp-signing-pipeline-" + [Guid]::NewGuid().ToString("N"))
    $source = Join-Path $root "source"
    $payload = Join-Path $root "payload with ' quote"
    New-Item -ItemType Directory -Path $root, $source, $payload | Out-Null
    $paths = @("bin/tetherd.exe", "launch/tetherplane-agent.ps1", "setup-windows-device.ps1", "pair-windows-device.ps1", "doctor-tetherplane.ps1")
    foreach ($relative in $paths) {
        $path = Join-Path $payload $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
        [IO.File]::WriteAllText($path, "fixture only: $relative`n")
        if ($relative -ne "bin/tetherd.exe") {
            $sourceRelative = if ($relative -eq "launch/tetherplane-agent.ps1") { "packaging/windows/tetherplane-agent.ps1" } else { "scripts/$relative" }
            $sourcePath = Join-Path $source $sourceRelative
            New-Item -ItemType Directory -Path (Split-Path -Parent $sourcePath) -Force | Out-Null
            Copy-Item -LiteralPath $path -Destination $sourcePath
        }
    }
    & git -C $source init --quiet
    & git -C $source add --all
    & git -C $source -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit --quiet -m fixture
    if ($LASTEXITCODE -ne 0) { throw "isolated fixture commit failed" }
    $commit = ((& git -C $source rev-parse HEAD) | Out-String).Trim()
    [pscustomobject]@{
        Root = $root; Source = $source; Payload = $payload; Paths = $paths; Commit = $commit
        Request = (Join-Path $root "request.json"); Output = (Join-Path $root "signed-output")
        Adapter = (Join-Path $root "provider adapter's script.ps1")
    }
}

function Write-FixtureRequest($Fixture) {
    $entries = @($Fixture.Paths | ForEach-Object {
        [ordered]@{
            path = $_
            sha256 = (Get-FileHash -LiteralPath (Join-Path $Fixture.Payload $_) -Algorithm SHA256).Hash.ToLowerInvariant()
            sip_sha256 = (Get-PipelineFixtureContentDigest -Path (Join-Path $Fixture.Payload $_))
        }
    })
    $request = [ordered]@{ schema = "tetherplane-windows-signing-request-v2"; source_commit = $Fixture.Commit; files = $entries }
    [IO.File]::WriteAllText($Fixture.Request, ($request | ConvertTo-Json -Depth 5))
}

function Write-FixtureAdapter($Fixture, [string]$Body) {
    [IO.File]::WriteAllText($Fixture.Adapter, ('param([string]$Path, [string]$TimestampUrl)' + "`n" + $Body))
}

function Invoke-FixtureAdapter($Fixture, [hashtable]$Overrides = @{}) {
    $arguments = @{
        RequestPath = $Fixture.Request
        ExpectedRequestSha256 = (Get-FileHash -LiteralPath $Fixture.Request -Algorithm SHA256).Hash
        ExpectedSourceCommit = $Fixture.Commit
        PayloadPath = $Fixture.Payload
        OutputPath = $Fixture.Output
        AdapterPath = $Fixture.Adapter
        ExpectedAdapterSha256 = (Get-FileHash -LiteralPath $Fixture.Adapter -Algorithm SHA256).Hash
        TimestampUrl = "https://timestamp.example.invalid/rfc3161"
        TimeoutSeconds = 15
    }
    foreach ($key in $Overrides.Keys) { $arguments[$key] = $Overrides[$key] }
    Invoke-WindowsSigningAdapter @arguments
}

# Draft for the native Windows Pester suite. No certificate/key/store changes.
# Only owned temporary copies of already-signed Windows files are modified.
# Production Get-WindowsSigningContentDigest must already be loaded.

function Initialize-NativeSipRemovalFixture {
    if ('Tetherplane.Tests.NativeSipRemoval' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Tetherplane.Tests {
    public static class NativeSipRemoval {
        [StructLayout(LayoutKind.Sequential)]
        private struct Blob { public uint cbData; public IntPtr pbData; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Algorithm { public IntPtr pszObjId; public Blob Parameters; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Subject {
            public uint cbSize;
            public IntPtr pgSubjectType;
            public IntPtr hFile;
            public IntPtr pwsFileName;
            public IntPtr pwsDisplayName;
            public uint dwReserved1;
            public uint dwIntVersion;
            public IntPtr hProv;
            public Algorithm DigestAlgorithm;
            public uint dwFlags;
            public uint dwEncodingType;
            public uint dwReserved2;
            public uint fdwCAPISettings;
            public uint fdwSecuritySettings;
            public uint dwIndex;
            public uint dwUnionChoice;
            public IntPtr pUnion;
            public IntPtr pClientData;
        }
        [DllImport("crypt32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptSIPRetrieveSubjectGuid(string name, IntPtr file, out Guid subject);
        [DllImport("crypt32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptSIPRemoveSignedDataMsg(ref Subject subject, uint index);

        public static void RemoveFirst(string path) {
            Guid guid;
            if (!CryptSIPRetrieveSubjectGuid(path, IntPtr.Zero, out guid)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "native test fixture SIP recognition failed");
            }
            IntPtr guidPointer = IntPtr.Zero;
            IntPtr fileName = IntPtr.Zero;
            try {
                guidPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Guid)));
                Marshal.StructureToPtr(guid, guidPointer, false);
                fileName = Marshal.StringToHGlobalUni(path);
                Subject subject = new Subject();
                subject.cbSize = checked((uint)Marshal.SizeOf(typeof(Subject)));
                subject.pgSubjectType = guidPointer;
                subject.hFile = new IntPtr(-1);
                subject.pwsFileName = fileName;
                subject.dwEncodingType = 0x00010001;
                if (!CryptSIPRemoveSignedDataMsg(ref subject, 0)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "native test fixture signature removal failed");
                }
            } finally {
                if (fileName != IntPtr.Zero) { Marshal.FreeHGlobal(fileName); }
                if (guidPointer != IntPtr.Zero) { Marshal.FreeHGlobal(guidPointer); }
            }
        }
    }
}
'@
}

function Find-NativeSipSignedScriptFixture {
    $coreHost = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $moduleRoots = @(
        (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'),
        (Join-Path $PSHOME 'Modules')
        if ($coreHost) { Join-Path (Split-Path -Parent $coreHost.Source) 'Modules' }
    ) | Select-Object -Unique
    foreach ($moduleRoot in $moduleRoots) {
        if (-not (Test-Path -LiteralPath $moduleRoot -PathType Container)) { continue }
        foreach ($candidate in @(Get-ChildItem -LiteralPath $moduleRoot -Recurse -File | Where-Object { @('.ps1', '.psm1') -contains $_.Extension.ToLowerInvariant() } | Sort-Object FullName)) {
            $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $candidate.FullName
            if ([string]$signature.SignatureType -eq 'Authenticode' -and $null -ne $signature.SignerCertificate) {
                return $candidate.FullName
            }
        }
    }
    throw 'native SIP fixture is unavailable: no installed embedded-signed Windows PowerShell script was found'
}

function Remove-NativeSipFixtureSignatures {
    param([string]$Path)
    Initialize-NativeSipRemovalFixture
    for ($index = 0; $index -lt 8; $index++) {
        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Path
        if ([string]$signature.SignatureType -ne 'Authenticode' -or $null -eq $signature.SignerCertificate) { return }
        [Tetherplane.Tests.NativeSipRemoval]::RemoveFirst($Path)
    }
    throw 'native SIP fixture still has an embedded signature after eight removals'
}


Describe "provider-neutral signing request policy (mocked SIP boundary)" {
    BeforeEach {
        $script:fixture = New-PipelineFixture
        Mock Get-WindowsSigningContentDigest { param([string]$Path) Get-PipelineFixtureContentDigest -Path $Path }
    }
    AfterEach { Remove-Item -LiteralPath $script:fixture.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It "binds exactly five payload hashes to a clean, exact source revision" {
        $result = New-WindowsSigningRequest -PayloadPath $fixture.Payload -OutputPath $fixture.Request -SourceCommit $fixture.Commit -RepositoryPath $fixture.Source
        $request = Get-Content -LiteralPath $fixture.Request -Raw | ConvertFrom-Json
        $request.schema | Should Be "tetherplane-windows-signing-request-v2"
        $request.source_commit | Should Be $fixture.Commit
        ($request.files.path -join ",") | Should Be ($fixture.Paths -join ",")
        foreach ($entry in $request.files) {
            $entry.sha256 | Should Be (Get-FileHash -LiteralPath (Join-Path $fixture.Payload $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant()
            $entry.sip_sha256 | Should Be (Get-PipelineFixtureContentDigest -Path (Join-Path $fixture.Payload $entry.path))
        }
        $result.request_sha256 | Should Be (Get-FileHash -LiteralPath $fixture.Request -Algorithm SHA256).Hash.ToLowerInvariant()
        $result.file_count | Should Be 5
    }

    It "rejects a different source revision before writing the request" {
        { New-WindowsSigningRequest -PayloadPath $fixture.Payload -OutputPath $fixture.Request -SourceCommit ("0" * 40) -RepositoryPath $fixture.Source } | Should Throw "source revision"
        (Test-Path -LiteralPath $fixture.Request) | Should Be $false
    }

    It "rejects an untracked source file before writing the request" {
        [IO.File]::WriteAllText((Join-Path $fixture.Source "unreviewed.txt"), "human change")
        { New-WindowsSigningRequest -PayloadPath $fixture.Payload -OutputPath $fixture.Request -SourceCommit $fixture.Commit -RepositoryPath $fixture.Source } | Should Throw "clean checkout"
        (Test-Path -LiteralPath $fixture.Request) | Should Be $false
    }

    It "rejects a modified tracked source before writing the request" {
        Add-Content -LiteralPath (Join-Path $fixture.Source "scripts/setup-windows-device.ps1") -Value "changed"
        { New-WindowsSigningRequest -PayloadPath $fixture.Payload -OutputPath $fixture.Request -SourceCommit $fixture.Commit -RepositoryPath $fixture.Source } | Should Throw "clean checkout"
    }

    It "rejects substituted script bytes even when the source checkout is clean" {
        Add-Content -LiteralPath (Join-Path $fixture.Payload "setup-windows-device.ps1") -Value "changed"
        { New-WindowsSigningRequest -PayloadPath $fixture.Payload -OutputPath $fixture.Request -SourceCommit $fixture.Commit -RepositoryPath $fixture.Source } | Should Throw "source script"
    }

    It "rejects extra payload files instead of signing arbitrary input" {
        [IO.File]::WriteAllText((Join-Path $fixture.Payload "extra.exe"), "extra")
        { New-WindowsSigningRequest -PayloadPath $fixture.Payload -OutputPath $fixture.Request -SourceCommit $fixture.Commit -RepositoryPath $fixture.Source } | Should Throw "payload layout"
    }

    It "rejects a missing allowlisted file" {
        Remove-Item -LiteralPath (Join-Path $fixture.Payload "doctor-tetherplane.ps1")
        { New-WindowsSigningRequest -PayloadPath $fixture.Payload -OutputPath $fixture.Request -SourceCommit $fixture.Commit -RepositoryPath $fixture.Source } | Should Throw "payload layout"
    }

    It "preserves an existing request file" {
        [IO.File]::WriteAllText($fixture.Request, "human request")
        { New-WindowsSigningRequest -PayloadPath $fixture.Payload -OutputPath $fixture.Request -SourceCommit $fixture.Commit -RepositoryPath $fixture.Source } | Should Throw "already exists"
        [IO.File]::ReadAllText($fixture.Request) | Should Be "human request"
    }

    It "rejects a redirected payload directory before traversing it" {
        $bin = Join-Path $fixture.Payload "bin"
        $external = Join-Path $fixture.Root "outside-bin"
        Move-Item -LiteralPath $bin -Destination $external
        $linkType = if ($env:OS -eq "Windows_NT") { "Junction" } else { "SymbolicLink" }
        New-Item -ItemType $linkType -Path $bin -Target $external | Out-Null
        { New-WindowsSigningRequest -PayloadPath $fixture.Payload -OutputPath $fixture.Request -SourceCommit $fixture.Commit -RepositoryPath $fixture.Source } | Should Throw "redirected"
        [IO.File]::ReadAllText((Join-Path $external "tetherd.exe")) | Should Match "fixture only"
    }
}

Describe "isolated provider adapter policy (mocked SIP boundary)" {
    BeforeEach {
        $script:fixture = New-PipelineFixture
        Mock Get-WindowsSigningContentDigest { param([string]$Path) Get-PipelineFixtureContentDigest -Path $Path }
        Write-FixtureRequest $fixture
        Write-FixtureAdapter $fixture '[IO.File]::AppendAllText($Path, "signed-for-test:" + $TimestampUrl); exit 0'
    }
    AfterEach { Remove-Item -LiteralPath $script:fixture.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It "passes literal paths and timestamp URLs while preserving original input" {
        $original = @{}
        foreach ($relative in $fixture.Paths) { $original[$relative] = (Get-FileHash -LiteralPath (Join-Path $fixture.Payload $relative)).Hash }
        $result = Invoke-FixtureAdapter $fixture
        $result.file_count | Should Be 5
        foreach ($relative in $fixture.Paths) {
            [IO.File]::ReadAllText((Join-Path $fixture.Output $relative)) | Should Match "signed-for-test:https://timestamp.example.invalid/rfc3161"
            (Get-FileHash -LiteralPath (Join-Path $fixture.Payload $relative)).Hash | Should Be $original[$relative]
        }
    }

    It "rejects a changed request against the independently supplied request hash" {
        $hash = (Get-FileHash -LiteralPath $fixture.Request).Hash
        Add-Content -LiteralPath $fixture.Request -Value " "
        { Invoke-FixtureAdapter $fixture @{ ExpectedRequestSha256 = $hash } } | Should Throw "request hash"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "rejects a request for an unexpected source revision" {
        { Invoke-FixtureAdapter $fixture @{ ExpectedSourceCommit = ("0" * 40) } } | Should Throw "source revision"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "rejects duplicate entries before invoking the adapter" {
        $request = Get-Content -LiteralPath $fixture.Request -Raw | ConvertFrom-Json
        $request.files[1] = $request.files[0]
        [IO.File]::WriteAllText($fixture.Request, ($request | ConvertTo-Json -Depth 5))
        { Invoke-FixtureAdapter $fixture } | Should Throw "request file list"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "rejects traversal entries before invoking the adapter" {
        $request = Get-Content -LiteralPath $fixture.Request -Raw | ConvertFrom-Json
        $request.files[0].path = "../outside.exe"
        [IO.File]::WriteAllText($fixture.Request, ($request | ConvertTo-Json -Depth 5))
        { Invoke-FixtureAdapter $fixture } | Should Throw "request file list"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "rejects unexpected request properties" {
        $request = Get-Content -LiteralPath $fixture.Request -Raw | ConvertFrom-Json
        $request | Add-Member -NotePropertyName command -NotePropertyValue "untrusted script"
        [IO.File]::WriteAllText($fixture.Request, ($request | ConvertTo-Json -Depth 5))
        { Invoke-FixtureAdapter $fixture } | Should Throw "request schema"
    }

    It "rejects a payload changed after the signing request was prepared" {
        Add-Content -LiteralPath (Join-Path $fixture.Payload "bin/tetherd.exe") -Value "tampered"
        { Invoke-FixtureAdapter $fixture } | Should Throw "payload hash"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "rejects unexpected payload files even when allowlisted hashes still match" {
        [IO.File]::WriteAllText((Join-Path $fixture.Payload "extra.ps1"), "extra")
        { Invoke-FixtureAdapter $fixture } | Should Throw "payload layout"
    }

    It "rejects a changed provider adapter before executing it" {
        $hash = (Get-FileHash -LiteralPath $fixture.Adapter).Hash
        Add-Content -LiteralPath $fixture.Adapter -Value "# changed"
        { Invoke-FixtureAdapter $fixture @{ ExpectedAdapterSha256 = $hash } } | Should Throw "adapter hash"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "preserves an existing output directory and its human files" {
        New-Item -ItemType Directory -Path $fixture.Output | Out-Null
        $sentinel = Join-Path $fixture.Output "human.txt"
        [IO.File]::WriteAllText($sentinel, "preserve")
        { Invoke-FixtureAdapter $fixture } | Should Throw "already exists"
        [IO.File]::ReadAllText($sentinel) | Should Be "preserve"
    }

    It "rejects output overlapping the input payload" {
        { Invoke-FixtureAdapter $fixture @{ OutputPath = (Join-Path $fixture.Payload "signed") } } | Should Throw "overlap"
        (Test-Path -LiteralPath (Join-Path $fixture.Payload "signed")) | Should Be $false
    }

    It "rejects credential-bearing and non-HTTP timestamp URLs" {
        foreach ($url in @("https://user:secret@timestamp.example.invalid/", "https://timestamp.example.invalid/?token=secret", "https://timestamp.example.invalid/#secret", "file:///tmp/timestamp")) {
            { Invoke-FixtureAdapter $fixture @{ TimestampUrl = $url } } | Should Throw "timestamp URL"
        }
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "suppresses provider output and emits no candidate on a nonzero exit" {
        Write-FixtureAdapter $fixture 'Write-Output "SECRET_SENTINEL"; [Console]::Error.WriteLine("SECRET_SENTINEL"); exit 1'
        $captured = @()
        $failure = $null
        try { $captured = @(Invoke-FixtureAdapter $fixture *>&1) } catch { $failure = $_ }
        $failure.Exception.Message | Should Match "adapter failed"
        ($captured | Out-String) | Should Not Match "SECRET_SENTINEL"
        $failure.Exception.Message | Should Not Match "SECRET_SENTINEL"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
        @(Get-ChildItem -LiteralPath $fixture.Root -Filter "*.incomplete-*" -Force).Count | Should Be 0
    }

    It "treats the signing-tool warning exit code as failure" {
        Write-FixtureAdapter $fixture 'exit 2'
        { Invoke-FixtureAdapter $fixture } | Should Throw "adapter failed"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "rejects an adapter warning even if it would otherwise return zero" {
        Write-FixtureAdapter $fixture 'Write-Warning "SECRET_SENTINEL"; exit 0'
        { Invoke-FixtureAdapter $fixture } | Should Throw "adapter failed"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "rejects an adapter that adds an unexpected staged file" {
        Write-FixtureAdapter $fixture '[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $Path) "unexpected.txt"), "extra"); exit 0'
        { Invoke-FixtureAdapter $fixture } | Should Throw "payload layout"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "rejects an adapter that changes a different staged file" {
        Write-FixtureAdapter $fixture '[IO.File]::AppendAllText((Join-Path (Split-Path -Parent (Split-Path -Parent $Path)) "setup-windows-device.ps1"), "unexpected"); exit 0'
        { Invoke-FixtureAdapter $fixture } | Should Throw "unexpected file"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "rejects different target content even when the approved adapter reports signing success" {
        Write-FixtureAdapter $fixture '[IO.File]::WriteAllText($Path, "different released code signed-for-test:" + $TimestampUrl); exit 0'
        { Invoke-FixtureAdapter $fixture } | Should Throw "content digest"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    It "terminates an unresponsive adapter without emitting a candidate" {
        Write-FixtureAdapter $fixture 'Start-Sleep -Seconds 20; exit 0'
        { Invoke-FixtureAdapter $fixture @{ TimeoutSeconds = 1 } } | Should Throw "adapter timed out"
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }

    # The managed Linux test sandbox does not expose a process tree to .NET
    # (even /bin/ps cannot enumerate it). Both hosted Windows shells must run
    # this real descendant-process check before trusting timeout cleanup.
    It "terminates an adapter's child signer on timeout before it can finish work" -Skip:($env:OS -ne "Windows_NT") {
        $sentinel = Join-Path $fixture.Root "child-finished.txt"
        $childCommand = 'Start-Sleep -Seconds 3; [IO.File]::WriteAllText(' + "'" + $sentinel.Replace("'", "''") + "'" + ', "must not finish")'
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
        $hostName = if ($PSVersionTable.PSEdition -eq "Desktop") { "powershell.exe" } elseif ($env:OS -eq "Windows_NT") { "pwsh.exe" } else { "pwsh" }
        $body = '$start = New-Object Diagnostics.ProcessStartInfo; $start.FileName = Join-Path $PSHOME ' + "'" + $hostName + "'" + '; ' +
            '$start.Arguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $encoded + '"; ' +
            '$start.UseShellExecute = $false; $start.CreateNoWindow = $true; [void][Diagnostics.Process]::Start($start); Start-Sleep -Seconds 20'
        Write-FixtureAdapter $fixture $body
        { Invoke-FixtureAdapter $fixture @{ TimeoutSeconds = 1 } } | Should Throw "adapter timed out"
        Start-Sleep -Seconds 4
        (Test-Path -LiteralPath $sentinel) | Should Be $false
        (Test-Path -LiteralPath $fixture.Output) | Should Be $false
    }
}

Describe "independent signed-content policy (mocked SIP boundary)" {
    BeforeEach {
        $script:fixture = New-PipelineFixture
        Mock Get-WindowsSigningContentDigest { param([string]$Path) Get-PipelineFixtureContentDigest -Path $Path }
        Write-FixtureRequest $fixture
        Copy-Item -LiteralPath $fixture.Payload -Destination $fixture.Output -Recurse
        foreach ($relative in $fixture.Paths) { [IO.File]::AppendAllText((Join-Path $fixture.Output $relative), "signed-for-test:approved publisher") }
        $script:proofArguments = @{
            RequestPath = $fixture.Request; ExpectedRequestSha256 = (Get-FileHash -LiteralPath $fixture.Request).Hash
            ExpectedSourceCommit = $fixture.Commit; UnsignedPayloadPath = $fixture.Payload; SignedPayloadPath = $fixture.Output
        }
    }
    AfterEach { Remove-Item -LiteralPath $script:fixture.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It "binds changed signature bytes to exactly the approved executable content" {
        $proof = Confirm-WindowsSignedPayload @proofArguments
        $proof.file_count | Should Be 5
        $proof.source_commit | Should Be $fixture.Commit
    }

    It "rejects an older signed executable despite matching request source and publisher metadata" {
        [IO.File]::WriteAllText((Join-Path $fixture.Output 'bin/tetherd.exe'), 'older released executable signed-for-test:approved publisher')
        { Confirm-WindowsSignedPayload @proofArguments } | Should Throw "content digest"
    }

    It "rejects an older signed script despite matching request source and publisher metadata" {
        [IO.File]::WriteAllText((Join-Path $fixture.Output 'setup-windows-device.ps1'), 'older released script signed-for-test:approved publisher')
        { Confirm-WindowsSignedPayload @proofArguments } | Should Throw "content digest"
    }

    It "rejects removal of the signature-excluded content proof" {
        $request = Get-Content -LiteralPath $fixture.Request -Raw | ConvertFrom-Json
        $request.files[0].PSObject.Properties.Remove('sip_sha256')
        [IO.File]::WriteAllText($fixture.Request, ($request | ConvertTo-Json -Depth 5))
        $proofArguments.ExpectedRequestSha256 = (Get-FileHash -LiteralPath $fixture.Request).Hash
        { Confirm-WindowsSignedPayload @proofArguments } | Should Throw "request file list"
    }
}

Describe "native Windows signing content digests" {
    BeforeEach {
        $script:nativeRoot = Join-Path ([IO.Path]::GetTempPath()) ("tp-native-sip-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $nativeRoot | Out-Null
    }
    AfterEach { Remove-Item -LiteralPath $script:nativeRoot -Recurse -Force -ErrorAction SilentlyContinue }

    It "uses native SHA-256 SIP on Windows and explicitly rejects unavailable platforms" {
        $path = Join-Path $nativeRoot 'unsigned.ps1'
        [IO.File]::WriteAllText($path, "# native fixture`r`nWrite-Output 'never executed'`r`n")
        if ($env:OS -eq 'Windows_NT') {
            $first = Get-WindowsSigningContentDigest -Path $path
            $first | Should Match '^[a-f0-9]{64}$'
            [IO.File]::AppendAllText($path, "# changed content`r`n")
            (Get-WindowsSigningContentDigest -Path $path) | Should Not Be $first
        } else {
            { Get-WindowsSigningContentDigest -Path $path } | Should Throw 'requires Windows'
        }
    }

    It "rejects malformed PE content instead of falling back to a raw file hash" -Skip:($env:OS -ne 'Windows_NT') {
        $path = Join-Path $nativeRoot 'bad.exe'
        [IO.File]::WriteAllText($path, 'this is not a PE executable')
        { Get-WindowsSigningContentDigest -Path $path } | Should Throw 'SIP'
    }

    It "ignores PE checksum changes but detects changed executable section bytes" -Skip:($env:OS -ne 'Windows_NT') {
        $hostExecutable = (Get-Process -Id $PID).Path
        $path = Join-Path $nativeRoot 'host-copy.exe'
        Copy-Item -LiteralPath $hostExecutable -Destination $path
        $first = Get-WindowsSigningContentDigest -Path $path
        $bytes = [IO.File]::ReadAllBytes($path)
        $pe = [BitConverter]::ToInt32($bytes, 0x3c)
        $checksum = $pe + 24 + 64
        $bytes[$checksum] = $bytes[$checksum] -bxor 1
        [IO.File]::WriteAllBytes($path, $bytes)
        (Get-WindowsSigningContentDigest -Path $path) | Should Be $first
        $section = $pe + 24 + [BitConverter]::ToUInt16($bytes, $pe + 20)
        $codeOffset = [BitConverter]::ToInt32($bytes, $section + 20)
        $codeOffset | Should BeGreaterThan 0
        $bytes[$codeOffset] = $bytes[$codeOffset] -bxor 1
        [IO.File]::WriteAllBytes($path, $bytes)
        (Get-WindowsSigningContentDigest -Path $path) | Should Not Be $first
    }
}

Describe 'native Windows SIP signing-content equivalence' {
    # Explicitly skipped off Windows. Both Windows CI shells must execute the
    # native cases; they never mock the content digest or import a test root.
    BeforeEach {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'native SIP acceptance requires Windows' }
        $script:nativeSipFixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('tp-native-sip-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:nativeSipFixtureRoot | Out-Null
    }
    AfterEach {
        if ($script:nativeSipFixtureRoot) { Remove-Item -LiteralPath $script:nativeSipFixtureRoot -Recurse -Force }
    }

    It 'keeps the script content digest through native signature removal and detects a code edit' -Skip:($env:OS -ne 'Windows_NT') {
        $source = Find-NativeSipSignedScriptFixture
        $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        $copy = Join-Path $script:nativeSipFixtureRoot 'signed-copy.ps1'
        Copy-Item -LiteralPath $source -Destination $copy
        (Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $copy).SignatureType.ToString() | Should Be 'Authenticode'
        $signedRawHash = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash
        $signedContentDigest = Get-WindowsSigningContentDigest -Path $copy
        $signedContentDigest | Should Match '^[a-f0-9]{64}$'
        Remove-NativeSipFixtureSignatures -Path $copy
        (Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $copy).SignatureType.ToString() | Should Not Be 'Authenticode'
        (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash | Should Not Be $signedRawHash
        (Get-WindowsSigningContentDigest -Path $copy) | Should Be $signedContentDigest
        # Get-Content detects UTF-16 BOMs; Set-Content changes the entire text
        # consistently, avoiding a mixed-encoding file in this mutation test.
        $text = Get-Content -LiteralPath $copy -Raw
        Set-Content -LiteralPath $copy -Value ($text + "`r`nWrite-Output 'changed-native-fixture'`r`n") -Encoding Unicode
        (Get-WindowsSigningContentDigest -Path $copy) | Should Not Be $signedContentDigest
        (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash | Should Be $sourceHash
    }

    It 'keeps the PE content digest through native signature removal and detects a code edit' -Skip:($env:OS -ne 'Windows_NT') {
        $hostName = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'powershell.exe' } else { 'pwsh.exe' }
        $coreHost = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $hosts = @( (Join-Path $PSHOME $hostName); if ($coreHost) { $coreHost.Source } ) | Select-Object -Unique
        $source = $null
        foreach ($candidate in $hosts) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $candidate
                if ([string]$signature.SignatureType -eq 'Authenticode' -and $signature.SignerCertificate) { $source = $candidate; break }
            }
        }
        if (-not $source) {
            throw 'native SIP fixture is unavailable: the installed PowerShell executable lacks an embedded signature'
        }
        $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        $copy = Join-Path $script:nativeSipFixtureRoot 'signed-copy.exe'
        Copy-Item -LiteralPath $source -Destination $copy
        $signedRawHash = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash
        $signedContentDigest = Get-WindowsSigningContentDigest -Path $copy
        Remove-NativeSipFixtureSignatures -Path $copy
        (Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $copy).SignatureType.ToString() | Should Not Be 'Authenticode'
        (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash | Should Not Be $signedRawHash
        (Get-WindowsSigningContentDigest -Path $copy) | Should Be $signedContentDigest
        # Change one byte in the first PE section, after validating offsets.
        # No modified executable is ever run.
        $bytes = [IO.File]::ReadAllBytes($copy)
        $pe = [BitConverter]::ToInt32($bytes, 0x3c)
        if ($pe -lt 0 -or $pe + 24 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $pe) -ne 0x00004550) { throw 'native PE fixture header is invalid' }
        $sections = [BitConverter]::ToUInt16($bytes, $pe + 6)
        $optionalSize = [BitConverter]::ToUInt16($bytes, $pe + 20)
        $firstSection = $pe + 24 + $optionalSize
        if ($sections -lt 1 -or $firstSection + 40 -gt $bytes.Length) { throw 'native PE fixture has no section table' }
        $rawSize = [BitConverter]::ToUInt32($bytes, $firstSection + 16)
        $rawOffset = [BitConverter]::ToUInt32($bytes, $firstSection + 20)
        if ($rawSize -lt 1 -or $rawOffset -ge $bytes.Length -or $rawOffset + [long]$rawSize -gt $bytes.Length) { throw 'native PE fixture has no bounded raw section' }
        $bytes[$rawOffset] = $bytes[$rawOffset] -bxor 1
        [IO.File]::WriteAllBytes($copy, $bytes)
        (Get-WindowsSigningContentDigest -Path $copy) | Should Not Be $signedContentDigest
        (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash | Should Be $sourceHash
    }
}
