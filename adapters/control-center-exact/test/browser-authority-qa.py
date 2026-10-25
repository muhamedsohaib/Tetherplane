"""Isolated simulated browser acceptance for the current Device Authority candidate.

No real OAuth credentials, device authorization, or production policy writes.
Runs against the actual worktree JS and approved local HTML in headless Edge.
"""
import base64
from hashlib import sha256
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
assert EDGE.is_file(), "Microsoft Edge not installed at known path"
assert (ROOT / "public" / "index.html").is_file(), "Approved owner HTML missing"

with tempfile.TemporaryDirectory(prefix="TetherplaneAuthorityQA-") as td:
    temp = Path(td)
    cfg = {
        "journalPath": str(temp / "audit.jsonl"),
        "checkpointPath": str(temp / "checkpoint.json"),
        "auditKey": base64.b64encode(bytes(range(32))).decode("ascii"),
        "issuer": "https://relay.invalid/",
        "resource": "https://relay.invalid/mcp",
        "adminSubjects": [],
    }
    config_path = temp / "authority-config.json"
    config_path.write_text(json.dumps(cfg), encoding="utf-8")
    subprocess.run(["node", str(ROOT / "tools" / "provision-authority-audit.mjs"),
                    "--authority-config", str(config_path)], check=True,
                   cwd=ROOT, capture_output=True, text=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base_url = f"http://127.0.0.1:{port}"
    logfile = temp / "server.log"
    with logfile.open("wb") as log:
        proc = subprocess.Popen(
            ["node", str(ROOT / "oauth.mjs"), "--port", str(port),
             "--relay-url", "https://relay.invalid",
             "--authority-config", str(config_path)],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            for _ in range(60):
                if proc.poll() is not None:
                    raise RuntimeError("Candidate server exited: " + logfile.read_text(errors="replace")[-1000:])
                try:
                    with urlopen(base_url + "/", timeout=1) as resp:
                        if resp.status == 200:
                            break
                except Exception:
                    time.sleep(0.15)
            else:
                raise RuntimeError("Candidate server did not become healthy")

            # The private approved artwork references this route. Verify the
            # real HTTP response rather than relying on browser CSS fallback.
            with urlopen(base_url + '/tp-font.woff2', timeout=5) as font_response:
                font_bytes = font_response.read()
                assert font_response.status == 200
                assert 'font/woff2' in font_response.headers.get('content-type', '')
                assert sha256(font_bytes).hexdigest() == (
                    '18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e'
                )
                print('PRIVATE_FONT_HTTP=PASS')
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    executable_path=str(EDGE), headless=True,
                    args=["--disable-extensions", "--disable-background-networking", "--no-first-run"]
                )
                context = browser.new_context(viewport={"width": 1728, "height": 960})
                page = context.new_page()
                page.add_init_script("""
                    window.__holdSurface = false;
                    window.__releaseSurface = null;
                    const nativeFetch = window.fetch.bind(window);
                    window.fetch = (input, options) => {
                      if (String(input) === '/api/authority/Surface' && window.__holdSurface) {
                        window.__holdSurface = false;
                        return new Promise(resolve => {
                          window.__releaseSurface = () => resolve(nativeFetch(input, options));
                        });
                      }
                      return nativeFetch(input, options);
                    };
                """)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                session = {
                    "devices": [
                        {"deviceId": d, "pairedAt": "2026-10-25T02:00:00Z",
                         "revokedAt": None, "connectivity": "not_reported"}
                        for d in ("Leno", "Surface", "RTX", "VAULTER")
                    ],
                    "csrfToken": "synthetic-csrf",
                    "observedAt": "2026-10-25T02:00:00Z",
                    "expiresAt": "2032-01-01T00:00:00Z",
                    "authenticated": True,
                }
                observed = {
                    "deviceId": "Leno", "source": "agent_device.capabilities",
                    "observedAt": "2026-10-25T02:00:00Z",
                    "authorityScope": "control_center_only", "isOwner": True,
                    "agentPolicyModifiable": False,
                    "agentCapabilitiesAreCallerGrants": False,
                    "revision": 0, "denied": [], "audit": [],
                    "providers": [
                        {"namespace": "device", "available": True,
                         "operations": ["status", "capabilities"]},
                        {"namespace": "filesystem", "available": True,
                         "operations": ["read", "write", "list"]},
                        {"namespace": "process", "available": True, "operations": ["run"]},
                        {"namespace": "browser", "available": False, "operations": []},
                        {"namespace": "desktop", "available": True, "operations": ["snapshot"]},
                        {"namespace": "batch", "available": True, "operations": ["execute"]},
                    ],
                }
                actions = {"change": 0, "rollback": 0}
                requests = []

                def intercept(route):
                    request = route.request
                    url = request.url
                    if url.endswith("/api/session") or url.endswith("/api/devices"):
                        route.fulfill(status=200, content_type="application/json", body=json.dumps(session))
                        return
                    if url.endswith("/api/authority/Leno") and request.method == "GET":
                        route.fulfill(status=200, content_type="application/json", body=json.dumps(observed))
                        return
                    if url.endswith("/api/authority/Surface") and request.method == "GET":
                        surface = {**observed, "deviceId": "Surface", "isOwner": False,
                                   "revision": 0, "denied": [], "audit": []}
                        route.fulfill(status=200, content_type="application/json", body=json.dumps(surface))
                        return
                    if url.endswith("/api/authority/Leno/change") and request.method == "POST":
                        assert request.headers.get("x-csrf-token") == "synthetic-csrf"
                        payload = request.post_data_json
                        assert payload["confirmDeviceId"] == "Leno"
                        assert payload["expectedRevision"] == 0
                        assert payload["denied"] == ["filesystem"]
                        requests.append(payload)
                        actions["change"] += 1
                        observed["revision"], observed["denied"] = 1, ["filesystem"]
                        observed["audit"] = [{
                            "seq": 1, "revision": 1, "action": "restrict",
                            "time": "2026-10-25T02:01:00Z",
                            "before": [], "after": ["filesystem"],
                            "reason": payload["reason"],
                        }]
                        route.fulfill(status=200, content_type="application/json",
                                      body=json.dumps({"deviceId": "Leno", "revision": 1,
                                                       "denied": ["filesystem"]}))
                        return
                    if url.endswith("/api/authority/Leno/rollback") and request.method == "POST":
                        payload = request.post_data_json
                        assert payload["expectedRevision"] == 1
                        assert payload["targetRevision"] == 0
                        assert payload["confirmDeviceId"] == "Leno"
                        actions["rollback"] += 1
                        observed["revision"], observed["denied"] = 2, []
                        observed["audit"].append({
                            "seq": 2, "revision": 2, "action": "rollback",
                            "time": "2026-10-25T02:02:00Z",
                            "before": ["filesystem"], "after": [],
                            "reason": payload["reason"],
                        })
                        route.fulfill(status=200, content_type="application/json",
                                      body=json.dumps({"deviceId": "Leno", "revision": 2,
                                                       "denied": []}))
                        return
                    route.continue_()

                page.route("**/api/**", intercept)
                page.route("https://**/*", lambda route: route.abort())
                page.goto(base_url + "/", wait_until="load", timeout=20000)
                page.locator("#tp-authority-open").wait_for(state="visible", timeout=10000)
                page.locator("#tp-authority-open").click()
                page.locator("#tp-authority-modal").wait_for(state="visible", timeout=7000)
                page.locator("[data-authority-device='Leno']").click()
                page.get_by_text("filesystem", exact=True).first.wait_for(timeout=7000)
                assert "agent_device.capabilities" in page.locator("#tp-authority-source").inner_text()
                assert "not a device-local policy edit" in page.locator("#tp-authority-boundary").inner_text().lower()
                page.locator("#tp-authority-deny-filesystem").check()
                page.locator("#tp-authority-confirm").fill("Leno")
                page.locator("#tp-authority-reason").fill("Isolated browser test restriction")
                page.locator("#tp-authority-apply").click()
                page.get_by_text("Revision 1", exact=True).first.wait_for(timeout=7000)
                assert actions["change"] == 1
                page.locator("#tp-authority-target-revision").select_option("0")
                page.locator("#tp-authority-confirm").fill("Leno")
                page.locator("#tp-authority-reason").fill("Restore original overlay")
                page.locator("#tp-authority-rollback").click()
                page.get_by_text("Revision 2", exact=True).first.wait_for(timeout=7000)
                assert actions["rollback"] == 1
                page.locator("[data-authority-device='Surface']").click()
                expect(page.locator('#tp-authority-device-title')).to_have_text('Surface',timeout=10000)
                assert page.locator("#tp-authority-apply").is_disabled()
                assert page.locator("#tp-authority-rollback").is_disabled()
                # Force an out-of-order response after switching devices.
                # An old device response must never replace the selected device's state.
                page.evaluate("window.__holdSurface = true")
                page.locator("[data-authority-device='Surface']").evaluate("(el) => el.click()")
                deadline = time.monotonic() + 7
                while not page.evaluate('Boolean(window.__releaseSurface)') and time.monotonic() < deadline:
                    page.wait_for_timeout(80)
                assert page.evaluate('Boolean(window.__releaseSurface)'), 'The held Surface response was not intercepted'
                page.locator("[data-authority-device='Leno']").evaluate("(el) => el.click()")
                expect(page.locator('#tp-authority-device-title')).to_have_text('Leno',timeout=7000)
                page.evaluate("window.__releaseSurface()")
                page.wait_for_timeout(350)
                assert page.locator("#tp-authority-device-title").inner_text() == "Leno", (
                    "Stale Surface response overwrote the selected Leno device"
                )
                print("OUT_OF_ORDER_DEVICE_OBSERVATIONS=PASS")
                page.locator("#tp-authority-close").click()
                assert page.locator("#tp-authority-modal").is_hidden()
                assert not errors, errors
                browser.close()
                print("HEADLESS_EDGE_CURRENT_WORKTREE=PASS")
                print("SIMULATED_AUTHORITY_CHANGE=1")
                print("SIMULATED_AUTHORITY_ROLLBACK=1")
                print("SIMULATED_NON_OWNER_DENIAL=PASS")
                print("REAL_POLICY_CHANGES=0")
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=8)
            print("ISOLATED_TEST_SERVER_TERMINATED=" + str(proc.poll() is not None))
