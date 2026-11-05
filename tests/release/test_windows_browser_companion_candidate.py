import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'release' / 'windows_browser_companion_candidate.py'


def synthetic_gui_pe():
    pe = bytearray(512)
    pe[:2] = b'MZ'
    struct.pack_into('<I', pe, 0x3c, 0x80)
    pe[0x80:0x84] = b'PE\x00\x00'
    struct.pack_into('<H', pe, 0x84, 0x8664)
    struct.pack_into('<H', pe, 0x98, 0x20b)
    struct.pack_into('<H', pe, 0x98+68, 2)
    return bytes(pe)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.holder = tempfile.TemporaryDirectory(prefix='tp-companion-test-')
        self.addCleanup(self.holder.cleanup)
        self.root = Path(self.holder.name)
        self.src = self.root / 'source'
        self.src.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.src)], check=True)
        (self.src / 'README.md').write_text('Disposable source\n', encoding='utf8')
        subprocess.run(['git', '-C', str(self.src), 'add', 'README.md'], check=True)
        subprocess.run(['git', '-C', str(self.src), '-c', 'user.name=Review Test',
                        '-c', 'user.email=review-test@localhost.invalid', 'commit', '-qm', 'initial'], check=True)
        self.sha = subprocess.check_output(['git', '-C', str(self.src), 'rev-parse', 'HEAD'], text=True).strip()
        self.inputs = self.root / 'inputs'
        self.inputs.mkdir()
        (self.inputs / 'tetherplane-browserw.exe').write_bytes(synthetic_gui_pe())
        (self.inputs / 'node.exe').write_bytes(b'MZ synthetic node')
        (self.inputs / 'LICENSE').write_text('Synthetic nonproduction fixture\n', encoding='utf8')
        (self.inputs / 'host.mjs').write_text('export const synthetic = true;\n', encoding='utf8')
        self.bridge = self.inputs / 'bridge'
        (self.bridge / 'dist').mkdir(parents=True)
        (self.bridge / 'dist' / 'index.js').write_text('export {}\n', encoding='utf8')
        (self.bridge / 'package.json').write_text('{"name":"synthetic-bridge"}\n', encoding='utf8')
        (self.bridge / 'node_modules' / 'ws').mkdir(parents=True)
        (self.bridge / 'node_modules' / 'ws' / 'index.js').write_text('module.exports = {}\n', encoding='utf8')
        self.ext = self.inputs / 'extension'
        (self.ext / 'dist').mkdir(parents=True)
        (self.ext / 'manifest.json').write_text('{"manifest_version":3}\n', encoding='utf8')
        (self.ext / 'pair.html').write_text('<html></html>\n', encoding='utf8')
        (self.ext / 'dist' / 'background.js').write_text('export {}\n', encoding='utf8')
        (self.ext / 'dist' / 'pair.js').write_text('export {}\n', encoding='utf8')

    def cli(self, *args):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.stderr, '', result.stderr)
        return result.returncode, json.loads(result.stdout)

    def stage(self, tag='one', source=None):
        args = ['stage', '--source-root', self.src, '--source-sha', source or self.sha,
                '--out-dir', self.root / ('staged-'+tag), '--archive', self.root / (tag+'.zip'),
                '--browserw', self.inputs / 'tetherplane-browserw.exe',
                '--node', self.inputs / 'node.exe', '--node-license', self.inputs / 'LICENSE',
                '--host', self.inputs / 'host.mjs', '--bridge', self.bridge, '--extension', self.ext]
        return self.cli(*args)

    def test_archive_is_byte_for_byte_repeatable(self):
        a, record_a = self.stage('first')
        b, record_b = self.stage('second')
        self.assertEqual((a, b), (0, 0))
        self.assertEqual(record_a['archive_sha256'], record_b['archive_sha256'])
        self.assertEqual(record_a['status'], 'PASS')
        self.assertEqual(record_a['release'], 'NO_GO')
        digest = hashlib.sha256((self.root/'first.zip').read_bytes()).hexdigest()
        code, verdict = self.cli('verify', '--archive', self.root/'first.zip',
                                 '--source-sha', self.sha, '--expected-sha', digest)
        self.assertEqual(code, 0)
        self.assertEqual(verdict['files_verified'], 11)
        with zipfile.ZipFile(self.root/'first.zip') as zf:
            manifest = json.loads(zf.read('candidate-manifest.json'))
        self.assertEqual(manifest['signed_msix'], False)
        self.assertEqual(manifest['source_provenance'], 'NOT_ATTESTED')

    def test_wrong_sha_rejected(self):
        code, report = self.stage('badsha', 'a'*40)
        self.assertEqual(code, 2)
        self.assertEqual(report['release'], 'NO_GO')

    def test_output_must_be_new(self):
        self.assertEqual(self.stage('occupied')[0], 0)
        self.assertEqual(self.stage('occupied')[0], 2)

    def test_wrong_archive_digest_rejected(self):
        self.assertEqual(self.stage('sha')[0], 0)
        code, _ = self.cli('verify', '--archive', self.root/'sha.zip', '--source-sha', self.sha,
                           '--expected-sha', 'f'*64)
        self.assertEqual(code, 2)

    def test_payload_modification_rejected(self):
        self.assertEqual(self.stage('tampered')[0], 0)
        archive = self.root/'tampered.zip'
        with zipfile.ZipFile(archive, 'a') as zf:
            zf.writestr('rogue.txt', 'unreviewed')
        code, _ = self.cli('verify', '--archive', archive, '--source-sha', self.sha)
        self.assertEqual(code, 2)

    def test_linked_payload_rejected(self):
        target = self.bridge/'dist'/'index.js'
        other = self.root/'other.js'
        other.write_text('evil', encoding='utf8')
        target.unlink()
        try:
            target.symlink_to(other)
        except OSError:
            self.skipTest('Host cannot create symlinks')
        self.assertEqual(self.stage('linked')[0], 2)

    def test_private_credential_file_rejected(self):
        (self.bridge/'device-credential.txt').write_text('should not package', encoding='utf8')
        self.assertEqual(self.stage('secret')[0], 2)

    def test_console_subsystem_is_not_accepted_as_browser_launcher(self):
        exe = self.inputs/'tetherplane-browserw.exe'
        data = bytearray(exe.read_bytes())
        struct.pack_into('<H', data, 0x98+68, 3)
        exe.write_bytes(data)
        self.assertEqual(self.stage('console')[0], 2)

    def test_unexpected_archive_zip_metadata_rejected(self):
        self.assertEqual(self.stage('corruptmeta')[0], 0)
        archive=self.root/'corruptmeta.zip'
        with zipfile.ZipFile(archive, 'r') as zf:
            members = [(i, zf.read(i)) for i in zf.namelist()]
        with zipfile.ZipFile(archive, 'w') as zf:
            for filename, data in members:
                zf.writestr(filename, data)
        self.assertEqual(self.cli('verify', '--archive', archive, '--source-sha', self.sha)[0], 2)


    def test_workflow_avoids_powershell_readonly_host_variable(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github' / 'workflows' /
                    'windows-browser-companion-quarantine.yml').read_text(encoding='utf-8')
        self.assertNotRegex(workflow, r'(?mi)^\s*\$host\s*=')
        self.assertIn("'--host', $hostBundle, '--bridge'", workflow)


if __name__ == '__main__':
    unittest.main(verbosity=2)
