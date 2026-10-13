#!/usr/bin/env python3
"""NON-OPERATIVE: read-only provenance inventory of all fetched Git refs.

Commit author labels do not establish copyright title. This tool does not
independently verify contracts or rights, and never outputs email addresses.
"""
import argparse
import collections
import json
from pathlib import Path
import subprocess


def git(repo, *args):
    proc = subprocess.run(['git', '-C', str(repo), *args],
                          capture_output=True, text=True, check=True)
    return proc.stdout.strip()


def inventory_git(repo, base_ref='refs/remotes/origin/main'):
    repo = Path(repo)
    try:
        git(repo, 'rev-parse', '--verify', base_ref)
    except subprocess.CalledProcessError as exc:
        raise ValueError('Base ref not found in local checkout') from exc
    refs = sorted(git(repo, 'for-each-ref', '--format=%(refname)',
                      'refs/heads', 'refs/remotes', 'refs/tags').splitlines())
    total = int(git(repo, 'rev-list', '--all', '--count'))
    not_on_base = int(git(repo, 'rev-list', '--all', '--not', base_ref, '--count'))
    names = git(repo, 'log', '--all', '--format=%aN').splitlines()
    authors = dict(sorted(collections.Counter(names).items()))
    return {
        'non_operative': True,
        'warning': 'NOT independent copyright/title, contributor permission or license clearance',
        'inspected_checkout_head': git(repo, 'rev-parse', 'HEAD'),
        'base_ref': base_ref,
        'base_sha': git(repo, 'rev-parse', base_ref),
        'reference_count': len(refs),
        'refs': refs,
        'total_reachable_commits': total,
        'commits_not_on_base': not_on_base,
        'contributor_author_labels': authors,
        'unmerged_commit_author_labels_are_not_rights_holders': True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path('.'))
    parser.add_argument('--base-ref', default='refs/remotes/origin/main')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = inventory_git(args.repo, args.base_ref)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k != 'refs'}, indent=2))


if __name__ == '__main__':
    main()
