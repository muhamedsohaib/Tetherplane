"""Check real OpenCode v2 skill discovery from the exact Agensi Starter ZIP.

This test runs only inside a disposable CI workspace. It never invokes an AI
model, connects to a controlled computer, or uses the operator's OpenCode data.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from zipfile import ZipFile

EXPECTED = frozenset({
    "tetherplane-starter/SKILL.md",
    "tetherplane-starter/README.md",
    "tetherplane-starter/LICENSE",
    "tetherplane-starter/LICENSE-MIT",
    "tetherplane-starter/LICENSE-APACHE",
    "tetherplane-starter/agents/openai.yaml",
    "tetherplane-starter/references/operations.md",
    "tetherplane-starter/references/setup.md",
    "tetherplane-starter/references/troubleshooting.md",
    "tetherplane-starter/examples/safe-first-run.md",
    "tetherplane-starter/examples/first-run.json",
})


def unpack_starter_archive(archive_path: Path, project_dir: Path) -> None:
    """Validate the complete archive in memory before writing a single file."""
    content: dict[str, bytes] = {}
    with ZipFile(archive_path, "r") as archive:
        members = archive.infolist()
        if len(members) != len(EXPECTED) or {m.filename for m in members} != EXPECTED:
            raise ValueError("unexpected or unsafe starter ZIP members")
        for member in members:
            mode = (member.external_attr >> 16) & 0o170000
            if member.is_dir() or mode not in (0, 0o100000):
                raise ValueError("unsafe symlink, directory or file type in ZIP")
            if member.file_size > 128 * 1024:
                raise ValueError("unsafe oversized ZIP member")
            data = archive.read(member)
            if not data or len(data) > 128 * 1024 or b"\0" in data:
                raise ValueError("unsafe binary or oversized ZIP member")
            data.decode("utf-8")
            content[member.filename] = data
    if sum(map(len, content.values())) > 512 * 1024:
        raise ValueError("unsafe total size")
    skill_data = content["tetherplane-starter/SKILL.md"].decode("utf-8").replace("\r\n", "\n")
    if not skill_data.startswith("---\nname: tetherplane-starter\ndescription: "):
        raise ValueError("invalid starter skill frontmatter")

    dest_root = project_dir / ".opencode" / "skills"
    for member, data in content.items():
        # Member names were already compared against an exact allowlist.
        target = dest_root.joinpath(*member.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def _pick_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _get_json(base_url: str, endpoint: str, password: str) -> object:
    credentials = base64.b64encode(("opencode:" + password).encode()).decode()
    request = urllib.request.Request(
        base_url + endpoint,
        headers={"Authorization": "Basic " + credentials},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        if response.status != 200:
            raise RuntimeError("unexpected OpenCode host HTTP status")
        return json.load(response)


def verify_opencode_skill(project_dir: Path) -> None:
    if shutil.which("opencode") is None:
        raise RuntimeError("pinned OpenCode executable not installed")

    port = _pick_loopback_port()
    base_url = f"http://127.0.0.1:{port}"
    password = secrets.token_urlsafe(36)
    env = os.environ.copy()
    env["OPENCODE_SERVER_PASSWORD"] = password
    env["OPENCODE_SERVER_USERNAME"] = "opencode"
    env["XDG_DATA_HOME"] = str(project_dir / ".state" / "data")
    env["XDG_CACHE_HOME"] = str(project_dir / ".state" / "cache")
    env["XDG_CONFIG_HOME"] = str(project_dir / ".state" / "config")
    env["XDG_STATE_HOME"] = str(project_dir / ".state" / "state")

    log_path = project_dir / ".opencode-server-private.log"
    with log_path.open("wb") as log:
        server = subprocess.Popen(
            ["opencode", "serve", "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=project_dir,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 75
            ready = False
            seen = 0
            while time.monotonic() < deadline:
                if server.poll() is not None:
                    raise RuntimeError("disposable OpenCode host exited early")
                try:
                    info = _get_json(base_url, "/api/info", password)
                    if isinstance(info, dict):
                        ready = True
                    if ready:
                        # Configuration load precedes skill discovery. Unlike a
                        # one-shot standalone API call, this host stays alive.
                        _get_json(base_url, "/api/config", password)
                        found = _get_json(base_url, "/api/skill", password)
                        if not isinstance(found, dict) or not isinstance(found.get("data"), list):
                            raise RuntimeError("unexpected OpenCode skill response")
                        skills = found["data"]
                        seen = len(skills)
                        matching = [
                            entry for entry in skills
                            if isinstance(entry, dict)
                            and (entry.get("id") == "tetherplane-starter"
                                 or entry.get("name") == "tetherplane-starter")
                        ]
                        if matching:
                            print(f"OPENCODE_HOST_SKILL_DISCOVERY_OK skill=tetherplane-starter count={seen}")
                            return
                except (urllib.error.URLError, TimeoutError, ConnectionError):
                    pass  # Server/location is still starting; bounded retry.
                time.sleep(0.5)
            raise RuntimeError(
                f"OpenCode host skill discovery timed out: ready={ready}, registered={seen}"
            )
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python opencode_host_acceptance.py <starter-zip>", file=sys.stderr)
        return 2
    package = Path(sys.argv[1]).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="tetherplane-opencode-ci-") as directory:
        project = Path(directory) / "workspace"
        project.mkdir()
        unpack_starter_archive(package, project)
        subprocess.run(
            ["git", "init", "-q"],
            cwd=project,
            check=True,
            capture_output=True,
        )
        (project / "opencode.json").write_text(
            json.dumps({"skills": ["./.opencode/skills"]}) + "\n",
            encoding="utf-8",
        )
        verify_opencode_skill(project)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print("OPENCODE_HOST_DISCOVERY_FAILED: " + str(error), file=sys.stderr)
        sys.exit(1)
