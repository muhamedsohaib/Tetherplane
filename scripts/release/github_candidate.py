"""Deterministic unsigned candidate archives; no execution or release authority.

`attested` consumes ONLY the successful output of an independently trusted
`gh attestation verify`; it is not itself a cryptographic verifier.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile

REPO = Path(__file__).resolve().parents[2]
MAX_PAYLOAD = 512 * 1024 * 1024
CLAIMS = {"build_provenance": "UNVERIFIED", "authenticode": "UNVERIFIED",
          "windows_acceptance": "NOT_RUN", "release": "NO_GO"}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def archive_name(source):
    require(re.fullmatch(r"[0-9a-f]{40}", source), "expected full source SHA")
    return f"tetherplane-windows-x64-unsigned-{source}.zip"


def inventory_bytes(stage, source):
    return subprocess.run(["node", str(REPO / "scripts/release/windows-candidate-digests.mjs"),
                           "record", str(stage), source], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def record(stage, source, out, inputs):
    name = archive_name(source)
    require(not out.exists(), "evidence directory must be new")
    build_inputs = json.loads(inputs.read_text(encoding="utf-8"))
    require(build_inputs.get("source_commit") == source, "build inputs source mismatch")
    require(not (stage / "build-inputs.json").exists(), "build inputs already staged")
    # Inputs become an inventoried and attested part of the archive. Do not
    # include clocks, run IDs, lane IDs or host paths in reproducible payloads.
    with (stage / "build-inputs.json").open("xb") as target:
        target.write((json.dumps(build_inputs, sort_keys=True, indent=2) + "\n").encode())
    inventory = inventory_bytes(stage, source)
    inv = json.loads(inventory)
    out.mkdir(parents=True)
    (out / "candidate-inventory.json").write_bytes(inventory)
    require(sum(f["size"] for f in inv["files"]) <= MAX_PAYLOAD, "candidate too large")
    # ZIP_STORED removes zlib-version variability. Normalize order, timestamps,
    # platform, flags and modes; never copy host ACLs or external file metadata.
    with zipfile.ZipFile(out / name, "x", compression=zipfile.ZIP_STORED) as archive:
        for entry in inv["files"]:
            relative = entry["path"]
            base = relative.rsplit("/", 1)[-1].lower()
            require(not (base.startswith(".env") and base != ".env.example") and
                    base not in ("device-credential.txt", "browser-bridge.token", "browser-extension-launch.token") and
                    not base.endswith((".pfx", ".p12", ".key")), "credential-shaped payload forbidden")
            content = (stage / relative).read_bytes()
            require(len(content) == entry["size"] and digest(content) == entry["sha256"], "staged payload changed")
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    files = sorted([name, "candidate-inventory.json"])
    (out / "SHA256SUMS").write_bytes("".join(
        digest((out / f).read_bytes()) + "  " + f + "\n" for f in files).encode())
    verify(out, source)
    print("DETERMINISTIC_ARCHIVE_RECORDED_UNSIGNED_NO_GO")


def verify(root, source):
    name = archive_name(source)
    files = sorted([name, "candidate-inventory.json"])
    require(sorted(f.name for f in root.iterdir()) == sorted(files + ["SHA256SUMS"]), "unexpected evidence contents")
    require(all(f.is_file() and not f.is_symlink() for f in root.iterdir()), "nonregular evidence")
    checksums = "".join(digest((root / f).read_bytes()) + "  " + f + "\n" for f in files).encode()
    require((root / "SHA256SUMS").read_bytes() == checksums, "checksum mismatch")
    inv = json.loads((root / "candidate-inventory.json").read_bytes())
    require(inv.get("schema") == "tetherplane.windows-candidate-digests.v1" and
            inv.get("source_commit") == source and
            all(inv.get(k) == v for k, v in CLAIMS.items()), "inventory source or claims mismatch")
    expected = {f["path"]: f for f in inv["files"]}
    require(len(expected) == len(inv["files"]), "duplicate inventory member")
    require(all(p and not p.startswith("/") and "\\" not in p and ":" not in p and
                all(s not in ("", ".", "..") for s in p.split("/")) for p in expected), "unsafe inventory path")
    require({"manifest.json", "build-inputs.json", "bin/tetherd.exe", "bin/tetherd-agentw.exe"} <= expected.keys(), "required member missing")
    with zipfile.ZipFile(root / name) as archive:
        members = archive.infolist()
        require(len(members) == len(expected) and sorted(m.filename for m in members) == sorted(expected), "archive members mismatch")
        require(sum(m.file_size for m in members) <= MAX_PAYLOAD, "archive too large")
        for member in members:
            require(not member.is_dir() and member.compress_type == zipfile.ZIP_STORED and
                    member.date_time == (1980, 1, 1, 0, 0, 0) and
                    member.external_attr == 0o100644 << 16, "noncanonical archive member")
            data = archive.read(member)
            entry = expected[member.filename]
            require(len(data) == entry["size"] and digest(data) == entry["sha256"], "archive payload mismatch")
        manifest = json.loads(archive.read("manifest.json"))
        require(manifest.get("source_commit") == source and manifest.get("platform") == "windows" and
                manifest.get("architecture") == "x64", "archive manifest mismatch")
        require(json.loads(archive.read("build-inputs.json")).get("source_commit") == source, "archive inputs mismatch")
    return digest((root / name).read_bytes())


def attested(root, source, result, run_id, attempt):
    archive_hash = verify(root, source)
    require(re.fullmatch(r"[1-9][0-9]*", run_id) and re.fullmatch(r"[1-9][0-9]*", attempt), "invalid run identity")
    invocation = f"https://github.com/muhamedsohaib/Tetherplane/actions/runs/{run_id}/attempts/{attempt}"
    results = json.loads(result.read_bytes())
    require(isinstance(results, list), "expected gh verified results")
    for entry in results:
        statement = entry.get("verificationResult", {}).get("statement", {})
        if (statement.get("predicateType") == "https://slsa.dev/provenance/v1" and
            any(s.get("digest", {}).get("sha256") == archive_hash for s in statement.get("subject", [])) and
            statement.get("predicate", {}).get("runDetails", {}).get("metadata", {}).get("invocationId") == invocation):
            print("ATTESTED_ARCHIVE_RUN_MATCH_NO_GO")
            return
    raise ValueError("verified subject or run attempt mismatch")


def main(args):
    op, *rest = args
    if op == "record" and len(rest) == 4:
        stage, source, out, inputs = rest
        record(Path(stage), source, Path(out), Path(inputs))
    elif op == "verify" and len(rest) == 2:
        verify(Path(rest[0]), rest[1])
        print("QUARANTINE_HASHES_VERIFIED_UNATTESTED_NO_GO")
    elif op == "attested" and len(rest) == 5:
        attested(Path(rest[0]), rest[1], Path(rest[2]), rest[3], rest[4])
    elif op == "compare" and len(rest) == 3:
        first, second, source = rest
        require(verify(Path(first), source) == verify(Path(second), source), "independent rebuild mismatch")
        require((Path(first) / "candidate-inventory.json").read_bytes() ==
                (Path(second) / "candidate-inventory.json").read_bytes(), "independent inventory mismatch")
        print("REPRODUCIBLE_UNSIGNED_PAYLOADS_MATCH_NO_GO")
    else:
        raise ValueError("usage: record STAGE SOURCE OUT INPUTS | verify DIR SOURCE | attested DIR SOURCE GH_RESULT RUN ATTEMPT | compare FIRST SECOND SOURCE")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print("CANDIDATE_NO_GO: " + str(error), file=sys.stderr)
        sys.exit(1)
