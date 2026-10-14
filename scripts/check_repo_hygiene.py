"""Check tracked repository files for dangerous paths and high-confidence secret markers.

Only prints paths and rule names; never logs matching file contents or values.
"""
from __future__ import annotations

from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

PRIVATE_SEGMENTS = frozenset({
    "node_modules", "dist", "target", "coverage", "__pycache__",
    ".venv", ".idea", ".vscode", ".superpowers", ".pytest_cache",
})
SECRET_SUFFIXES = frozenset({".pem", ".key", ".pfx", ".p12", ".kdbx"})
TEXT_SUFFIXES = frozenset({
    ".md", ".txt", ".py", ".ts", ".tsx", ".js", ".mjs", ".json",
    ".yaml", ".yml", ".toml", ".rs", ".ps1", ".sh", ".html",
    ".css", ".xml", ".ini", ".cfg", ".example", ".gitignore",
})
PATTERNS = (
    ("private_key_block", re.compile(r"-----BEGIN " + r"(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_personal_token", re.compile(r"\bghp_[A-Za-z0-9]{36}\b")),
    ("github_fine_grained_token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,}\b")),
    ("openai_project_key", re.compile(r"\bsk-proj-[A-Za-z0-9_-]{24,}\b")),
    ("stripe_live_key", re.compile(r"\bsk_live_[0-9a-zA-Z]{24,}\b")),
)


def check_paths(root: Path, paths: list[str]) -> list[tuple[str, str]]:
    issues: list[tuple[str, str]] = []
    for name in paths:
        path = PurePosixPath(name)
        basename = path.name.lower()
        if any(part.lower() in PRIVATE_SEGMENTS for part in path.parts):
            issues.append((name, "generated_or_private_directory"))
            continue
        if basename.startswith(".env") and basename != ".env.example":
            issues.append((name, "environment_file"))
            continue
        if basename in ("thumbs.db", ".ds_store") or path.suffix.lower() in SECRET_SUFFIXES:
            issues.append((name, "private_key_or_junk_file"))
            continue
        origin = root / name
        if origin.is_symlink():
            issues.append((name, "tracked_symlink_requires_review"))
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES and basename not in ("license", ".gitignore", ".gitattributes"):
            continue
        if not origin.exists() or origin.stat().st_size > 2_000_000:
            issues.append((name, "missing_or_oversize_text_file"))
            continue
        content = origin.read_bytes().decode("utf-8", errors="replace")
        for reason, pattern in PATTERNS:
            if pattern.search(content):
                issues.append((name, reason))
                break
    return issues


def main() -> int:
    root = Path.cwd()
    listing = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True)
    if listing.returncode != 0:
        print("REPO_HYGIENE_ERROR git tracked-file inventory unavailable", file=sys.stderr)
        return 2
    names = [s.decode("utf-8", errors="replace") for s in listing.stdout.split(b"\0") if s]
    issues = check_paths(root, names)
    for filename, reason in issues:
        print(f"REPO_HYGIENE_FAIL {reason}: {filename}")
    if issues:
        print(f"REPO_HYGIENE_BLOCKED {len(issues)} finding(s); values were not printed")
        return 1
    print(f"REPO_HYGIENE_OK tracked_files={len(names)}; secret values not printed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
