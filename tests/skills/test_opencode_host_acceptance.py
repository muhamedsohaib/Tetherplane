import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile, ZipInfo

from opencode_host_acceptance import unpack_starter_archive

ROOT = Path(__file__).resolve().parents[2]


class OpenCodeHostAcceptanceTests(unittest.TestCase):
    def test_verified_package_extracts_only_starter_skill(self):
        with tempfile.TemporaryDirectory(prefix="starter-test-") as directory:
            root = Path(directory)
            package = root / "starter.zip"
            subprocess.run(
                [sys.executable, str(ROOT / "scripts/package_starter_skill.py"), "--output", str(package)],
                check=True,
                capture_output=True,
                text=True,
            )
            destination = root / "host"
            unpack_starter_archive(package, destination)
            skill = destination / ".opencode/skills/tetherplane-starter/SKILL.md"
            self.assertTrue(skill.is_file())
            self.assertIn("name: tetherplane-starter", skill.read_text(encoding="utf-8"))
            self.assertEqual(
                len([p for p in (destination / ".opencode/skills/tetherplane-starter").rglob("*") if p.is_file()]),
                11,
            )

    def test_foreign_member_rejected_before_file_extraction(self):
        with tempfile.TemporaryDirectory(prefix="starter-bad-") as directory:
            root = Path(directory)
            package = root / "bad.zip"
            with ZipFile(package, "w") as archive:
                archive.writestr("tetherplane-starter/../../outside.txt", "untrusted")
            destination = root / "host"
            with self.assertRaisesRegex(ValueError, "unexpected or unsafe"):
                unpack_starter_archive(package, destination)
            self.assertFalse(destination.exists())

    def test_zip_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="starter-link-") as directory:
            root = Path(directory)
            package = root / "link.zip"
            info = ZipInfo("tetherplane-starter/SKILL.md")
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            with ZipFile(package, "w") as archive:
                archive.writestr(info, "---\nname: tetherplane-starter\ndescription: test\n---\n")
            with self.assertRaisesRegex(ValueError, "symlink|unsafe"):
                unpack_starter_archive(package, root / "host")


if __name__ == "__main__":
    unittest.main()
