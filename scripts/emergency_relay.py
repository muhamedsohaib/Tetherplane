#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

DEVICE_ID = "Leno"
MAX_OUTPUT = 128 * 1024
MAX_TIMEOUT = 180
PROCESS_KINDS = {
    "hostname": ["hostname"],
    "git_status": ["git", "status", "--short", "--branch"],
    "git_log": ["git", "log", "--oneline", "--decorate", "-5"],
    "git_rev_parse": ["git", "rev-parse", "--show-toplevel"],
    "git_diff": ["git", "diff", "--stat"],
    "cargo_test": ["cargo", "test", "--workspace"],
    "cargo_check": ["cargo", "check", "--workspace"],
    "pnpm_test": ["pnpm", "-r", "test"],
    "pnpm_typecheck": ["pnpm", "-r", "typecheck"],
}


class RequestError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_repo_path(repo_root: Path, candidate: str) -> Path:
    if not isinstance(candidate, str) or not candidate:
        raise RequestError("invalid_arguments", "path must be a non-empty string")
    raw = Path(candidate)
    if raw.is_absolute() or ".." in raw.parts:
        raise RequestError("permission_denied", "path must remain inside the repository")
    root = repo_root.resolve()
    resolved = (root / raw).resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise RequestError("permission_denied", "path resolves outside the repository") from exc
    return resolved


def _bounded(text: str) -> tuple[str, bool]:
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_OUTPUT:
        return text, False
    cut = encoded[:MAX_OUTPUT]
    while cut:
        try:
            return cut.decode("utf-8") + "\n[truncated]", True
        except UnicodeDecodeError:
            cut = cut[:-1]
    return "[truncated]", True


def _redact(text: str, repo_root: Path) -> str:
    root = str(repo_root.resolve())
    return text.replace(root, "<repo>").replace(root.replace("\\", "/"), "<repo>")


def _error(request_id, code: str, message: str) -> dict:
    return {
        "version": 1,
        "request_id": request_id,
        "device_id": DEVICE_ID,
        "status": "error",
        "error": {"code": code, "message": message},
        "completed_at": utc_now(),
    }


def _success(request_id, data: dict) -> dict:
    return {
        "version": 1,
        "request_id": request_id,
        "device_id": DEVICE_ID,
        "status": "success",
        "data": data,
        "completed_at": utc_now(),
    }


