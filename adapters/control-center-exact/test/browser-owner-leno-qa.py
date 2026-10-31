"""Synthetic owner-Leno browser acceptance against the real V5 portal HTML in Edge.

No production OAuth identity, relay, permissions, device pairing or network service.
Only an isolated 127.0.0.1 portal and route-intercepted synthetic owner APIs.
The owner JS is appended to the portal's existing script response exactly as the
V5 owner-Leno enabled server would do; the relay API is intentionally mocked.
"""
import base64
from hashlib import sha256
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
APPROVED_HTML_HASH = "4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8"
assert EDGE.is_file(), "Edge is required for independent browser acceptance"
assert sha256((ROOT / "public" / "index.html").read_bytes()).hexdigest() == APPROVED_HTML_HASH

with tempfile.TemporaryDirectory(prefix="TetherplaneLenoOwnerBrowser-") as td:
    temp = Path(td)
    cfg = {
        "journalPath": str(temp / "audit.jsonl"),
        "checkpointPath": str(temp / "checkpoint.json"),
        "auditKey": base64.b64encode(bytes(range(32))).decode("ascii"),
        "issuer": "https://relay.invalid/",
        "resource": "https://relay.invalid/mcp",
        "adminSubjects": [],
    }
    config_path = temp / "authority.json"
    config_path.write_text(json.dumps(cfg), encoding="utf-8")
    subprocess.run(
        ["node", str(ROOT / "tools" / "provision-authority-audit.mjs"),
         "--authority-config", str(config_path)],
        check=True, cwd=ROOT, capture_output=True, text=True,
    )
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base_url = f"http://127.0.0.1:{port}"
    logfile = temp / "portal.log"
    with logfile.open("wb") as log:
        proc = subprocess.Popen([
            "node", str(ROOT / "oauth.mjs"), "--port", str(port),
            "--relay-url", "https://relay.invalid",
            "--authority-config", str(config_path)
        ], stdout=log, stderr=subprocess.STDOUT, cwd=ROOT,
           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            for _ in range(65):
                if proc.poll() is not None:
                    raise RuntimeError("Synthetic portal exited before healthy")
                try:
                    with urlopen(base_url + "/", timeout=1) as response:
                        if response.status == 200:
                            break
                except Exception:
                    time.sleep(0.15)
            else:
                raise AssertionError("Synthetic portal failed loopback readiness")

            session = {
                "authenticated": True, "csrfToken": "synthetic-leno-csrf",
                "devices": [{"deviceId": device, "pairedAt": "2026-10-31T00:00:00Z",
                             "revokedAt": None, "connectivity": "not_reported"}
                            for device in ("Leno", "Surface", "RTX", "VAULTER")],
                "observedAt": "2026-10-31T00:00:00Z",
                "expiresAt": "2032-01-01T00:00:00Z",
            }
            owner = {
                "revision": 0, "enabled": False, "enforcedDevices": [], "grants": [],
                "clients": [{"clientId": "synthetic-observed-ai-client", "principalId": "human:owner"}]
            }
            observed = {
                "deviceId": "Leno", "source": "agent_device.capabilities",
                "observedAt": "2026-10-31T00:00:00Z", "authorityScope": "control_center_only",
                "isOwner": True, "agentPolicyModifiable": False,
                "agentCapabilitiesAreCallerGrants": False, "revision": 0,
                "denied": [], "audit": [],
                "providers": [{"namespace": "device", "available": True,
                               "operations": ["status", "capabilities"]},
                              {"namespace": "browser", "available": False, "operations": []}],
            }
            writes = {"staged": 0, "enforced": 0, "restored": 0}
            errors = []
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    executable_path=str(EDGE), headless=True,
                    args=["--disable-extensions", "--disable-background-networking", "--no-first-run"],
                )
                try:
                    ctx = browser.new_context(viewport={"width": 1680, "height": 980})
                    page = ctx.new_page()
                    page.on("pageerror", lambda error: errors.append(str(error)))

                    def owner_script(route):
                        response = route.fetch()
                        assert response.status == 200
                        injected = response.body() + b"\n" + (
                            ROOT / "public" / "tp-owner-leno.js").read_bytes()
                        route.fulfill(status=200, content_type="text/javascript; charset=utf-8",
                                      body=injected)

                    def api(route):
                        req = route.request
                        url = req.url
                        if url.endswith("/api/session") and req.method == "GET":
                            route.fulfill(status=200, content_type="application/json",
                                          body=json.dumps(session))
                            return
                        if url.endswith("/api/devices") and req.method == "GET":
                            route.fulfill(status=200, content_type="application/json",
                                          body=json.dumps(session))
                            return
                        if url.endswith("/api/authority/Leno") and req.method == "GET":
                            route.fulfill(status=200, content_type="application/json",
                                          body=json.dumps(observed))
                            return
                        if url.endswith("/api/owner-leno") and req.method == "GET":
                            route.fulfill(status=200 if session["authenticated"] else 401,
                                          content_type="application/json",
                                          body=json.dumps(owner if session["authenticated"]
                                                          else {"error": {"message": "Expired session"}}))
                            return
                        if url.endswith("/api/owner-leno/grant") and req.method == "POST":
                            assert session["authenticated"], "No unauthorized owner grant"
                            assert req.headers.get("x-csrf-token") == session["csrfToken"]
                            body = req.post_data_json
                            assert body == {
                                "revision": 0, "clientId": owner["clients"][0]["clientId"],
                                "principalId": owner["clients"][0]["principalId"],
                                "confirmation": "TRUST Leno",
                            }, body
                            owner["grants"] = [{
                                "deviceId": "Leno", "clientId": body["clientId"],
                                "principalId": body["principalId"], "level": "full",
                            }]
                            owner["revision"] = 1
                            writes["staged"] += 1
                            route.fulfill(status=200, content_type="application/json",
                                          body=json.dumps({"revision": 1, "staged": True, "enabled": False}))
                            return
                        if url.endswith("/api/owner-leno/enforcement") and req.method == "POST":
                            assert session["authenticated"], "No unauthorized owner enforce"
                            assert req.headers.get("x-csrf-token") == session["csrfToken"]
                            body = req.post_data_json
                            assert body["revision"] == owner["revision"]
                            assert body["enabled"] in (True, False)
                            phrase = ("ENFORCE Leno GRANTS" if body["enabled"] else
                                      "RESTORE Leno LEGACY ACCESS")
                            assert body["confirmation"] == phrase
                            assert owner["grants"], "Cannot enforce without prior staging"
                            owner["enforcedDevices"] = ["Leno"] if body["enabled"] else []
                            owner["revision"] += 1
                            writes["enforced" if body["enabled"] else "restored"] += 1
                            route.fulfill(status=200, content_type="application/json",
                                          body=json.dumps({"revision": owner["revision"],
                                                           "enabled": body["enabled"]}))
                            return
                        route.continue_()

                    page.route("**/tp-integration.js", owner_script)
                    page.route("**/api/**", api)
                    page.route("https://**/*", lambda route: route.abort())
                    page.goto(base_url + "/", wait_until="load", timeout=20000)
                    page.locator("#tp-authority-open").click()
                    page.locator("#tp-authority-modal").wait_for(state="visible", timeout=8000)
                    page.locator("#tp-leno-owner-section").wait_for(state="visible", timeout=7000)
                    assert page.locator("#tp-leno-owner-stage").is_disabled()
                    assert page.locator("#tp-leno-owner-apply").is_disabled()
                    print("OWNER_UI_READ_ONLY_BY_DEFAULT=PASS")

                    page.locator("#tp-leno-owner-section button").first.click()
                    expect(page.locator("#tp-leno-owner-result")).to_contain_text(
                        "Owner policy verified", timeout=7000)
                    assert page.locator("#tp-leno-owner-stage").is_enabled()
                    assert page.locator("#tp-leno-owner-client option").count() == 1
                    assert "synthetic-observed-ai-client" in page.locator("#tp-leno-owner-client option").first.inner_text()
                    page.locator("#tp-leno-owner-stage").click()
                    expect(page.locator("#tp-leno-owner-result")).to_contain_text("Type TRUST Leno", timeout=6000)
                    assert writes["staged"] == 0

                    page.locator("#tp-leno-owner-stage-confirm").fill("TRUST Leno")
                    page.locator("#tp-leno-owner-stage").click()
                    expect(page.locator("#tp-leno-owner-result")).to_contain_text(
                        "Refresh to verify effective policy", timeout=7000)
                    assert page.locator("#tp-leno-owner-stage").is_disabled()
                    assert writes["staged"] == 1
                    page.locator("#tp-leno-owner-section button").first.click()
                    expect(page.locator("#tp-leno-owner-state")).to_contain_text("grants: 1", timeout=7000)
                    assert "legacy routing" in page.locator("#tp-leno-owner-state").inner_text()

                    page.locator("#tp-leno-owner-apply").click()
                    expect(page.locator("#tp-leno-owner-result")).to_contain_text(
                        "Type ENFORCE Leno GRANTS", timeout=7000)
                    assert writes["enforced"] == 0
                    page.locator("#tp-leno-owner-enforce-confirm").fill("ENFORCE Leno GRANTS")
                    page.locator("#tp-leno-owner-apply").click()
                    expect(page.locator("#tp-leno-owner-result")).to_contain_text(
                        "Refresh to verify effective policy", timeout=7000)
                    assert writes["enforced"] == 1
                    page.locator("#tp-leno-owner-section button").first.click()
                    expect(page.locator("#tp-leno-owner-state")).to_contain_text("ENFORCED", timeout=7000)
                    assert page.locator("#tp-leno-owner-stage").is_disabled()

                    page.locator("#tp-leno-owner-enforce-confirm").fill("RESTORE Leno LEGACY ACCESS")
                    page.locator("#tp-leno-owner-apply").click()
                    expect(page.locator("#tp-leno-owner-result")).to_contain_text(
                        "Refresh to verify effective policy", timeout=7000)
                    assert writes["restored"] == 1
                    page.locator("#tp-leno-owner-section button").first.click()
                    expect(page.locator("#tp-leno-owner-state")).to_contain_text(
                        "legacy routing", timeout=7000)

                    session["authenticated"] = False
                    page.locator("#tp-leno-owner-section button").first.click()
                    expect(page.locator("#tp-leno-owner-result")).to_contain_text(
                        "Authenticated Control Center session required", timeout=7000)
                    assert page.locator("#tp-leno-owner-stage").is_disabled()
                    assert page.locator("#tp-leno-owner-apply").is_disabled()
                    assert writes == {"staged": 1, "enforced": 1, "restored": 1}
                    assert not errors, errors
                    print("OWNER_UI_STAGE_ENFORCE_RESTORE_AND_EXPIRED_SESSION=PASS")
                    print("OWNER_UI_EXACT_CONFIRMATIONS_AND_POST_REFRESH=PASS")
                    print("SIMULATED_OWNER_WRITES=3")
                    print("LIVE_POLICY_WRITES=0")
                finally:
                    browser.close()
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=8)
            print("ISOLATED_OWNER_UI_SERVER_TERMINATED=" + str(proc.poll() is not None))
