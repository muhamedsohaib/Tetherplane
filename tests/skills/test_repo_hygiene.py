import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/check_repo_hygiene.py"


def make_repo(folder: Path) -> Path:
    subprocess.run(["git", "init", "-q", str(folder)], check=True, capture_output=True)
    return folder


def run_guard(folder: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["python", str(SCRIPT)], cwd=folder, text=True, capture_output=True)


class RepoHygieneTests(unittest.TestCase):
    def test_rejects_tracked_env_but_never_echoes_its_value(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = make_repo(Path(temp) / "repo")
            value = "DO_NOT_LOG_SECRET_VALUE"
            (repo / ".env").write_text("PASSWORD=" + value + "\n")
            subprocess.run(["git", "add", ".env"], cwd=repo, check=True)
            result = run_guard(repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(".env", result.stdout)
            self.assertNotIn(value, result.stdout + result.stderr)

    def test_accepts_env_example_with_only_placeholders(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = make_repo(Path(temp) / "repo")
            (repo / ".env.example").write_text("TOKEN=YOUR_TOKEN_HERE\n")
            subprocess.run(["git", "add", ".env.example"], cwd=repo, check=True)
            result = run_guard(repo)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_rejects_embedded_private_key_without_outputting_payload(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = make_repo(Path(temp) / "repo")
            value = "SENSITIVE_TEST_PAYLOAD_DO_NOT_PRINT"
            marker = "-----BEGIN " + "PRIVATE KEY-----"
            (repo / "secret.txt").write_text(marker + "\n" + value + "\n")
            subprocess.run(["git", "add", "secret.txt"], cwd=repo, check=True)
            result = run_guard(repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("secret.txt", result.stdout)
            self.assertNotIn(value, result.stdout + result.stderr)

    def test_rejects_tracked_build_artifacts(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = make_repo(Path(temp) / "repo")
            target = repo / "node_modules" / "pkg" / "index.js"
            target.parent.mkdir(parents=True)
            target.write_text("module.exports = 1;\n")
            subprocess.run(["git", "add", "node_modules/pkg/index.js"], cwd=repo, check=True)
            result = run_guard(repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("node_modules", result.stdout)

    def test_repo_ignores_common_private_and_generated_paths(self):
        ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
        for pattern in (".env", ".env.*", "!.env.example", ".venv/", ".superpowers/", "*.pfx", "*.pem", "node_modules/"):
            self.assertIn(pattern, ignore)


if __name__ == "__main__":
    unittest.main()
