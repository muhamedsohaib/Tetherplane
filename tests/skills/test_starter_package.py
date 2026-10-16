import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/package_starter_skill.py"


def load_package_module():
    spec = importlib.util.spec_from_file_location("starter_packager", SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError("package_starter_skill.py missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StarterPackageTests(unittest.TestCase):
    def test_single_root_and_expected_members(self):
        package = load_package_module()
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "starter.zip"
            package.build_starter_archive(ROOT, dest)
            with zipfile.ZipFile(dest) as archive:
                names = archive.namelist()
            self.assertIn("tetherplane-starter/SKILL.md", names)
            self.assertTrue(all(name.startswith("tetherplane-starter/") for name in names))
            self.assertNotIn("SKILL.md", names)
            self.assertEqual(len(names), len(set(names)))

    def test_reproducible_bytes(self):
        package = load_package_module()
        with tempfile.TemporaryDirectory() as td:
            first, second = Path(td) / "first.zip", Path(td) / "second.zip"
            package.build_starter_archive(ROOT, first)
            package.build_starter_archive(ROOT, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_rejects_source_file_output_without_overwrite(self):
        package = load_package_module()
        with tempfile.TemporaryDirectory() as td:
            import shutil
            src = Path(td) / "repo"
            shutil.copytree(ROOT / "skills/tetherplane-starter", src / "skills/tetherplane-starter")
            for name in ("LICENSE", "LICENSE-MIT", "LICENSE-APACHE"):
                shutil.copy2(ROOT / name, src / name)
            dest = src / "LICENSE"
            original = dest.read_bytes()
            with self.assertRaises(FileExistsError):
                package.build_starter_archive(src, dest)
            self.assertEqual(dest.read_bytes(), original)

    def test_rejects_existing_output_without_overwrite(self):
        package = load_package_module()
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "existing-output.txt"
            original = b"Preserve this existing output sentinel.\n"
            dest.write_bytes(original)
            with self.assertRaises(FileExistsError):
                package.build_starter_archive(ROOT, dest)
            self.assertEqual(dest.read_bytes(), original)

    def test_rejects_unexpected_env_or_binary(self):
        package = load_package_module()
        with tempfile.TemporaryDirectory() as td:
            import shutil
            src = Path(td) / "repo"
            shutil.copytree(ROOT / "skills/tetherplane-starter", src / "skills/tetherplane-starter")
            for name in ("LICENSE", "LICENSE-MIT", "LICENSE-APACHE"):
                shutil.copy2(ROOT / name, src / name)
            for filename in (".env", "unexpected.exe"):
                extra = src / "skills/tetherplane-starter" / filename
                extra.write_text("test fixture", encoding="utf-8")
                with self.assertRaises(ValueError):
                    package.build_starter_archive(src, Path(td) / "bad.zip")
                extra.unlink()

    def test_rejects_symlink_and_path_escape(self):
        package = load_package_module()
        with self.assertRaises(ValueError):
            package.validate_member_path("../escape")
        with self.assertRaises(ValueError):
            package.validate_member_path("/absolute")
        with tempfile.TemporaryDirectory() as td:
            import shutil
            src = Path(td) / "repo"
            shutil.copytree(ROOT / "skills/tetherplane-starter", src / "skills/tetherplane-starter")
            for name in ("LICENSE", "LICENSE-MIT", "LICENSE-APACHE"):
                shutil.copy2(ROOT / name, src / name)
            link = src / "skills/tetherplane-starter" / "references" / "link.md"
            try:
                link.symlink_to(Path(td) / "secret-outside-skill")
            except OSError:
                self.skipTest("symlinks unavailable on this host")
            with self.assertRaises(ValueError):
                package.build_starter_archive(src, Path(td) / "bad.zip")

    def test_bundles_full_dual_license_texts(self):
        package = load_package_module()
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "starter.zip"
            package.build_starter_archive(ROOT, dest)
            with zipfile.ZipFile(dest) as archive:
                for filename in ("LICENSE", "LICENSE-MIT", "LICENSE-APACHE"):
                    self.assertEqual(archive.read(f"tetherplane-starter/{filename}"), (ROOT / filename).read_bytes())


if __name__ == "__main__":
    unittest.main()
