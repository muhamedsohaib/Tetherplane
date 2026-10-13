import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'audit_third_party_licenses.py'
if not MODULE_PATH.exists():
    raise AssertionError('Expected production dependency-audit script is missing')
spec = importlib.util.spec_from_file_location('audit_third_party_licenses', MODULE_PATH)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditContractTests(unittest.TestCase):
    def test_cargo_locked_external_and_internal(self):
        source = b'''version = 4\n[[package]]\nname = "serde"\nversion = "1.0.229"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n[[package]]\nname = "tetherd"\nversion = "0.1.0"\n'''
        got = audit.parse_cargo_lock(source)
        self.assertEqual(got, [{'ecosystem': 'cargo', 'name': 'serde', 'version': '1.0.229'}])

    def test_pnpm_quoted_scoped_and_unscoped(self):
        source = '''lockfileVersion: '9.0'\npackages:\n\n  '@modelcontextprotocol/sdk@1.30.0':\n    resolution: {integrity: sha512-abc}\n\n  zod@4.6.5:\n    resolution: {integrity: sha512-def}\n\nsnapshots:\n  zod@4.6.5: {}\n'''
        got = audit.parse_pnpm_lock(source)
        self.assertEqual(got, [
            {'ecosystem': 'npm', 'name': '@modelcontextprotocol/sdk', 'version': '1.30.0'},
            {'ecosystem': 'npm', 'name': 'zod', 'version': '4.6.5'},
        ])

    def test_license_normalization(self):
        self.assertEqual(audit.normalize_license({'type': 'MIT'}), 'MIT')
        self.assertEqual(audit.normalize_license('MIT OR Apache-2.0'), 'MIT OR Apache-2.0')
        self.assertIsNone(audit.normalize_license(None))

    def test_license_requires_manual_review(self):
        self.assertEqual(audit.classify_license('MIT OR Apache-2.0'), 'permissive-declared')
        self.assertEqual(audit.classify_license('AGPL-3.0-only'), 'review-copyleft')
        self.assertEqual(audit.classify_license('GPL-2.0-only'), 'review-copyleft')
        self.assertEqual(audit.classify_license('SEE LICENSE IN LICENSE.md'), 'review-ambiguous')
        self.assertEqual(audit.classify_license(None), 'review-missing')

if __name__ == '__main__':
    unittest.main()
