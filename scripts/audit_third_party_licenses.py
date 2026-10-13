#!/usr/bin/env python3
"""Read-only lockfile inventory and optional public-registry license metadata audit.

NON-OPERATIVE: registry metadata is unverified evidence, not legal clearance.
This script never runs installer, build, npm, or package lifecycle commands.
"""

import argparse
import collections
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import time
import tomllib
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

USER_AGENT = 'Tetherplane-License-Evidence/0.1 (https://github.com/muhamedsohaib/Tetherplane)'
PERMISSIVE = {
    'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD',
    'Zlib', 'Unlicense', 'CC0-1.0', 'Python-2.0', 'Unicode-3.0',
}


def parse_cargo_lock(data: bytes):
    decoded = tomllib.loads(data.decode('utf-8'))
    return sorted(
        ({'ecosystem': 'cargo', 'name': p['name'], 'version': p['version']}
         for p in decoded['package'] if p.get('source', '').startswith('registry+')),
        key=lambda p: (p['name'], p['version']),
    )


def parse_pnpm_lock(text: str):
    if '\npackages:\n' not in text or '\nsnapshots:\n' not in text:
        raise ValueError('pnpm-lock.yaml requires packages and snapshots sections')
    section = text.split('\npackages:\n', 1)[1].split('\nsnapshots:\n', 1)[0]
    records = []
    for line in section.splitlines():
        match = re.fullmatch(r'  ([^ \t].*):\s*', line)
        if not match:
            continue
        key = match.group(1).strip().strip("'\"")
        if '@' not in key[1:] or key.rfind('@') < 1:
            raise ValueError(f'Unexpected pnpm key format: {key}')
        name, version = key.rsplit('@', 1)
        records.append({'ecosystem': 'npm', 'name': name, 'version': version})
    if not records:
        raise ValueError('No npm registry entries found in pnpm lockfile')
    return sorted(records, key=lambda p: (p['name'], p['version']))


def normalize_license(value):
    if isinstance(value, dict):
        value = value.get('type')
    if isinstance(value, list):
        value = ' OR '.join(filter(None, (normalize_license(x) for x in value)))
    return value.strip() if isinstance(value, str) and value.strip() else None


def classify_license(license_expression):
    if not license_expression:
        return 'review-missing'
    expression = license_expression.strip()
    alternatives = [part.strip(' ()') for part in re.split(r'\s+OR\s+', expression)]
    if (len(alternatives) > 1 and any(part in PERMISSIVE for part in alternatives)
            and any(re.search(r'(?i)(?:A?GPL|LGPL)', part) for part in alternatives)):
        return 'review-alternative-copyleft'
    if re.search(r'(?i)(?:A?GPL|LGPL|MPL|EPL|CDDL|SSPL|BUSL|PROPRIETARY|UNLICENSED|COMMONS CLAUSE)', expression):
        return 'review-copyleft'
    if re.search(r'(?i)(?:SEE LICENSE|CUSTOM|UNKNOWN|NOASSERTION)', expression):
        return 'review-ambiguous'
    atoms = [part.strip().strip('() ') for part in re.split(r'\s+(?:OR|AND)\s+', expression)]
    if atoms and all(x in PERMISSIVE for x in atoms):
        return 'permissive-declared'
    return 'review-ambiguous'


def metadata_endpoint(pkg):
    name, version = quote(pkg['name'], safe='@'), quote(pkg['version'], safe='')
    if pkg['ecosystem'] == 'cargo':
        return f'https://crates.io/api/v1/crates/{name}/{version}'
    if pkg['ecosystem'] == 'npm':
        return f'https://registry.npmjs.org/{name}/{version}'
    raise ValueError('Unknown ecosystem')


def lookup_license(pkg):
    endpoint = metadata_endpoint(pkg)
    last_error = None
    for attempt in range(2):
        try:
            req = Request(endpoint, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
            with urlopen(req, timeout=12) as resp:
                result = json.load(resp)
            value = result.get('version', {}).get('license') if pkg['ecosystem'] == 'cargo' else result.get('license')
            declared = normalize_license(value)
            return {'source_url': endpoint, 'license_declared': declared, 'status': 'fetched',
                    'classification': classify_license(declared)}
        except HTTPError as exc:
            last_error = f'HTTP {exc.code}'
            if exc.code not in (429, 500, 502, 503, 504):
                break
        except (URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            last_error = type(exc).__name__
        if attempt == 0:
            time.sleep(0.8)
    return {'source_url': endpoint, 'license_declared': None, 'status': 'fetch-error',
            'classification': 'review-fetch-error', 'error': last_error}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cargo-lock', type=Path, required=True)
    parser.add_argument('--pnpm-lock', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fetch-metadata', action='store_true', help='Make bounded requests to public registry APIs')
    parser.add_argument('--workers', type=int, default=3)
    args = parser.parse_args(argv)
    if args.workers not in range(1, 6):
        parser.error('workers must be 1 through 5')
    cargo = args.cargo_lock.read_bytes()
    pnpm = args.pnpm_lock.read_bytes()
    rows = parse_cargo_lock(cargo) + parse_pnpm_lock(pnpm.decode('utf-8'))
    if not rows:
        raise ValueError('Empty lockfile inventory')
    if args.fetch_metadata:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(lookup_license, row): i for i, row in enumerate(rows)}
            for future in as_completed(futures):
                i = futures[future]
                try:
                    rows[i].update(future.result())
                except Exception as exc:
                    rows[i].update({'status': 'fetch-error', 'classification': 'review-fetch-error',
                                    'error': type(exc).__name__})
    else:
        for row in rows:
            row.update({'status': 'not-fetched', 'classification': 'review-not-fetched',
                        'license_declared': None})
    classifications = dict(sorted(collections.Counter(x['classification'] for x in rows).items()))
    statuses = dict(sorted(collections.Counter(x['status'] for x in rows).items()))
    report = {
        'warning': 'PRELIMINARY, NON-OPERATIVE: registry license declarations are not legal compatibility clearance or installed-binary SBOM.',
        'generated_utc': datetime.now(timezone.utc).isoformat(),
        'cargo_lock_sha256': hashlib.sha256(cargo).hexdigest(),
        'pnpm_lock_sha256': hashlib.sha256(pnpm).hexdigest(),
        'fetch_metadata': args.fetch_metadata,
        'dependency_entry_count': len(rows),
        'counts_by_status': statuses,
        'counts_by_classification': classifications,
        'cargo_entries': sum(x['ecosystem'] == 'cargo' for x in rows),
        'npm_entries': sum(x['ecosystem'] == 'npm' for x in rows),
        'dependencies': rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'dependencies'}, indent=2))
    # Fetched records with missing/ambiguous licenses require human review;
    # genuine registry fetch errors additionally block the evidence collection gate.
    return 1 if args.fetch_metadata and any(x['status'] == 'fetch-error' for x in rows) else 0


if __name__ == '__main__':
    sys.exit(main())
