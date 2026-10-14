"""Deterministically package only audited Tetherplane Starter skill text files."""
from __future__ import annotations

import argparse
from pathlib import Path, PurePosixPath
import zipfile

SKILL_SLUG = "tetherplane-starter"
SKILL_FILES = frozenset({
    "SKILL.md",
    "README.md",
    "agents/openai.yaml",
    "references/operations.md",
    "references/setup.md",
    "references/troubleshooting.md",
    "examples/safe-first-run.md",
    "examples/first-run.json",
})
LICENSE_FILES = frozenset({"LICENSE", "LICENSE-MIT", "LICENSE-APACHE"})
MAX_FILE_SIZE = 128 * 1024
MAX_TOTAL_SIZE = 512 * 1024


def validate_member_path(name: str) -> str:
    if not name or "\\" in name or "\0" in name or any(ord(c) < 32 for c in name):
        raise ValueError("unsafe ZIP member path")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "." in path.parts or str(path) != name:
        raise ValueError("unsafe ZIP member path")
    if name.startswith("/") or name.startswith(".") or ":" in name:
        raise ValueError("unsafe ZIP member path")
    return name


def build_starter_archive(repo_root: Path, output_path: Path) -> Path:
    root = repo_root.resolve(strict=True)
    skill_dir = root / "skills" / SKILL_SLUG
    if not skill_dir.is_dir() or skill_dir.is_symlink():
        raise ValueError("expected a normal starter skill directory")
    found = set()
    for entry in skill_dir.rglob("*"):
        if entry.is_symlink():
            raise ValueError("symlinks are not allowed in the starter skill")
        if entry.is_dir():
            continue
        if not entry.is_file():
            raise ValueError("unexpected non-file entry in skill")
        relative = entry.relative_to(skill_dir).as_posix()
        validate_member_path(relative)
        if relative not in SKILL_FILES:
            raise ValueError("unexpected file in starter skill: " + relative)
        found.add(relative)
    if found != SKILL_FILES:
        raise ValueError("starter skill is missing required files: " + ", ".join(sorted(SKILL_FILES - found)))

    sources: dict[str, bytes] = {}
    for relative in sorted(SKILL_FILES | LICENSE_FILES):
        origin = root / relative if relative in LICENSE_FILES else skill_dir / relative
        if origin.is_symlink() or not origin.is_file() or not origin.resolve().is_relative_to(root):
            raise ValueError("invalid package source: " + relative)
        member = validate_member_path(f"{SKILL_SLUG}/{relative}")
        payload = origin.read_bytes()
        if not payload or len(payload) > MAX_FILE_SIZE or b"\x00" in payload:
            raise ValueError("invalid size or binary data in: " + relative)
        try:
            payload.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("only UTF-8 text is allowed: " + relative) from error
        sources[member] = payload
    if sum(map(len, sources.values())) > MAX_TOTAL_SIZE:
        raise ValueError("starter skill exceeds size cap")

    output_path = output_path.resolve(strict=False)
    if output_path.is_relative_to(skill_dir):
        raise ValueError("output must be outside skill directory")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w") as archive:
        for member in sorted(sources):
            info = zipfile.ZipInfo(member, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, sources[member], compresslevel=9)
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    result = build_starter_archive(repo_root, args.output)
    print(f"Packaged vetted skill: {result.name}")


if __name__ == "__main__":
    main()
