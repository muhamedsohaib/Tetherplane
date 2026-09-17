import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import emergency_relay as relay


class EmergencyRelayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name).resolve()
        (self.repo / "README.md").write_text("hello\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def request(self, op, args=None):
        return {
            "version": 1,
            "request_id": "11111111-1111-4111-8111-111111111111",
            "device_id": "Leno",
            "op": op,
            "args": args or {},
        }

    def test_rejects_path_escape(self):
        with self.assertRaises(relay.RequestError):
            relay.resolve_repo_path(self.repo, "../outside.txt")

    def test_file_lifecycle(self):
        write = self.request("files.write", {"path": "tmp.txt", "content": "alpha"})
        self.assertEqual(relay.execute_request(write, self.repo)["status"], "success")
        read = self.request("files.read", {"path": "tmp.txt"})
        self.assertEqual(relay.execute_request(read, self.repo)["data"]["content"], "alpha")
        delete = self.request("files.delete", {"path": "tmp.txt"})
        self.assertEqual(relay.execute_request(delete, self.repo)["status"], "success")
        self.assertFalse((self.repo / "tmp.txt").exists())

    def test_wrong_device_is_denied(self):
        req = self.request("device.status")
        req["device_id"] = "Surface"
        result = relay.execute_request(req, self.repo)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "permission_denied")

    def test_process_program_allowlist(self):
        req = self.request("process.run", {
            "program": "powershell.exe",
            "arguments": ["-NoProfile", "-Command", "Get-ChildItem C:\\"],
        })
        result = relay.execute_request(req, self.repo)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "permission_denied")

    def test_device_status_identifies_leno(self):
        result = relay.execute_request(self.request("device.status"), self.repo)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["device_id"], "Leno")

    def test_harmless_process_runs(self):
        req = self.request("process.run", {
            "kind": "hostname",
            "timeout_seconds": 5,
        })
        result = relay.execute_request(req, self.repo)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["exit_code"], 0)
        self.assertTrue(result["data"]["stdout"].strip())

    def test_malformed_request_is_rejected(self):
        result = relay.execute_request({"version": 1}, self.repo)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_arguments")


if __name__ == "__main__":
    unittest.main()

