#!/usr/bin/env python3
"""Deterministic, fail-closed Agensi SKILL.md ZIP packaging (stdlib only)."""
import argparse
import hashlib
import pathlib
import re
import sys
import zipfile

REQUIRED = {'SKILL.md', 'agents/openai.yaml', 'references/mcp-contract.md'}
ALLOWED = REQUIRED
MAX_SIZE = 25 * 1024 * 1024
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)


def package(source: pathlib.Path, output: pathlib.Path) -> str:
    if source.name != 'tetherplane' or not source.is_dir() or source.is_symlink():
        raise ValueError('the source must be a real tetherplane skill directory')
    if output.exists() or output.is_symlink():
        raise ValueError('refusing to overwrite an existing output')
    found = {}
    for item in source.rglob('*'):
        if item.is_symlink():
            raise ValueError('symlinks are prohibited in public skills')
        if item.is_dir():
            continue
        name = item.relative_to(source).as_posix()
        if name not in ALLOWED:
            raise ValueError('unexpected or unsafe skill file: ' + name)
        found[name] = item.read_bytes()
    if found.keys() != REQUIRED:
        raise ValueError('missing required Agensi skill resources: ' + ', '.join(sorted(REQUIRED - found.keys())))
    entry = found['SKILL.md'].decode('utf-8')
    if not re.match(r'\A---\nname: tetherplane\ndescription: [^\n]+\n---\n', entry):
        raise ValueError('SKILL.md frontmatter name and description are required')
    metadata = found['agents/openai.yaml'].decode('utf-8')
    if not re.search(r'(?m)^  display_name: tetherplane\s*$', metadata):
        raise ValueError('public plugin display name must be tetherplane')
    for tool in ('device', 'files', 'process', 'browser', 'desktop', 'batch'):
        if (chr(96) + tool + chr(96)) not in entry:
            raise ValueError('missing MCP tool: ' + tool)
    for name, content in found.items():
        if b'-----BEGIN ' in content or b'tailf65eba.ts.net' in content or re.search(rb'(?i)\b(?:ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9]{20,})\b', content):
            raise ValueError('possible secret/private transport in public skill: ' + name)
    if sum(map(len, found.values())) > MAX_SIZE:
        raise ValueError('skill exceeds Agensi upload size')
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name in sorted(found):
                info = zipfile.ZipInfo(name, date_time=ZIP_EPOCH)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, found[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        if output.stat().st_size > MAX_SIZE:
            raise ValueError('compressed skill ZIP exceeds 25MB')
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    return hashlib.sha256(output.read_bytes()).hexdigest()


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=pathlib.Path, required=True)
    p.add_argument('--output', type=pathlib.Path, required=True)
    args = p.parse_args()
    try:
        digest = package(args.source, args.output)
    except (ValueError, OSError, UnicodeDecodeError) as exc:
        print('AGENSI_PACKAGE_REJECTED: ' + str(exc), file=sys.stderr)
        return 1
    print('AGENSI_SKILL_OK: ' + str(args.output) + ' sha256=' + digest)
    return 0


if __name__ == '__main__':
    sys.exit(main())
