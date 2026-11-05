#!/usr/bin/env python3
"""Create/verify an unsigned, source-pinned, deterministic Windows browser companion.

This file has no installation, signing, network, or owner-enrollment operations.
It makes bit-identical ZIP archives when the same verified payload bytes are supplied.
The source SHA binds an asserted checkout identity, NOT a signed provenance claim.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import zipfile

SCHEMA = "tetherplane.browser-companion-candidate.v1"
SOURCE_PATTERN = __import__("re").compile(r"^[0-9a-f]{40}$")
HASH_PATTERN = __import__("re").compile(r"^[0-9a-f]{64}$")
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
MAX_FILES = 25000
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
BLOCK = 1024 * 1024
MANIFEST = "candidate-manifest.json"
FORBIDDEN_NAMES = {".env", "principal.json", "device-credential.txt"}
FORBIDDEN_SUFFIXES = (".pfx", ".p12", ".pem", ".key", ".cer", ".crt")


class Rejected(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


def sha256_file(file):
    hash_ = hashlib.sha256()
    size = 0
    with open(file, "rb") as stream:
        while True:
            chunk = stream.read(BLOCK)
            if not chunk:
                return {"size": size, "sha256": hash_.hexdigest()}
            hash_.update(chunk)
            size += len(chunk)


def json_bytes(data):
    return (json.dumps(data, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode("utf-8")


def checked_file(file, expected_name=None):
    path = Path(file)
    require(path.is_absolute(), "input path must be absolute")
    require(path.exists(), "required input missing")
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode), "input must be a regular file")
    require(not path.is_symlink() and not (getattr(metadata, "st_file_attributes", 0) & 0x400),
            "linked or reparse-point input is forbidden")
    if expected_name is not None:
        require(path.name.lower() == expected_name.lower(), "unexpected input filename")
    check_part_name(path.name)
    return path


def checked_dir(folder):
    path = Path(folder)
    require(path.is_absolute(), "directory path must be absolute")
    require(path.is_dir(), "required directory missing")
    metadata = path.lstat()
    require(not path.is_symlink() and not (getattr(metadata, "st_file_attributes", 0) & 0x400),
            "linked or reparse-point directory forbidden")
    return path


def check_part_name(name):
    require(name not in ("", ".", "..") and not name.endswith((" ", ".")),
            "unsafe Windows pathname")
    require(not any(char in name for char in '<>:"/\\|?*\x00\r\n'), "unsupported path character")
    require(not any(ord(c) < 32 for c in name), "control character in name")
    stem = name.split(".", 1)[0].upper()
    require(stem not in {"CON", "PRN", "AUX", "NUL"} and stem not in
            {"COM"+str(i) for i in range(1,10)} | {"LPT"+str(i) for i in range(1,10)},
            "reserved Windows pathname")
    require(name.lower() not in FORBIDDEN_NAMES and not name.lower().endswith(FORBIDDEN_SUFFIXES),
            "private or credential-like file rejected")


def checked_tree(source):
    root = checked_dir(source)
    entries = []
    seen = set()
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        filenames.sort()
        for name in dirnames + filenames:
            check_part_name(name)
            source_path = Path(current) / name
            st = source_path.lstat()
            require(not source_path.is_symlink() and not (getattr(st, "st_file_attributes", 0) & 0x400),
                    "reparse points forbidden in package")
            require(stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode), "unsupported payload type")
            rel = source_path.relative_to(root).as_posix()
            key = rel.lower()
            require(key not in seen, "case-folded path collision")
            seen.add(key)
            if stat.S_ISREG(st.st_mode):
                entries.append((source_path, rel))
    return entries


def check_gui_pe(path):
    # Header integrity and GUI subsystem, not a replacement for CRT import review.
    with open(path, "rb") as file:
        data = file.read(512)
    require(len(data) >= 256 and data[:2] == b"MZ", "Windows executable lacks MZ header")
    pe = struct.unpack_from("<I", data, 0x3c)[0]
    require(pe >= 64 and pe + 24 + 70 <= len(data), "invalid PE header offset")
    require(data[pe:pe+4] == b"PE\x00\x00", "invalid PE signature")
    require(struct.unpack_from("<H", data, pe + 4)[0] == 0x8664, "not Windows x64")
    require(struct.unpack_from("<H", data, pe + 24)[0] == 0x20b, "not PE32+ executable")
    require(struct.unpack_from("<H", data, pe + 24 + 68)[0] == 2, "not Windows GUI subsystem")


def iter_regular_files(root):
    items = checked_tree(root)
    require(len(items) <= MAX_FILES, "too many payload files")
    result = []
    seen = set()
    total = 0
    for file, relative in items:
        lower = relative.lower()
        require(lower not in seen, "duplicate case-insensitive pathname")
        seen.add(lower)
        meta = sha256_file(file)
        total += meta["size"]
        require(total <= MAX_TOTAL_BYTES, "candidate exceeds maximum size")
        result.append({"path": relative, **meta})
    return sorted(result, key=lambda row: row["path"])


def assert_inputs(args):
    root = checked_dir(args.source_root)
    sha = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True,
                                  stderr=subprocess.DEVNULL).strip()
    require(SOURCE_PATTERN.fullmatch(args.source_sha) is not None and sha == args.source_sha,
            "source SHA does not match checkout HEAD")
    binary = checked_file(args.browserw, "tetherplane-browserw.exe")
    node = checked_file(args.node, "node.exe")
    license_file = checked_file(args.node_license, "LICENSE")
    host = checked_file(args.host, "host.mjs")
    bridge = checked_dir(args.bridge)
    extension = checked_dir(args.extension)
    check_gui_pe(binary)
    checked_file(bridge / "dist" / "index.js", "index.js")
    checked_file(bridge / "package.json", "package.json")
    checked_file(extension / "manifest.json", "manifest.json")
    checked_file(extension / "pair.html", "pair.html")
    checked_file(extension / "dist" / "background.js", "background.js")
    checked_file(extension / "dist" / "pair.js", "pair.js")
    checked_tree(bridge)
    checked_tree(extension / "dist")
    return root, binary, node, license_file, host, bridge, extension


def copy_bytes(src, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest, follow_symlinks=False)
    require(sha256_file(src) == sha256_file(dest), "input copy mismatch")


def fill_tree(src, output, prefix):
    for file, rel in checked_tree(src):
        copy_bytes(file, output / prefix / rel)


def make_zip(stage, archive):
    files = iter_regular_files(stage)
    with zipfile.ZipFile(archive, "x", allowZip64=True) as zf:
        for row in files:
            file_path = stage / row["path"]
            info = zipfile.ZipInfo(row["path"], date_time=ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            with open(file_path, "rb") as reader, zf.open(info, "w") as writer:
                shutil.copyfileobj(reader, writer, length=BLOCK)
            require(sha256_file(file_path) == {"size": row["size"], "sha256": row["sha256"]},
                    "source changed while archiving")


def stage(args):
    root, binary, node, license_file, host, bridge, extension = assert_inputs(args)
    output = Path(args.out_dir)
    archive = Path(args.archive)
    require(output.is_absolute() and archive.is_absolute(), "output paths must be absolute")
    require(not output.exists() and not archive.exists(), "output already exists; no overwrite allowed")
    require(output != archive and not output.is_relative_to(archive) and not archive.is_relative_to(output),
            "stage and archive paths overlap")
    for target in (output, archive):
        require(root not in target.parents and target != root, "output may not be inside source checkout")
        require(target.parent.exists() and target.parent.is_dir(), "output parent directory must already exist")
        require(not target.parent.is_symlink(), "output parent may not be linked")
    sources = [binary, node, license_file, host, bridge, extension]
    for src in sources:
        require(src not in output.parents and output not in src.parents and src != output,
                "staging overlaps input")
    output.mkdir(mode=0o700)
    copy_bytes(binary, output / "bin" / "tetherplane-browserw.exe")
    copy_bytes(node, output / "runtime" / "node.exe")
    copy_bytes(license_file, output / "runtime" / "LICENSE")
    copy_bytes(host, output / "browser" / "host.mjs")
    fill_tree(bridge, output, "browser")
    # The extension source checkout contains development-only files and may
    # contain pnpm symlinks. Only the published extension payload is allowed.
    copy_bytes(extension / "manifest.json", output / "browser" / "extension" / "manifest.json")
    copy_bytes(extension / "pair.html", output / "browser" / "extension" / "pair.html")
    fill_tree(extension / "dist", output, "browser/extension/dist")
    entries = iter_regular_files(output)
    required = {"bin/tetherplane-browserw.exe", "runtime/node.exe", "runtime/LICENSE", "browser/host.mjs",
                "browser/dist/index.js", "browser/extension/manifest.json", "browser/extension/pair.html",
                "browser/extension/dist/background.js", "browser/extension/dist/pair.js"}
    require(required.issubset({row["path"] for row in entries}), "essential browser files missing")
    manifest = {
        "schema": SCHEMA, "source_commit": args.source_sha, "platform": "windows", "architecture": "x64",
        "kind": "unsigned_disposable_browser_companion", "browser_activation": "owner_approval_required",
        "release": "NO_GO", "source_provenance": "NOT_ATTESTED", "authenticode": "NOT_VERIFIED",
        "signed_msix": False, "installed_acceptance": "NOT_RUN", "owner_grants": "NOT_RUN",
        "reproducibility_scope": "identical_input_bytes", "files": entries,
    }
    manifest_path = output / MANIFEST
    manifest_path.write_bytes(json_bytes(manifest))
    make_zip(output, archive)
    report = verify(archive, args.source_sha, expected_sha=None)
    require(report["status"] == "PASS", "archive failed immediate byte verification")
    return report


def verify(path, expected_source, expected_sha):
    require(SOURCE_PATTERN.fullmatch(expected_source) is not None, "invalid exact expected source SHA")
    archive = checked_file(path)
    archive_hash = sha256_file(archive)["sha256"]
    if expected_sha is not None:
        require(HASH_PATTERN.fullmatch(expected_sha) is not None, "invalid expected archive digest")
        require(archive_hash == expected_sha, "archive digest mismatch")
    with zipfile.ZipFile(archive, "r") as zf:
        members = zf.infolist()
        require(len(members) <= MAX_FILES and len(members) >= 10, "archive member count invalid")
        names = []
        lower = set()
        total = 0
        for info in members:
            require(not info.is_dir() and info.filename and not info.filename.startswith("/"), "invalid zip pathname")
            require(info.compress_type == zipfile.ZIP_STORED and not (info.flag_bits & 1),
                    "compressed or encrypted archive rejected")
            require(info.date_time == ZIP_TIMESTAMP and info.create_system == 3,
                    "archive metadata not canonical")
            require((info.external_attr >> 16) == 0o100644, "unsupported file mode in archive")
            parts = info.filename.split("/")
            for part in parts:
                check_part_name(part)
            key = info.filename.lower()
            require(key not in lower, "duplicate/case-colliding zip member")
            lower.add(key)
            names.append(info.filename)
            total += info.file_size
            require(total <= MAX_TOTAL_BYTES, "archive expands beyond allowed size")
        require(names == sorted(names), "archive member order not deterministic")
        require(MANIFEST in names, "manifest absent")
        manifest = json.loads(zf.read(MANIFEST))
        require(set(manifest) == {"schema", "source_commit", "platform", "architecture", "kind",
                                "browser_activation", "release", "source_provenance", "authenticode",
                                "signed_msix", "installed_acceptance", "owner_grants",
                                "reproducibility_scope", "files"}, "manifest schema mismatch")
        require(manifest["schema"] == SCHEMA and manifest["source_commit"] == expected_source,
                "manifest source mismatch")
        require(manifest["platform"] == "windows" and manifest["architecture"] == "x64" and
                manifest["release"] == "NO_GO" and manifest["signed_msix"] is False and
                manifest["source_provenance"] == "NOT_ATTESTED" and
                manifest["authenticode"] == "NOT_VERIFIED" and
                manifest["installed_acceptance"] == "NOT_RUN" and
                manifest["owner_grants"] == "NOT_RUN" and
                manifest["browser_activation"] == "owner_approval_required" and
                manifest["reproducibility_scope"] == "identical_input_bytes" and
                manifest["kind"] == "unsigned_disposable_browser_companion",
                "candidate must never claim signed or release-ready")
        require(zf.read(MANIFEST) == json_bytes(manifest), "manifest not canonical JSON")
        records = manifest["files"]
        require(isinstance(records, list) and len(records) == len(members)-1,
                "inventory size mismatch")
        require([row["path"] for row in records] == sorted(set(names) - {MANIFEST}),
                "inventory mismatch")
        for row in records:
            require(set(row) == {"path", "size", "sha256"} and isinstance(row["size"], int)
                    and row["size"] >= 0 and isinstance(row["sha256"], str) and
                    HASH_PATTERN.fullmatch(row["sha256"]) is not None,
                    "invalid manifest entry")
            with zf.open(row["path"]) as reader:
                hasher = hashlib.sha256()
                size = 0
                while True:
                    chunk = reader.read(BLOCK)
                    if not chunk:
                        break
                    hasher.update(chunk)
                    size += len(chunk)
            require(size == row["size"] and hasher.hexdigest() == row["sha256"],
                    "content hash mismatch")
        with zf.open("bin/tetherplane-browserw.exe") as file:
            pe_data = file.read(512)
        require(len(pe_data) >= 256 and pe_data[:2] == b"MZ", "browser launcher not PE")
        pe = struct.unpack_from("<I", pe_data, 0x3c)[0]
        require(64 <= pe and pe+94 <= len(pe_data) and pe_data[pe:pe+4] == b"PE\0\0",
                "invalid browser launcher PE header")
        require(struct.unpack_from("<H", pe_data, pe+4)[0] == 0x8664 and
                struct.unpack_from("<H", pe_data, pe+24)[0] == 0x20b and
                struct.unpack_from("<H", pe_data, pe+24+68)[0] == 2,
                "browser launcher must be Windows x64 GUI")
    return {"schema": SCHEMA, "status": "PASS", "archive_sha256": archive_hash,
            "source_commit": expected_source, "files_verified": len(records),
            "archive_bytes": archive.stat().st_size, "release": "NO_GO",
            "signature": "NOT_VERIFIED", "provenance": "NOT_ATTESTED",
            "installed_acceptance": "NOT_RUN"}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    stage_parser = sub.add_parser("stage", help="Create a new unsigned candidate and deterministic ZIP")
    stage_parser.add_argument("--source-root", required=True)
    stage_parser.add_argument("--source-sha", required=True)
    stage_parser.add_argument("--out-dir", required=True)
    stage_parser.add_argument("--archive", required=True)
    stage_parser.add_argument("--browserw", required=True)
    stage_parser.add_argument("--node", required=True)
    stage_parser.add_argument("--node-license", required=True)
    stage_parser.add_argument("--host", required=True)
    stage_parser.add_argument("--bridge", required=True)
    stage_parser.add_argument("--extension", required=True)
    verify_parser = sub.add_parser("verify", help="Read-only archive, manifest and byte integrity verification")
    verify_parser.add_argument("--archive", required=True)
    verify_parser.add_argument("--source-sha", required=True)
    verify_parser.add_argument("--expected-sha")
    return parser.parse_args()


def main():
    try:
        args = parse_args()
        result = stage(args) if args.action == "stage" else verify(args.archive, args.source_sha, args.expected_sha)
        print(json.dumps(result, sort_keys=True))
    except (Rejected, OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        # Fixed failure category; avoid printing local paths or credential-bearing exception strings.
        print(json.dumps({"schema": SCHEMA, "status": "FAIL", "category": type(error).__name__, "release": "NO_GO"}, sort_keys=True))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
