import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills/tetherplane-starter"


class StarterGuidanceTests(unittest.TestCase):
    def test_missing_agent_requires_prerequisite_check(self):
        setup = (SKILL / "references/setup.md").read_text(encoding="utf-8").lower()
        for term in ("tetherd", "node.js", "pnpm", "--allow", "prerequisite"):
            self.assertIn(term, setup)

    def test_denied_operation_does_not_escalate(self):
        troubleshooting = (SKILL / "references/troubleshooting.md").read_text(encoding="utf-8").lower()
        for term in ("permission_denied", "human", "do not", "policy"):
            self.assertIn(term, troubleshooting)

    def test_capability_unavailable_is_reported(self):
        text = (SKILL / "references/troubleshooting.md").read_text(encoding="utf-8")
        self.assertIn("capability_unavailable", text)
        self.assertIn("unsupported", text.lower())

    def test_auth_error_never_requests_credentials_in_chat(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8").lower()
        self.assertIn("never request", text)
        self.assertIn("credentials", text)
        self.assertIn("credential", (SKILL / "references/troubleshooting.md").read_text(encoding="utf-8").lower())

    def test_remote_tcp_is_not_described_as_authenticated_rpc(self):
        text = (SKILL / "references/troubleshooting.md").read_text(encoding="utf-8").lower()
        for term in ("tcp", "authenticated", "rpc"):
            self.assertIn(term, text)

    def test_first_run_requires_read_only_status(self):
        text = (SKILL / "examples/safe-first-run.md").read_text(encoding="utf-8")
        self.assertIn("device.status", text)
        self.assertIn('"op": "status"', text)
        self.assertIn("read-only", text)


if __name__ == "__main__":
    unittest.main()