def _validate_request(request: dict) -> tuple[str, str, dict]:
    if not isinstance(request, dict):
        raise RequestError("invalid_arguments", "request must be an object")
    request_id = request.get("request_id")
    try:
        uuid.UUID(str(request_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise RequestError("invalid_arguments", "request_id must be a UUID") from exc
    if request.get("version") != 1:
        raise RequestError("invalid_arguments", "unsupported request version")
    if request.get("device_id") != DEVICE_ID:
        raise RequestError("permission_denied", "request is not addressed to Leno")
    op = request.get("op")
    if not isinstance(op, str):
        raise RequestError("invalid_arguments", "op must be a string")
    args = request.get("args") or {}
    if not isinstance(args, dict):
        raise RequestError("invalid_arguments", "args must be an object")
    return str(request_id), op, args


def _run_process(args: dict, repo_root: Path) -> dict:
    kind = args.get("kind")
    argv = PROCESS_KINDS.get(kind)
    if argv is None:
        raise RequestError("permission_denied", "process kind is not allowed")
    cwd = resolve_repo_path(repo_root, args.get("cwd", "."))
    if not cwd.is_dir():
        raise RequestError("invalid_arguments", "cwd must be an existing repository directory")
    timeout = args.get("timeout_seconds", 30)
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        raise RequestError("invalid_arguments", "timeout_seconds must be positive")
    timeout = min(float(timeout), MAX_TIMEOUT)
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RequestError("timeout", f"process exceeded {timeout:g} seconds") from exc
    stdout, stdout_truncated = _bounded(_redact(completed.stdout, repo_root))
    stderr, stderr_truncated = _bounded(_redact(completed.stderr, repo_root))
    return {
        "kind": kind,
        "cwd": str(cwd.relative_to(repo_root.resolve())) or ".",
        "exit_code": completed.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "truncated": stdout_truncated or stderr_truncated,
    }


def execute_request(request: dict, repo_root: Path) -> dict:
    request_id = request.get("request_id") if isinstance(request, dict) else None
    try:
        request_id, op, args = _validate_request(request)
        if op == "device.status":
            return _success(request_id, {
                "device_id": DEVICE_ID,
                "hostname": socket.gethostname(),
                "repo_root": "<repo>",
                "policy": "repo_scoped_fixed_processes",
                "pid": os.getpid(),
            })
        if op == "files.read":
            path = resolve_repo_path(repo_root, args.get("path"))
            content = path.read_text(encoding="utf-8")
            bounded, truncated = _bounded(content)
            return _success(request_id, {"path": args["path"], "content": bounded, "truncated": truncated})
        if op == "files.write":
            path = resolve_repo_path(repo_root, args.get("path"))
            content = args.get("content")
            if not isinstance(content, str):
                raise RequestError("invalid_arguments", "content must be a string")
            if not path.parent.exists():
                raise RequestError("invalid_arguments", "parent directory does not exist")
            fd, temp_name = tempfile.mkstemp(prefix=".tetherplane-", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_name, path)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)
            return _success(request_id, {"path": args["path"], "bytes": len(content.encode("utf-8"))})
        if op == "files.patch":
            path = resolve_repo_path(repo_root, args.get("path"))
            old = args.get("old")
            new = args.get("new")
            expected = args.get("expected_replacements", 1)
            if not isinstance(old, str) or not isinstance(new, str) or not isinstance(expected, int):
                raise RequestError("invalid_arguments", "patch requires string old/new and integer expected_replacements")
            current = path.read_text(encoding="utf-8")
            count = current.count(old)
            if count != expected:
                raise RequestError("precondition_failed", f"expected {expected} replacements, found {count}")
            path.write_text(current.replace(old, new), encoding="utf-8")
            return _success(request_id, {"path": args["path"], "replacements": count})
        if op == "files.delete":
            path = resolve_repo_path(repo_root, args.get("path"))
            if not path.is_file():
                raise RequestError("invalid_arguments", "delete target must be an existing file")
            path.unlink()
            return _success(request_id, {"path": args["path"], "deleted": True})
        if op == "process.run":
            return _success(request_id, _run_process(args, repo_root))
        raise RequestError("invalid_arguments", "unsupported operation")
    except RequestError as exc:
        return _error(request_id, exc.code, exc.message)
    except (OSError, UnicodeError) as exc:
        return _error(request_id, "provider_failure", str(exc))


def _run_git(mailbox: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=mailbox, capture_output=True, text=True,
        encoding="utf-8", errors="replace", check=check,
    )


def ensure_mailbox(mailbox: Path, relay_url: str, relay_branch: str) -> None:
    if (mailbox / ".git").is_dir():
        return
    mailbox.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--branch", relay_branch, "--single-branch", relay_url, str(mailbox)], check=True)


def sync_mailbox(mailbox: Path, relay_branch: str) -> None:
    _run_git(mailbox, "clean", "-fd", "--", "requests", "results")
    _run_git(mailbox, "pull", "--rebase", "--autostash", "origin", relay_branch)


def publish_result(mailbox: Path, result_file: Path, request_id: str, relay_branch: str) -> None:
    remote_results = mailbox / "results"
    remote_results.mkdir(parents=True, exist_ok=True)
    target = remote_results / f"{request_id}.json"
    shutil.copyfile(result_file, target)
    _run_git(mailbox, "add", str(target.relative_to(mailbox)))
    commit = _run_git(mailbox, "commit", "-m", f"relay: result {request_id}", check=False)
    if commit.returncode != 0 and "nothing to commit" not in (commit.stdout + commit.stderr).lower():
        raise RuntimeError(commit.stderr.strip() or commit.stdout.strip())
    pushed = _run_git(mailbox, "push", "origin", "main", check=False)
    if pushed.returncode != 0:
        sync_mailbox(mailbox, relay_branch)
        retry = _run_git(mailbox, "push", "origin", relay_branch, check=False)
        if retry.returncode != 0:
            raise RuntimeError(retry.stderr.strip() or retry.stdout.strip())


def append_audit(audit_path: Path, request: dict, result: dict) -> None:
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "at": utc_now(),
        "request_id": result.get("request_id"),
        "op": request.get("op"),
        "status": result.get("status"),
        "error_code": (result.get("error") or {}).get("code"),
    }
    with audit_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, separators=(",", ":")) + "\n")


def process_once(mailbox: Path, state_dir: Path, repo_root: Path, relay_branch: str) -> int:
    sync_mailbox(mailbox, relay_branch)
    requests_dir = mailbox / "requests"
    requests_dir.mkdir(exist_ok=True)
    cache_dir = state_dir / "results"
    cache_dir.mkdir(parents=True, exist_ok=True)
    handled = 0
    for request_path in sorted(requests_dir.glob("*.json")):
        request_id = request_path.stem
        remote_result = mailbox / "results" / f"{request_id}.json"
        if remote_result.exists():
            continue
        cache_file = cache_dir / f"{request_id}.json"
        request = json.loads(request_path.read_text(encoding="utf-8"))
        if not cache_file.exists():
            result = execute_request(request, repo_root)
            cache_file.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            append_audit(state_dir / "audit.jsonl", request, result)
        publish_result(mailbox, cache_file, request_id, relay_branch)
        handled += 1
    return handled


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--mailbox", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--relay-url", required=True)
    parser.add_argument("--relay-branch", default="main")
    parser.add_argument("--poll-seconds", type=float, default=3.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    repo_root = Path(args.repo_root).resolve()
    mailbox = Path(args.mailbox).resolve()
    state_dir = Path(args.state_dir).resolve()
    ensure_mailbox(mailbox, args.relay_url, args.relay_branch)
    while True:
        try:
            process_once(mailbox, state_dir, repo_root, args.relay_branch)
        except Exception as exc:
            state_dir.mkdir(parents=True, exist_ok=True)
            with (state_dir / "worker-errors.log").open("a", encoding="utf-8") as handle:
                handle.write(f"{utc_now()} {type(exc).__name__}: {exc}\n")
        if args.once:
            return 0
        time.sleep(max(args.poll_seconds, 1.0))


if __name__ == "__main__":
    raise SystemExit(main())
