# Read-only Windows SIP content digests. Authenticode changes the raw file hash;
# the SIP digest excludes the signature data according to Windows' file-format
# provider. It binds a signed file to its approved unsigned content but does
# not establish certificate trust (that is verified independently).
# Native contracts:
# https://learn.microsoft.com/windows/win32/api/mssip/nf-mssip-cryptsipcreateindirectdata
# https://learn.microsoft.com/windows/win32/api/mssip/ns-mssip-sip_subjectinfo
# https://learn.microsoft.com/windows/win32/api/mssip/ns-mssip-sip_indirect_data
# https://learn.microsoft.com/windows/win32/api/wincrypt/nf-wincrypt-cryptacquirecontextw
# https://learn.microsoft.com/windows/win32/seccrypto/prov-rsa-aes

function Initialize-WindowsSigningContent {
    if ('Tetherplane.WindowsSigningContent' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Tetherplane {
    public static class WindowsSigningContent {
        private const string Sha256Oid = "2.16.840.1.101.3.4.2.1";

        [StructLayout(LayoutKind.Sequential)]
        public struct Blob { public uint cbData; public IntPtr pbData; }
        [StructLayout(LayoutKind.Sequential)]
        public struct AlgorithmIdentifier { public IntPtr pszObjId; public Blob Parameters; }
        [StructLayout(LayoutKind.Sequential)]
        public struct AttributeTypeValue { public IntPtr pszObjId; public Blob Value; }
        [StructLayout(LayoutKind.Sequential)]
        public struct IndirectData {
            public AttributeTypeValue Data;
            public AlgorithmIdentifier DigestAlgorithm;
            public Blob Digest;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct SubjectInfo {
            public uint cbSize;
            public IntPtr pgSubjectType;
            public IntPtr hFile;
            public IntPtr pwsFileName;
            public IntPtr pwsDisplayName;
            public uint dwReserved1;
            public uint dwIntVersion;
            public IntPtr hProv;
            public AlgorithmIdentifier DigestAlgorithm;
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
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptSIPRetrieveSubjectGuid(string fileName, IntPtr file, out Guid subject);
        [DllImport("crypt32.dll", ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptSIPCreateIndirectData(ref SubjectInfo subject, ref uint size, IntPtr data);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptAcquireContextW(out IntPtr provider, string container, string providerName, uint providerType, uint flags);
        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CryptReleaseContext(IntPtr provider, uint flags);

        private static Exception NativeFailure(string operation) {
            // Capture before formatting or performing any further native work.
            // NativeErrorCode alone is omitted by common PowerShell test logs.
            int code = Marshal.GetLastWin32Error();
            return new Win32Exception(code, "Windows SIP " + operation + " failed (native code " +
                code.ToString(System.Globalization.CultureInfo.InvariantCulture) + "; 0x" +
                unchecked((uint)code).ToString("X8", System.Globalization.CultureInfo.InvariantCulture) + ")");
        }

        public static string Compute(string path) {
            Guid subjectGuid;
            if (!CryptSIPRetrieveSubjectGuid(path, IntPtr.Zero, out subjectGuid)) { throw NativeFailure("subject recognition"); }
            if (subjectGuid == Guid.Empty) { throw new InvalidOperationException("Windows SIP subject is unknown"); }
            IntPtr guid = IntPtr.Zero;
            IntPtr fileName = IntPtr.Zero;
            IntPtr algorithm = IntPtr.Zero;
            IntPtr buffer = IntPtr.Zero;
            IntPtr provider = IntPtr.Zero;
            try {
                // PowerShell's SIP needs a SHA-256-capable provider; its default
                // can reject SHA-256 with NTE_BAD_ALGID. This is hashing only:
                // PROV_RSA_AES, NULL container, CRYPT_VERIFYCONTEXT | CRYPT_SILENT.
                // No keys or persistent containers are opened or created.
                if (!CryptAcquireContextW(out provider, null,
                    "Microsoft Enhanced RSA and AES Cryptographic Provider", 24, 0xF0000040)) {
                    throw NativeFailure("hash provider acquisition");
                }
                guid = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Guid)));
                Marshal.StructureToPtr(subjectGuid, guid, false);
                fileName = Marshal.StringToHGlobalUni(path);
                algorithm = Marshal.StringToHGlobalAnsi(Sha256Oid);
                // new struct is zeroed. Reuse this SAME instance across both
                // native calls; SIP may populate its reserved/internal fields.
                SubjectInfo subject = new SubjectInfo();
                subject.cbSize = checked((uint)Marshal.SizeOf(typeof(SubjectInfo)));
                subject.pgSubjectType = guid;
                subject.hFile = new IntPtr(-1); // file-name storage: INVALID_HANDLE_VALUE
                subject.pwsFileName = fileName;
                subject.hProv = provider;
                subject.DigestAlgorithm.pszObjId = algorithm;
                subject.dwEncodingType = 0x00010001; // X509_ASN_ENCODING | PKCS_7_ASN_ENCODING
                uint size = 0;
                if (!CryptSIPCreateIndirectData(ref subject, ref size, IntPtr.Zero)) { throw NativeFailure("digest sizing"); }
                uint minimum = checked((uint)Marshal.SizeOf(typeof(IndirectData)));
                if (size < minimum || size > 1048576) { throw new InvalidOperationException("Windows SIP returned an invalid digest size"); }
                uint allocated = size;
                buffer = Marshal.AllocHGlobal(checked((int)allocated));
                if (!CryptSIPCreateIndirectData(ref subject, ref size, buffer)) { throw NativeFailure("digest calculation"); }
                if (size < minimum || size > allocated) { throw new InvalidOperationException("Windows SIP changed its digest buffer size"); }
                IndirectData result = (IndirectData)Marshal.PtrToStructure(buffer, typeof(IndirectData));
                if (result.DigestAlgorithm.pszObjId == IntPtr.Zero ||
                    Marshal.PtrToStringAnsi(result.DigestAlgorithm.pszObjId) != Sha256Oid ||
                    result.Digest.cbData != 32 || result.Digest.pbData == IntPtr.Zero) {
                    throw new InvalidOperationException("Windows SIP did not return a SHA-256 content digest");
                }
                long offset = result.Digest.pbData.ToInt64() - buffer.ToInt64();
                if (offset < 0 || offset > (long)size - 32) { throw new InvalidOperationException("Windows SIP returned a digest outside its buffer"); }
                byte[] digest = new byte[32];
                Marshal.Copy(result.Digest.pbData, digest, 0, digest.Length);
                return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
            } finally {
                if (buffer != IntPtr.Zero) { Marshal.FreeHGlobal(buffer); }
                if (algorithm != IntPtr.Zero) { Marshal.FreeHGlobal(algorithm); }
                if (fileName != IntPtr.Zero) { Marshal.FreeHGlobal(fileName); }
                if (guid != IntPtr.Zero) { Marshal.FreeHGlobal(guid); }
                if (provider != IntPtr.Zero && !CryptReleaseContext(provider, 0)) { throw NativeFailure("hash provider release"); }
            }
        }
    }
}
'@
}

function Get-WindowsSigningContentDigest {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "native SIP content digest requires Windows; no raw-hash fallback is permitted" }
    $file = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or @('.exe', '.ps1') -notcontains $file.Extension.ToLowerInvariant()) {
        throw "Windows SIP content digest requires a regular allowlisted code file"
    }
    Initialize-WindowsSigningContent
    $lock = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { return [Tetherplane.WindowsSigningContent]::Compute($file.FullName) }
    finally { $lock.Dispose() }
}
