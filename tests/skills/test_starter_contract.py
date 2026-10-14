import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills/tetherplane-starter"


class StarterContractTests(unittest.TestCase):
    def test_minimal_frontmatter_matches_folder(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertRegex(text, r"(?s)\A---\nname: tetherplane-starter\ndescription: .{30,300}\n---\n")
        self.assertIn("Use when", text.split("---", 2)[1])

    def test_exact_six_mcp_tools_documented(self):
        text = (SKILL / "references/operations.md").read_text(encoding="utf-8")
        tools = set(re.findall(r"(?m)^- `((?:device|files|process|browser|desktop|batch))`(?:\s|$)", text))
        self.assertEqual(tools, {"device", "files", "process", "browser", "desktop", "batch"})

    def test_read_only_first_call_is_device_status(self):
        example = json.loads((SKILL / "examples/first-run.json").read_text(encoding="utf-8"))
        self.assertEqual(example[0], {"name": "device", "arguments": {"op": "status", "args": {}}})
        self.assertTrue(all(call["name"] == "device" for call in example))
        self.assertTrue(all(call["arguments"]["op"] in {"status", "schema"} for call in example))


if __name__ == "__main__":
    unittest.main()
