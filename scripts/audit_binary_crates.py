#!/usr/bin/env python3
"""NON-OPERATIVE static Rust compiler-path evidence from a published Tetherplane ZIP.

No execution of the binary; NOT a complete static linkage manifest or legal clearance.
"""
import argparse
import collections
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tomllib
import zipfile

CARGO_REGISTRY_PATH = re.compile(
    rb'\.cargo[\\/]registry[\\/]src[\\/][^\\/\x00]{1,120}'
    rb'[\\/]([A-Za-z0-9_-]+)-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._+-]+)?)'
    rb'[\\/]'
)

def scan_registry_paths(binary):
    hits = collections.Counter((m.group(1).decode('ascii'), m.group(2).decode('ascii'))
                               for m in CARGO_REGISTRY_PATH.finditer(binary))
    return [dict(name=name, version=version, path_references=count)
            for (name, version), count in sorted(hits.items())]

def parse_registry_lock(cargo_lock):
    packages = tomllib.loads(cargo_lock.decode('utf-8'))['package']
    return {(p['name'], p['version']) for p in packages
            if p.get('source','').startswith('registry+')}

def audit_zip(archive, cargo_lock, expected_sha256=''):
    digest = hashlib.sha256(archive).hexdigest()
    if expected_sha256 and digest.lower() != expected_sha256.lower():
        raise ValueError('Release archive SHA-256 mismatch')
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        if 'bin/tetherd.exe' not in z.namelist():
            raise ValueError('Missing bin/tetherd.exe in release ZIP')
        binary = z.read('bin/tetherd.exe')
    if binary[:2] != b'MZ':
        raise ValueError('Executable does not contain expected PE MZ header')
    evidence = scan_registry_paths(binary)
    locked = parse_registry_lock(cargo_lock)
    unmatched = [p for p in evidence if (p['name'],p['version']) not in locked]
    return {
        'warning': 'NON-OPERATIVE: positive Rust compiler-path indications, NOT complete linkage or legal clearance',
        'release_zip_sha256': digest,
        'binary_sha256': hashlib.sha256(binary).hexdigest(),
        'binary_bytes': len(binary),
        'compiler_path_occurrences': sum(p['path_references'] for p in evidence),
        'observed_unique_registry_crates': len(evidence),
        'observed_lockfile_matches': len(evidence)-len(unmatched),
        'missing_in_lock': unmatched,
        'is_complete_linkage_manifest': False,
        'caveat': 'Absent path does not exclude a statically linked crate. Runtime/linker analysis is still required.',
        'crates': evidence,
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-zip', required=True, type=Path)
    parser.add_argument('--cargo-lock', required=True, type=Path)
    parser.add_argument('--expected-sha256', default='')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = audit_zip(args.release_zip.read_bytes(),args.cargo_lock.read_bytes(),
                       args.expected_sha256)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k!='crates'},indent=2))
    return 0 if not result['missing_in_lock'] else 1

if __name__=='__main__':
    sys.exit(main())
