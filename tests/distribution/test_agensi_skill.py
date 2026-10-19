"""Release contract for the public, no-credentials tetherplane Agensi skill."""
import hashlib
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SKILL = ROOT / 'distribution' / 'agensi' / 'tetherplane'
PACKAGER = ROOT / 'scripts' / 'package-agensi-skill.py'
EXPECTED_FILES = {'SKILL.md', 'agents/openai.yaml', 'references/mcp-contract.md'}
SIX_TOOLS = ('device', 'files', 'process', 'browser', 'desktop', 'batch')


class AgensiSkillContractTests(unittest.TestCase):
    def test_public_display_name_and_mcp_tools(self):
        content = (SKILL / 'SKILL.md').read_text(encoding='utf-8')
        self.assertRegex(content, r'\A---\nname: tetherplane\ndescription: .+\n---\n')
        for tool in SIX_TOOLS:
            self.assertIn(chr(96) + tool + chr(96), content)
        metadata = (SKILL / 'agents' / 'openai.yaml').read_text(encoding='utf-8')
        self.assertRegex(metadata, r'(?m)^  display_name: tetherplane\s*$')
        self.assertNotRegex(content + metadata, r'(?i)native windows|native web test|tailf65eba\.ts\.net')

    def test_non_deceptive_security_and_prerequisites(self):
        content = (SKILL / 'SKILL.md').read_text(encoding='utf-8')
        for term in ('background_only', 'approval_required', 'permission_denied', 'paired', 'not an installer'):
            self.assertIn(term, content)
        self.assertNotIn('gh auth token', content)
        self.assertNotIn('Invoke-WebRequest', content)

    def test_secure_deterministic_zip(self):
        self.assertTrue(PACKAGER.is_file(), 'Agensi zip packager has not been implemented')
        with tempfile.TemporaryDirectory() as td:
            first = pathlib.Path(td) / 'first.zip'
            second = pathlib.Path(td) / 'second.zip'
            for dest in (first, second):
                p = subprocess.run([sys.executable, str(PACKAGER), '--source', str(SKILL), '--output', str(dest)], capture_output=True, text=True)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertEqual(hashlib.sha256(first.read_bytes()).hexdigest(), hashlib.sha256(second.read_bytes()).hexdigest())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(set(archive.namelist()), EXPECTED_FILES)
                self.assertTrue(all(not name.startswith('/') and '..' not in name.split('/') for name in archive.namelist()))
                self.assertEqual(archive.namelist().count('SKILL.md'), 1, 'Joeri requires SKILL.md directly at the ZIP root')
                self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) for i in archive.infolist()))

    def test_fails_closed_on_credential_like_file(self):
        self.assertTrue(PACKAGER.is_file(), 'Agensi zip packager has not been implemented')
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td) / 'tetherplane'
            shutil.copytree(SKILL, root)
            (root / '.env').write_text('DUMMY_TEST_VALUE=not-a-real-key\n', encoding='utf-8')
            output = pathlib.Path(td) / 'skill.zip'
            p = subprocess.run([sys.executable, str(PACKAGER), '--source', str(root), '--output', str(output)], capture_output=True, text=True)
            self.assertNotEqual(p.returncode, 0)
            self.assertFalse(output.exists())

    def test_fails_closed_on_symlink(self):
        self.assertTrue(PACKAGER.is_file(), 'Agensi zip packager has not been implemented')
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td) / 'tetherplane'
            shutil.copytree(SKILL, root)
            (root / 'references' / 'unexpected.md').symlink_to(root / 'SKILL.md')
            output = pathlib.Path(td) / 'skill.zip'
            p = subprocess.run([sys.executable, str(PACKAGER), '--source', str(root), '--output', str(output)], capture_output=True, text=True)
            self.assertNotEqual(p.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
