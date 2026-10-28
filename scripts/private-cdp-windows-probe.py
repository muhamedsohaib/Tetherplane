"""Windows-only, disposable Chromium private-CDP acceptance probe.

No existing user profile, website session, extension, or production agent is used.
Exit 0 only after actual CDP tab operations, no DevToolsActivePort and full cleanup.
This is a lab probe, NOT a production Windows browser launcher.
"""
import argparse
import json
import msvcrt
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time


def find_browser(name):
    roots = {
        "chrome": (
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ),
        "edge": (
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ),
    }
    return next((p for p in map(Path, roots[name]) if p.is_file()), None)


def run_probe(executable, timeout):
    profile = Path(tempfile.mkdtemp(prefix="tp-private-cdp-probe-"))
    opened = []
    child = None
    report = {
        "browser": executable.name,
        "private_cdp_version": False,
        "owned_tab_lifecycle": False,
        "devtools_port_file": None,
        "remaining_test_browser_processes": None,
        "profile_removed": False,
        "error": None,
    }
    try:
        command_read, command_write = os.pipe()
        response_read, response_write = os.pipe()
        opened = [command_read, command_write, response_read, response_write]
        os.set_inheritable(command_read, True)
        os.set_inheritable(response_write, True)
        inherited_read = msvcrt.get_osfhandle(command_read)
        inherited_write = msvcrt.get_osfhandle(response_write)
        startup = subprocess.STARTUPINFO()
        startup.lpAttributeList = {"handle_list": [inherited_read, inherited_write]}
        child = subprocess.Popen(
            [
                str(executable),
                "--remote-debugging-pipe",
                f"--remote-debugging-io-pipes={inherited_read},{inherited_write}",
                "--headless=new",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                f"--user-data-dir={profile}",
                "about:blank",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            startupinfo=startup,
            close_fds=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        os.close(command_read)
        opened.remove(command_read)
        os.close(response_write)
        opened.remove(response_write)

        messages = queue.Queue()

        def read_frames():
            pending = b""
            try:
                while True:
                    block = os.read(response_read, 65536)
                    if not block:
                        break
                    pending += block
                    while b"\0" in pending:
                        frame, pending = pending.split(b"\0", 1)
                        if frame:
                            messages.put(json.loads(frame))
            except (OSError, ValueError) as exc:
                messages.put({"io_error": type(exc).__name__})
            finally:
                messages.put({"eof": True})

        threading.Thread(target=read_frames, daemon=True).start()
        sequence = 0

        def call(method, arguments=None):
            nonlocal sequence
            sequence += 1
            command = {"id": sequence, "method": method}
            if arguments is not None:
                command["params"] = arguments
            os.write(command_write, json.dumps(command).encode() + b"\0")
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    answer = messages.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if answer.get("id") == sequence:
                    if "error" in answer:
                        raise RuntimeError(f"cdp_{method}_error")
                    return answer.get("result", {})
                if "eof" in answer or "io_error" in answer:
                    raise RuntimeError("cdp_pipe_closed_without_response")
            raise TimeoutError("cdp_reply_timeout")

        version = call("Browser.getVersion")
        if not version.get("protocolVersion"):
            raise RuntimeError("cdp_protocol_version_missing")
        report["private_cdp_version"] = True

        target = call("Target.createTarget", {"url": "about:blank"}).get("targetId")
        if not target:
            raise RuntimeError("target_creation_failed")
        targets = call("Target.getTargets").get("targetInfos", [])
        if not any(item.get("targetId") == target for item in targets):
            raise RuntimeError("target_not_found")
        call("Target.closeTarget", {"targetId": target})
        report["owned_tab_lifecycle"] = True

        report["devtools_port_file"] = (profile / "DevToolsActivePort").exists()
        if report["devtools_port_file"]:
            raise RuntimeError("raw_tcp_devtools_active_port_present")

        # Graceful command; Chromium may close the pipe before replying.
        os.write(command_write, b'{"id":999,"method":"Browser.close"}\0')
    except (OSError, RuntimeError, ValueError, TimeoutError) as exc:
        report["error"] = f"{type(exc).__name__}:{str(exc)[:120]}"
    finally:
        for fd in opened:
            try:
                os.close(fd)
            except OSError:
                pass
        if child is not None:
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass

        # Never stop other Edge/Chrome processes: match only this unique lab profile.
        root = str(profile).replace("'", "''")
        command = (
            f"$root='{root}';"
            "$p=@(Get-CimInstance Win32_Process "
            "-Filter \"Name = 'chrome.exe' OR Name = 'msedge.exe'\" "
            "|Where-Object {$_.CommandLine -like \"*$root*\"});"
            "foreach($x in $p){Stop-Process -Id $x.ProcessId -Force "
            "-ErrorAction SilentlyContinue};"
            "Start-Sleep -Milliseconds 500;"
            "$left=@(Get-CimInstance Win32_Process "
            "-Filter \"Name = 'chrome.exe' OR Name = 'msedge.exe'\" "
            "|Where-Object {$_.CommandLine -like \"*$root*\"});"
            "Write-Output $left.Count"
        )
        try:
            check = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, timeout=12, check=True,
            )
            report["remaining_test_browser_processes"] = int(check.stdout.strip())
        except (ValueError, subprocess.SubprocessError):
            report["remaining_test_browser_processes"] = "unknown"
        try:
            shutil.rmtree(profile)
        except OSError:
            pass
        report["profile_removed"] = not profile.exists()
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=("chrome", "edge"), default="chrome")
    parser.add_argument("--timeout", type=float, default=8.0)
    args = parser.parse_args()
    if not 0 < args.timeout <= 30:
        print(json.dumps({"error": "invalid_timeout"}))
        return 2
    executable = find_browser(args.browser)
    if executable is None:
        print(json.dumps({"error": "browser_missing", "browser": args.browser}))
        return 2
    report = run_probe(executable, args.timeout)
    print(json.dumps(report, sort_keys=True))
    accepted = (
        report["private_cdp_version"]
        and report["owned_tab_lifecycle"]
        and report["devtools_port_file"] is False
        and report["remaining_test_browser_processes"] == 0
        and report["profile_removed"]
    )
    return 0 if accepted else 1


if __name__ == "__main__":
    sys.exit(main())
