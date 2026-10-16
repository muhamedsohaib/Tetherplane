import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class ListingTests(unittest.TestCase):
    def test_draft_free_and_unsubmitted(self):
        draft = (ROOT / "docs/distribution/agensi-starter-listing-draft.md").read_text(encoding="utf-8")
        self.assertIn("Free", draft)
        self.assertIn("Not submitted", draft)
        self.assertIn("tetherplane-starter", draft)

    def test_readme_links_free_skill(self):
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("skills/tetherplane-starter/README.md", text)

    def test_no_unverified_host_or_remote_claims(self):
        text = (ROOT / "docs/distribution/agensi-starter-listing-draft.md").read_text(encoding="utf-8").lower()
        for term in ("not tested", "authenticated", "remote", "no guaranteed"):
            self.assertIn(term, text)


if __name__ == "__main__":
    unittest.main()
