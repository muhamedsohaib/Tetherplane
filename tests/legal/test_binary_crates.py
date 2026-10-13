import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
import zipfile

MODULE = Path(__file__).resolve().parents[2] / 'scripts' / 'audit_binary_crates.py'
spec = importlib.util.spec_from_file_location('audit_binary_crates', MODULE)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

class RustBinaryEvidenceTests(unittest.TestCase):
    def test_extract_paths_count_duplicates(self):
        data = (b'X\\runner\\.cargo\\registry\\src\\index.crates.io-x\\ring-0.17.14\\src\\a.rs\0'
                b'X\\runner\\.cargo\\registry\\src\\index.crates.io-x\\ring-0.17.14\\src\\b.rs\0'
                b'X\\runner\\.cargo\\registry\\src\\index.crates.io-x\\tokio-1.53.1\\src\\c.rs\0')
        self.assertEqual(audit.scan_registry_paths(data), [
            {'name': 'ring', 'version': '0.17.14', 'path_references': 2},
            {'name': 'tokio', 'version': '1.53.1', 'path_references': 1}
        ])

    def test_cargo_registry_only(self):
        lock = b'''version = 4
[[package]]
name = "tokio"
version = "1.53.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
[[package]]
name = "tetherd"
version = "0.1.0"
'''
        self.assertEqual(audit.parse_registry_lock(lock), {('tokio', '1.53.1')})

    def test_archive_hash_and_matching(self):
        exe = b'MZ' + b'\0'*7 + b'.cargo\\registry\\src\\index.crates.io-x\\tokio-1.53.1\\src\\f.rs\0'
        data = io.BytesIO()
        with zipfile.ZipFile(data,'w') as z:
            z.writestr('bin/tetherd.exe',exe)
        raw = data.getvalue()
        lock = b'''version = 4
[[package]]
name = "tokio"
version = "1.53.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
'''
        result = audit.audit_zip(raw,lock,hashlib.sha256(raw).hexdigest())
        self.assertEqual(result['observed_unique_registry_crates'],1)
        self.assertEqual(result['observed_lockfile_matches'],1)
        self.assertEqual(result['missing_in_lock'],[])
        self.assertFalse(result['is_complete_linkage_manifest'])
        self.assertEqual(result['binary_sha256'], hashlib.sha256(exe).hexdigest())

    def test_wrong_archive_hash_fails_closed(self):
        with self.assertRaisesRegex(ValueError,'SHA-256'):
            audit.audit_zip(b'bad', b'', '00'*32)

    def test_missing_executable_fails_closed(self):
        b = io.BytesIO()
        with zipfile.ZipFile(b,'w') as z:
            z.writestr('test.txt','x')
        with self.assertRaisesRegex(ValueError, 'bin/tetherd.exe'):
            audit.audit_zip(b.getvalue(), b'version = 4\n')

if __name__ == '__main__':
    unittest.main()
