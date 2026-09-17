import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import emergency_relay as relay


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8")


class RelaySyncTests(unittest.TestCase):
    def _fixture(self, root: Path):
        remote = root / "remote.git"
        seed = root / "seed"
        git(root, "init", "--bare", "--initial-branch=main", str(remote))
        git(root, "clone", str(remote), str(seed))
        git(seed, "config", "user.email", "test@example.invalid")
        git(seed, "config", "user.name", "relay-test")
        (seed / "README.md").write_text("main\n", encoding="utf-8")
        git(seed, "add", "README.md")
        git(seed, "commit", "-m", "seed main")
        git(seed, "push", "origin", "main")
        git(seed, "checkout", "-b", "relay/emergency-leno")
        (seed / "relay.txt").write_text("relay\n", encoding="utf-8")
        git(seed, "add", "relay.txt")
        git(seed, "commit", "-m", "seed relay")
        git(seed, "push", "origin", "relay/emergency-leno")
        return remote, seed

    def test_clone_and_sync_use_requested_branch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            remote, seed = self._fixture(root)
            worker = root / "worker"
            relay.ensure_mailbox(worker, str(remote), "relay/emergency-leno")
            self.assertEqual(git(worker, "branch", "--show-current").stdout.strip(), "relay/emergency-leno")
            self.assertEqual((worker / "relay.txt").read_text(encoding="utf-8"), "relay\n")
            (seed / "requests").mkdir()
            (seed / "requests" / "r.json").write_text("remote\n", encoding="utf-8")
            git(seed, "add", "requests/r.json")
            git(seed, "commit", "-m", "add request")
            git(seed, "push", "origin", "relay/emergency-leno")
            relay.sync_mailbox(worker, "relay/emergency-leno")
            self.assertEqual((worker / "requests" / "r.json").read_text(encoding="utf-8"), "remote\n")

    def test_sync_discards_conflicting_untracked_mailbox_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            remote, seed = self._fixture(root)
            worker = root / "worker"
            relay.ensure_mailbox(worker, str(remote), "relay/emergency-leno")
            (worker / "requests").mkdir()
            (worker / "requests" / "r.json").write_text("stale-local\n", encoding="utf-8")
            (seed / "requests").mkdir()
            (seed / "requests" / "r.json").write_text("remote\n", encoding="utf-8")
            git(seed, "add", "requests/r.json")
            git(seed, "commit", "-m", "add request")
            git(seed, "push", "origin", "relay/emergency-leno")
            relay.sync_mailbox(worker, "relay/emergency-leno")
            self.assertEqual((worker / "requests" / "r.json").read_text(encoding="utf-8"), "remote\n")


    def test_publish_result_configures_identity_and_pushes_requested_branch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            remote, _seed = self._fixture(root)
            worker = root / "worker"
            relay.ensure_mailbox(worker, str(remote), "relay/emergency-leno")
            result_file = root / "result.json"
            result_file.write_text("{}\n", encoding="utf-8")
            relay.publish_result(worker, result_file, "11111111-1111-4111-8111-111111111111", "relay/emergency-leno")
            verify = root / "verify"
            git(root, "clone", "--branch", "relay/emergency-leno", str(remote), str(verify))
            self.assertEqual((verify / "results" / "11111111-1111-4111-8111-111111111111.json").read_text(encoding="utf-8"), "{}\n")


if __name__ == "__main__":
    unittest.main()
