import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[2] / 'scripts' / 'audit_all_refs.py'
spec = importlib.util.spec_from_file_location('audit_all_refs', MODULE)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

def git(repo, *args):
    p = subprocess.run(['git', '-C', str(repo), *args],
                       capture_output=True, text=True, check=True)
    return p.stdout.strip()

class AllReferencesTests(unittest.TestCase):
    def test_branch_only_history_and_authors(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            git(repo, 'init', '-b', 'main')
            git(repo, 'config', 'user.name', 'Sohaib')
            git(repo, 'config', 'user.email', 'example@invalid.test')
            (repo / 'one.txt').write_text('one', encoding='utf-8')
            git(repo, 'add', 'one.txt')
            git(repo, 'commit', '-m', 'first')
            git(repo, 'tag', 'v0.1.0')
            git(repo, 'switch', '-c', 'feature/example')
            git(repo, 'config', 'user.name', 'Tetherplane Automation')
            (repo / 'two.txt').write_text('two', encoding='utf-8')
            git(repo, 'add', 'two.txt')
            git(repo, 'commit', '-m', 'second')
            report = audit.inventory_git(repo, base_ref='refs/heads/main')
            self.assertEqual(report['total_reachable_commits'], 2)
            self.assertEqual(report['commits_not_on_base'], 1)
            self.assertEqual(report['contributor_author_labels'],
                             {'Sohaib': 1, 'Tetherplane Automation': 1})
            self.assertIn('refs/tags/v0.1.0', report['refs'])
            self.assertTrue(report['non_operative'])

    def test_missing_base_ref_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            git(repo, 'init', '-b', 'main')
            with self.assertRaisesRegex(ValueError, 'Base ref'):
                audit.inventory_git(repo, base_ref='refs/remotes/origin/missing')

if __name__ == '__main__':
    unittest.main()
