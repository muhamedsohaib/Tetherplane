# Windows Non-Production Staging Acceptance & Mobile Checklist

**Target Branch:** `feat/universal-permissions-control-portal` (Draft [PR #150](https://github.com/muhamedsohaib/Tetherplane/pull/150))

**Scope:** End-to-end interactive validation on an isolated non-production Windows staging host before authorizing production deployment or leaving Draft.

> [!CAUTION]
> **Strict Production Device Isolation Mandate**
>
> **Do NOT run this procedure on, connect to, restart, modify, or interrupt physical devices `Leno`, `CUCK`, `Surface`, `RTX`, or `VAULTER`.**
>
> - Execute **only** on a dedicated non-production Windows 10/11 staging VM or test workstation with an active interactive desktop session and Chrome (or Chromium-based Edge) installed.
> - **Do NOT** run [`scripts/install-windows.ps1`](../../scripts/install-windows.ps1), [`scripts/install-authenticated-browser-windows.ps1`](../../scripts/install-authenticated-browser-windows.ps1), [`scripts/browser-mode-windows.ps1`](../../scripts/browser-mode-windows.ps1), or [`scripts/live-acceptance.mjs`](../../scripts/live-acceptance.mjs) during staging.
> - **Do NOT** read, copy, or modify `%LOCALAPPDATA%\Tetherplane`, `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run`, or any existing Windows Scheduled Task.
> - **Do NOT** commit or print bearer tokens, session cookies, or device credentials in shell logs, PR comments, or screenshots.

---

## 1. Staging Topology & Port Isolation

All staging state, binaries, certificates, profiles, and logs live exclusively inside a disposable folder `$env:TEMP\tetherplane-staging-<runid>`. All staging processes run in the foreground inside dedicated PowerShell consoles and exit cleanly on cleanup.

| Component | Production Value (Untouched) | Isolated Staging Value | Notes |
| --- | --- | --- | --- |
| Machine | `Leno`, `CUCK`, `Surface`, `RTX`, `VAULTER` | Dedicated Windows staging VM | Preflight aborts if hostname matches any production device |
| Workspace | Existing checkouts / `main` | Clean clone on `feat/universal-permissions-control-portal` | Verify HEAD matches PR `#150` |
| State / Tokens | `%LOCALAPPDATA%\Tetherplane` | `$StagingRoot\state`, `$StagingRoot\secrets` | Ephemeral per-run secrets generated cleanly |
| Relay Endpoint | Production domain / port `8788` | `https://127.0.0.1:18788` (or staging LAN IP for Stage 6 mobile) | Direct relay TLS (`--tls-cert`/`--tls-key`) keeps `Secure` cookies and direct HTTPS/WSS end-to-end; behind a trusted HTTPS reverse proxy use `--allow-insecure-localhost --public-origin https://...` (and `--trust-proxy-headers` if validating forwarded headers) per [Finding F-3](../security/control-portal-security-review.md#31-f-1-through-f-7-remediation--verification-matrix) |
| Paired Staging Devices | Real owner device IDs | `staging-win-01` (online), `staging-win-02` (kept offline) | Ephemeral `staging-acct` owner account + `operator:staging-ci` |
| Extension Host | Production persistence on `17656-17658` | Foreground `browser-extension-host.ts` (`TETHERPLANE_*_TOKEN_FILE` in `$StagingRoot`) | Default popup **Pair with local Tetherplane** targets `127.0.0.1:17656` ([`local-pairing.ts:14`](../../extension/browser/src/local-pairing.ts#L14)); confirm `17656–17658` are unbound on the clean VM, or use `18656–18658` via popup **Advanced manual pairing** |
| Browser Profile | Default user Chrome profile | `$StagingRoot\chrome-profile` (`--user-data-dir`) | Unpacked extension loaded from `<staging-repo>\extension\browser` |

---

## 2. Stage 0 — Host Preflight, Secrets Generation, TLS Cert & Build

Open **PowerShell 1 (Control Console)** in an interactive Windows desktop session.

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# 1. Fail closed if invoked on a forbidden physical host
$forbiddenHosts = @("LENO", "CUCK", "SURFACE", "RTX", "VAULTER")
if ($forbiddenHosts -contains $env:COMPUTERNAME.ToUpperInvariant()) {
    throw "ABORTED: Staging acceptance must NOT run on production device '$env:COMPUTERNAME'."
}

# 2. Create isolated staging directory tree (never %LOCALAPPDATA%\Tetherplane)
$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$StagingRoot = Join-Path $env:TEMP "tetherplane-staging-$RunId"
$StagingRepo = Join-Path $StagingRoot "repo"
$SecretsDir  = Join-Path $StagingRoot "secrets"
$RelayState  = Join-Path $StagingRoot "state"
$StateDir01  = Join-Path $StagingRoot "state-01"
$SandboxDir  = Join-Path $StagingRoot "sandbox"
$ChromeDir   = Join-Path $StagingRoot "chrome-profile"
$TlsDir      = Join-Path $StagingRoot "tls"
$AppDataDir  = Join-Path $StagingRoot "localappdata"
$StagingRelayUrl = "https://127.0.0.1:18788"

foreach ($d in @($StagingRoot, $SecretsDir, $RelayState, $StateDir01, $SandboxDir, $ChromeDir, $TlsDir, $AppDataDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Set-Content -Path (Join-Path $SandboxDir "canary.txt") -Value "staging-read-canary" -Encoding utf8

# 3. Verify clean clone of feat/universal-permissions-control-portal
git clone --branch feat/universal-permissions-control-portal https://github.com/muhamedsohaib/Tetherplane.git $StagingRepo
Set-Location $StagingRepo
git status -sb
git log -n 1 --oneline

# 4. Generate ephemeral secrets in staging folder (never print secret values)
function New-StagingSecret([string]$Path) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_').TrimEnd('=')
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $secret, $utf8NoBom)
}

New-StagingSecret (Join-Path $SecretsDir "owner.token")
New-StagingSecret (Join-Path $SecretsDir "operator.token")
New-StagingSecret (Join-Path $SecretsDir "unpaired.token")
New-StagingSecret (Join-Path $SecretsDir "device-01.cred")
New-StagingSecret (Join-Path $SecretsDir "device-02.cred")
New-StagingSecret (Join-Path $SecretsDir "browser-bridge.token")
New-StagingSecret (Join-Path $SecretsDir "browser-extension-launch.token")

# 5. Generate self-signed localhost TLS cert/key (PEM) for HTTPS/WSS + Secure cookies
#    (If testing Stage 6 mobile over LAN/Tailscale, append ,IP:<staging-lan-ip> to subjectAltName)
$opensslCmd = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $opensslCmd) { throw "OpenSSL is required to mint staging localhost PEM cert/key (Git for Windows ships openssl.exe)." }
& $opensslCmd.Source req -x509 -newkey rsa:2048 -nodes -days 2 `
    -keyout (Join-Path $TlsDir "relay.key") `
    -out    (Join-Path $TlsDir "relay.crt") `
    -subj "/CN=127.0.0.1" `
    -addext "basicConstraints=critical,CA:TRUE" `
    -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" `
    -addext "extendedKeyUsage=serverAuth" `
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" 2>$null

# Optional: temporarily trust the staging self-signed cert for Chrome & tetherd Schannel on the staging VM
# (Stage 7 cleanup deletes this exact thumbprint from Cert:\CurrentUser\Root)
Import-Certificate -FilePath (Join-Path $TlsDir "relay.crt") -CertStoreLocation Cert:\CurrentUser\Root | Out-Null

# 6. Build release tetherd + TypeScript workspaces + Chrome extension bundle
cargo build --release -p tetherd
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @tetherplane/browser-extension build
```

**Port Preflight Check**:

```powershell
# Ensure staging relay port 18788 is free, and 17656-17658 are free before running extension host
foreach ($p in @(18788, 17656, 17657, 17658)) {
    $busy = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($busy) {
        throw "Port $p is already in use (PID=$($busy.OwningProcess)). Do NOT disturb existing processes; move extension host to 18656-18658 and use manual popup pairing."
    }
}
Write-Output "STAGING_PREFLIGHT=PASS StagingRoot=$StagingRoot"
```

---

## 3. Staging Helpers & Relay Auth Config

Write the staging relay auth metadata JSON (referencing environment variable names, never raw tokens) and disposable Node helpers inside `$StagingRepo` (so ESM resolves `@modelcontextprotocol/sdk` cleanly without Windows PowerShell 5.1 command-line quote stripping):

```powershell
$AuthConfigPath = Join-Path $StagingRoot "relay-auth.json"
@'
{
  "clients": [
    {
      "token_env": "STAGING_OWNER_TOKEN",
      "account_id": "staging-acct",
      "client_id": "staging-owner-cli",
      "principal_id": "human:staging-acct"
    },
    {
      "token_env": "STAGING_OPERATOR_TOKEN",
      "account_id": "staging-acct",
      "client_id": "staging-operator-cli",
      "principal_id": "operator:staging-ci"
    },
    {
      "token_env": "STAGING_UNPAIRED_TOKEN",
      "account_id": "staging-other-acct",
      "client_id": "staging-stranger-cli",
      "principal_id": "human:staging-other-acct"
    }
  ]
}
'@ | Set-Content -Path $AuthConfigPath -Encoding utf8

# Write disposable .staging-*.mjs helpers inside staging clone (removed with $StagingRoot in Stage 7)
$HelperScript    = Join-Path $StagingRepo ".staging-mcp.mjs"
$AuthCheckScript = Join-Path $StagingRepo ".staging-auth-check.mjs"
$PairScript      = Join-Path $StagingRepo ".staging-pair.mjs"

@'
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, tokenFile, toolName, op, argsB64, deviceId] = process.argv.slice(2);
const token = readFileSync(tokenFile, "utf8").trim();
const parsedArgs = argsB64
  ? JSON.parse(Buffer.from(argsB64, "base64").toString("utf8"))
  : {};
const client = new Client({ name: "staging-acceptance", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
await client.connect(transport);
const result = await client.callTool({
  name: toolName,
  arguments: {
    op,
    args: parsedArgs,
    ...(deviceId ? { device: deviceId } : {}),
  },
});
console.log(JSON.stringify(result, null, 2));
await client.close();
'@ | Set-Content -Path $HelperScript -Encoding utf8

@'
import fs from "node:fs";
const [base, ownerFile, opFile] = process.argv.slice(2);
const owner = fs.readFileSync(ownerFile, "utf8").trim();
const op    = fs.readFileSync(opFile, "utf8").trim();

// 1. URL query tokens MUST be rejected with HTTP 400
const q1 = await fetch(`${base}/portal?token=leak-test`);
const q2 = await fetch(`${base}/portal/api/overview?access_token=leak-test`);
if (q1.status !== 400 || q2.status !== 400) throw new Error(`Expected 400 on query token, got ${q1.status}/${q2.status}`);

// 2. Non-owner operator token MUST be rejected from Portal session creation & device management (403)
const badSess = await fetch(`${base}/portal/api/session`, {
  method: "POST",
  headers: { authorization: `Bearer ${op}`, origin: base },
});
if (badSess.status !== 403) throw new Error(`Expected 403 for operator portal session, got ${badSess.status}`);

const badDevList = await fetch(`${base}/devices`, {
  method: "GET",
  headers: { authorization: `Bearer ${op}` },
});
if (badDevList.status !== 403) throw new Error(`Expected 403 for operator /devices list, got ${badDevList.status}`);

// 3. Owner token creates HttpOnly; SameSite=Strict; Secure session cookie
const okSess = await fetch(`${base}/portal/api/session`, {
  method: "POST",
  headers: { authorization: `Bearer ${owner}`, origin: base },
});
const setCookie = okSess.headers.get("set-cookie") || "";
if (okSess.status !== 200) throw new Error(`Expected 200 session create, got ${okSess.status}`);
if (!/HttpOnly/i.test(setCookie) || !/SameSite=Strict/i.test(setCookie) || !/Secure/i.test(setCookie)) {
  throw new Error(`Missing hardened cookie attributes: ${setCookie}`);
}
const cookiePair = setCookie.split(";")[0];
const { csrfToken } = await okSess.json();

// 4. Mutation without CSRF header OR with cross-site Origin MUST fail 403
const noCsrf = await fetch(`${base}/portal/api/global/apply`, {
  method: "POST",
  headers: { cookie: cookiePair, origin: base, "content-type": "application/json" },
  body: JSON.stringify({ confirm: true, profileId: "read_only" }),
});
if (noCsrf.status !== 403) throw new Error(`Expected 403 missing CSRF header, got ${noCsrf.status}`);

const badOrigin = await fetch(`${base}/portal/api/global/apply`, {
  method: "POST",
  headers: { cookie: cookiePair, origin: "https://evil.example", "x-tetherplane-csrf": csrfToken, "content-type": "application/json" },
  body: JSON.stringify({ confirm: true, profileId: "read_only" }),
});
if (badOrigin.status !== 403) throw new Error(`Expected 403 cross-origin, got ${badOrigin.status}`);

// 5. Logout revokes session
const out = await fetch(`${base}/portal/api/session/logout`, {
  method: "POST",
  headers: { cookie: cookiePair, origin: base, "x-tetherplane-csrf": csrfToken, "content-type": "application/json" },
  body: "{}",
});
if (out.status !== 200) throw new Error(`Logout failed: ${out.status}`);
const after = await fetch(`${base}/portal/api/overview`, { headers: { cookie: cookiePair } });
if (after.status !== 401) throw new Error(`Expected 401 after logout, got ${after.status}`);

console.log("STAGE_1_AUTH_COOKIE_CSRF=PASS");
'@ | Set-Content -Path $AuthCheckScript -Encoding utf8

@'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const [base, ownerFile, dev1File, dev2File] = process.argv.slice(2);
const owner = readFileSync(ownerFile, "utf8").trim();

for (const [devId, credFile] of [["staging-win-01", dev1File], ["staging-win-02", dev2File]]) {
  const cred = readFileSync(credFile, "utf8").trim();
  const hash = createHash("sha256").update(cred, "utf8").digest("hex");
  const start = await fetch(`${base}/pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: devId, credentialHash: hash }),
  }).then(r => r.json());
  if (!start.userCode) throw new Error(`pair/start failed for ${devId}: ${JSON.stringify(start)}`);
  const approve = await fetch(`${base}/pair/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
    body: JSON.stringify({ userCode: start.userCode }),
  });
  if (approve.status !== 200) throw new Error(`pair/approve failed: ${approve.status}`);
}
console.log("STAGE_2_PAIRING=PASS");
'@ | Set-Content -Path $PairScript -Encoding utf8

function Invoke-StagingMcp {
    param(
        [Parameter(Mandatory = $true)][string]$ToolName,
        [Parameter(Mandatory = $true)][string]$Op,
        [hashtable]$ToolArgs = @{},
        [string]$TokenPath = (Join-Path $SecretsDir "owner.token"),
        [string]$DeviceId = "staging-win-01"
    )
    $json = $ToolArgs | ConvertTo-Json -Compress -Depth 10
    $b64  = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    node $HelperScript "$StagingRelayUrl/mcp" $TokenPath $ToolName $Op $b64 $DeviceId
}
```

> [!NOTE]
> Because Stage 0 mints a self-signed certificate for `127.0.0.1`, set `NODE_EXTRA_CA_CERTS=$(Join-Path $TlsDir "relay.crt")` for staging Node verification commands, and remove the temporary thumbprint from `Cert:\CurrentUser\Root` in Stage 7 cleanup.

---

## 4. Stage 1 — Isolated Relay Startup, Auth, Cookie Session & CSRF Tests

Open **PowerShell 2 (Relay Console)**:

```powershell
# Paste StagingRoot from PowerShell 1
$StagingRoot = "<StagingRoot-from-PowerShell-1>"
Set-Location (Join-Path $StagingRoot "repo")

$env:STAGING_OWNER_TOKEN    = (Get-Content (Join-Path $StagingRoot "secrets\owner.token") -Raw).Trim()
$env:STAGING_OPERATOR_TOKEN = (Get-Content (Join-Path $StagingRoot "secrets\operator.token") -Raw).Trim()
$env:STAGING_UNPAIRED_TOKEN = (Get-Content (Join-Path $StagingRoot "secrets\unpaired.token") -Raw).Trim()
$env:NODE_EXTRA_CA_CERTS    = Join-Path $StagingRoot "tls\relay.crt"

node relay/dist/cli.js `
    --host 127.0.0.1 `
    --port 18788 `
    --state-file (Join-Path $StagingRoot "state\relay-devices.json") `
    --auth-config (Join-Path $StagingRoot "relay-auth.json") `
    --tls-cert (Join-Path $StagingRoot "tls\relay.crt") `
    --tls-key  (Join-Path $StagingRoot "tls\relay.key")
```

Confirm stdout prints: `tether-relay listening on https://127.0.0.1:18788`, `MCP: https://127.0.0.1:18788/mcp`, `Device: wss://127.0.0.1:18788/device`.

In **PowerShell 1**, verify API auth, URL token rejection, cookie flags, and CSRF protection:

```powershell
$env:NODE_EXTRA_CA_CERTS = Join-Path $TlsDir "relay.crt"
node $AuthCheckScript $StagingRelayUrl (Join-Path $SecretsDir "owner.token") (Join-Path $SecretsDir "operator.token")
```

**Manual UI Check in Staging Chrome**:
1. Open `https://127.0.0.1:18788/portal` in the staging Chrome profile (`--user-data-dir="$ChromeDir"`).
2. Copy the owner token to clipboard silently without logging it, paste into `#token-input`, click **Connect**.
3. Open DevTools -> Application:
   - Confirm `#token-input` is cleared immediately, `localStorage` and `sessionStorage` have **0 keys**, and cookie `tetherplane_portal_session` has `HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/portal`.
   - Confirm DevTools Console and Network show zero CSP violations, zero errors, and live `GET /portal/api/events` (`text/event-stream` pending/connected).

---

## 5. Stage 2 — Two-Stage Pairing, `tetherd` Agent Connect, Universal Default & Provider Telemetry

### 5.1 Pair `staging-win-01` and Offline Device `staging-win-02`

In **PowerShell 1**:

```powershell
node $PairScript $StagingRelayUrl (Join-Path $SecretsDir "owner.token") (Join-Path $SecretsDir "device-01.cred") (Join-Path $SecretsDir "device-02.cred")
```

Confirm in Portal without refreshing: **`staging-win-01`** and **`staging-win-02`** appear automatically with badge **`Pending Device Ack (v1)`**, status **`Offline`**, all **6 families (`device`, `files`, `process`, `browser`, `desktop`, `batch`) toggled ON**, and **`Universal (6 Families)`** default policy.

### 5.2 Start Staging Extension Host (Browser Standby) & Foreground `tetherd`

Open **PowerShell 3 (Browser Extension Host)**:

```powershell
$StagingRoot = "<StagingRoot-from-PowerShell-1>"
Set-Location (Join-Path $StagingRoot "repo")

# Isolate LOCALAPPDATA inside $StagingRoot so browser-extension-host never touches real %LOCALAPPDATA%\Tetherplane
$env:LOCALAPPDATA                            = Join-Path $StagingRoot "localappdata"
$env:TETHERPLANE_BROWSER_BRIDGE_TOKEN_FILE   = Join-Path $StagingRoot "secrets\browser-bridge.token"
$env:TETHERPLANE_EXTENSION_LAUNCH_TOKEN_FILE = Join-Path $StagingRoot "secrets\browser-extension-launch.token"
$env:TETHERPLANE_EXTENSION_ID_FILE           = Join-Path $StagingRoot "browser-extension.id"
$env:TETHERPLANE_EXTENSION_PAIRING_PORT      = "17656"
$env:TETHERPLANE_AUTH_BROWSER_RPC_PORT       = "17657"
$env:TETHERPLANE_EXTENSION_WS_PORT           = "17658"

node scripts/browser-extension-host.ts
```

Confirm stdout prints: `AUTH_EXTENSION_WS_READY=ws://127.0.0.1:17658`, `AUTH_BROWSER_RPC_READY=127.0.0.1:17657`, `AUTH_PAIRING_READY=http://127.0.0.1:17656/pair`. *(Do not launch Chrome yet — first verify standby reporting!)*

Open **PowerShell 4 (`tetherd` Console)**:

```powershell
$StagingRoot = "<StagingRoot-from-PowerShell-1>"
Set-Location (Join-Path $StagingRoot "repo")
$tetherd = Join-Path $StagingRoot "repo\target\release\tetherd.exe"

# Uses the temporary staging root cert trusted in Stage 0 so wss:// works identically to production
& $tetherd `
    --relay-url wss://127.0.0.1:18788/device `
    --device-id staging-win-01 `
    --device-credential-file (Join-Path $StagingRoot "secrets\device-01.cred") `
    --state-dir (Join-Path $StagingRoot "state-01") `
    --allow (Join-Path $StagingRoot "sandbox") `
    --browser-bridge 127.0.0.1:17657 `
    --browser-bridge-token-file (Join-Path $StagingRoot "secrets\browser-bridge.token")
```

**Verify in Portal (live SSE, no reload)**:
1. `staging-win-01` transitions to **`Online`**, sync pill updates live to **`Confirmed Active (v1)`**, **`Health: degraded`** (`windows/...`), while **`staging-win-02`** stays **`Offline`**.
2. **`desktop`** shows **`8/8 ops active`** (confirming real Windows UIA initializes cleanly in the interactive session).
3. **`browser`** accurately displays **`Unavailable (12 policy-granted)`** with banner **`browser unavailable:`** (standby reason) — proving standby is never misrepresented as ready.
4. Run remote MCP smoke from **PowerShell 1**:

```powershell
$env:NODE_EXTRA_CA_CERTS = Join-Path $TlsDir "relay.crt"
Invoke-StagingMcp -ToolName "device"  -Op "status"
Invoke-StagingMcp -ToolName "files"   -Op "read" -ToolArgs @{ path = (Join-Path $SandboxDir "canary.txt") }
Invoke-StagingMcp -ToolName "process" -Op "run"  -ToolArgs @{ program = "cmd.exe"; args = @("/C", "echo STAGING_PROC_OK"); pty = $false }
Invoke-StagingMcp -ToolName "browser" -Op "status"
```

Expected: The first 3 succeed (`STAGING_PROC_OK`, `"staging-read-canary"`), and `browser` (`op: "status"`) returns standby/unavailable cleanly rather than crashing.

---

## 6. Stage 3 — Real Chrome Extension Pairing, Tab Ownership & Reconnection Recovery

1. **Launch Isolated Chrome** from **PowerShell 1**:
   ```powershell
   $ChromeExe = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
   if (-not (Test-Path $ChromeExe)) { $ChromeExe = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
   Start-Process $ChromeExe -ArgumentList @(
       "--user-data-dir=`"$ChromeDir`"",
       "--load-extension=`"$(Join-Path $StagingRepo 'extension\browser')`"",
       "--no-first-run",
       "--no-default-browser-check",
       "https://example.com"
   )
   ```
2. Leave `https://example.com` focused as a **human-owned tab**.
3. Open the **Tetherplane Browser Bridge** extension popup (`pair.html`) from Chrome's Extensions toolbar and click **Pair with local Tetherplane**. *(If custom ports `18656-18658` were used instead, expand **Advanced manual pairing**, enter `ws://127.0.0.1:18658`, paste the launch token from `$SecretsDir\browser-extension-launch.token`, and click **Pair manually**.)*
4. **Verify Live Telemetry & Pairing**:
   - Popup `#status` displays `"Paired. Connecting..."`.
   - **PowerShell 3** prints `AUTH_EXTENSION_CONNECTED=<32-char-id>` and pins `<staging-root>\browser-extension.id` (nothing written under `%LOCALAPPDATA%\Tetherplane`).
   - Within ~1 second without refreshing the Portal tab, **`staging-win-01`** updates live via `tetherd` `device_telemetry` + relay SSE from `degraded` / `Unavailable` to **`Health: healthy`** and **`browser`: `12/12 ops active`**.
5. **Verify Browser Tab Ownership & Timed Tab Share**:
   - Call `Invoke-StagingMcp -ToolName "browser" -Op "create_tab" -ToolArgs @{ url = "https://example.org" }` -> opens a background tab owned by Tetherplane without changing or focusing the human `https://example.com` tab.
   - Call `Invoke-StagingMcp -ToolName "browser" -Op "pages"` -> obtain both page IDs; attempt `Invoke-StagingMcp -ToolName "browser" -Op "snapshot" -ToolArgs @{ page_id = "<human-page-id>" }` (or `navigate`) on the unshared human tab -> MUST fail (`permission_denied` / human-tab protection).
   - Call `Invoke-StagingMcp -ToolName "browser" -Op "snapshot" -ToolArgs @{ page_id = "<owned-page-id>" }` on the newly created Tetherplane-owned tab -> succeeds with semantic nodes.
   - Focus the human tab, open the extension popup, set duration `5 minutes`, click **Share current tab** -> re-run `snapshot` on that human tab -> **succeeds**. Click **Stop sharing current tab** -> re-running `snapshot` on that tab **denies** again.
6. **Verify Browser Disconnection & Live Reconnection Recovery**:
   - **Close the staging Chrome browser window completely** (leaving `tetherd` and `browser-extension-host.ts` running).
   - **PowerShell 3** prints `AUTH_EXTENSION_DISCONNECTED=True` and re-opens `AUTH_PAIRING_READY`.
   - Within ~2 seconds **without refreshing Portal**, `staging-win-01` transitions back to **`Health: degraded`** and **`browser`: `Unavailable (12 policy-granted)`** (and `browser` `op: "pages"` fails `capability_unavailable` / standby).
   - **Relaunch staging Chrome** with `--user-data-dir="$ChromeDir" --load-extension=...` (remember [Finding T-4](../security/control-portal-security-review.md): `chrome.storage.session` clears on full Chrome exit), re-open popup, and click **Pair with local Tetherplane**.
   - **Confirm auto-recovery**: `browser-extension-host.ts` logs `AUTH_EXTENSION_CONNECTED`, `tetherd` probe triggers `device_telemetry`, and Portal automatically restores **`Health: healthy`** / **`browser`: `12/12 ops active`** with working `create_tab` / `snapshot`.

---

## 7. Stage 4 — Interactive Windows Desktop UI Automation & Human Coexistence

1. Move physical mouse cursor to a neutral coordinate, set `"STAGING_CLIPBOARD_CANARY"` into the Windows clipboard, record `(X, Y)`, spawn the **Owned fixture FIRST** via `Invoke-StagingMcp` (capturing `$ownedHandle` from `structuredContent.handle`), wait for `$OwnedState` readiness, and **THEN** launch the **Human fixture** in **PowerShell 1** so its `Add_Shown` leaves the Human window focused:
   ```powershell
   $FixtureScript = Join-Path $StagingRepo "tests\e2e\fixtures\windows-desktop-fixture.ps1"
   $HumanState    = Join-Path $StagingRoot "desktop-human.json"
   $OwnedState    = Join-Path $StagingRoot "desktop-owned.json"

   Add-Type -AssemblyName System.Windows.Forms
   Set-Clipboard -Value "STAGING_CLIPBOARD_CANARY"
   $cursorBefore = [System.Windows.Forms.Cursor]::Position

   # Spawn owned fixture FIRST so Human spawns second and keeps OS foreground focus
   $ownedResult = (Invoke-StagingMcp -ToolName "process" -Op "run" -ToolArgs @{
       program = "powershell.exe"
       args    = @("-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", $FixtureScript, "-StatePath", $OwnedState, "-Title", "Staging Owned Fixture", "-Prefix", "Owned")
       wait_ms = 0
       pty     = $false
   }) | ConvertFrom-Json
   $ownedHandle = $ownedResult.structuredContent.handle
   while (-not (Test-Path $OwnedState)) { Start-Sleep -Milliseconds 200 }

   # Spawn interactive Human fixture SECOND
   $humanProc = Start-Process powershell.exe -PassThru -ArgumentList @(
       "-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass",
       "-File", $FixtureScript, "-StatePath", $HumanState,
       "-Title", "Staging Human Fixture", "-Prefix", "Human"
   )
   for ($i = 0; $i -lt 50; $i++) {
       try {
           if ((Get-Content $HumanState -Raw -ErrorAction Stop | ConvertFrom-Json).focused) { break }
       } catch {}
       Start-Sleep -Milliseconds 200
   }
   ```
2. Keep **Staging Human Fixture** foreground/focused and run `.staging-mcp.mjs` (`Invoke-StagingMcp`) against `staging-win-01`:
   - `Invoke-StagingMcp -ToolName "desktop" -Op "snapshot" -ToolArgs @{ max_nodes = 1000 }` -> verify both windows appear: owned nodes have `origin: "tetherplane"`, human nodes have `origin: "human_or_external"`.
   - Pick the `reference` of `Owned Value`, `Owned Invoke`, `Owned Beta`, and `Human Invoke` / `Human Value` from snapshot output and execute:
     - `Invoke-StagingMcp -ToolName "desktop" -Op "act" -ToolArgs @{ reference = "<owned-value-ref>"; action = "set_value"; value = "staging-uia-ok" }`
     - `Invoke-StagingMcp -ToolName "desktop" -Op "act" -ToolArgs @{ reference = "<owned-invoke-ref>"; action = "invoke" }`
     - `Invoke-StagingMcp -ToolName "desktop" -Op "act" -ToolArgs @{ reference = "<owned-beta-ref>"; action = "select" }`
   - Attempt `Invoke-StagingMcp -ToolName "desktop" -Op "act" -ToolArgs @{ reference = "<human-invoke-ref>"; action = "invoke"; origin = "tetherplane" }` -> **MUST fail closed** (`permission_denied` / human-resource protection).
3. **Verify Coexistence Invariants**:
   - Inspect `$OwnedState`: `text == "staging-uia-ok"` and `status == "invoked"`.
   - Inspect `$HumanState`: `focused == true` and `text == "Human-initial"` (untouched).
   - Verify `[System.Windows.Forms.Cursor]::Position` equals `$cursorBefore` and `Get-Clipboard` equals `"STAGING_CLIPBOARD_CANARY"`.
   - Terminate the owned fixture (`Invoke-StagingMcp -ToolName "process" -Op "terminate" -ToolArgs @{ handle = $ownedHandle; grace_ms = 100; force = $true }`) and stop `$humanProc` cleanly (`Stop-Process -Id $humanProc.Id -Force`).

---

## 8. Stage 5 — Permission Grants, Denies, Operators, Offline Recovery, Lockdown & Rollback

Perform every step in the Portal UI (`https://127.0.0.1:18788/portal`) and verify enforcement via `Invoke-StagingMcp` (`.staging-mcp.mjs`) on `staging-win-01`:

1. **Family Toggle Off & On**:
   - Click the `desktop` **ON -> OFF** switch on `staging-win-01`.
   - Confirm badge shows `Confirmed Active (vN)` via SSE, `desktop` says `OFF`.
   - Call `desktop` (`op: "snapshot"`) as owner -> MUST fail (`permission_denied`, `family_revoked`), while `device` (`op: "status"`) & `files` (`op: "read"`) still pass.
   - Toggle `desktop` **OFF -> ON** -> `desktop` (`op: "snapshot"`) succeeds again.
2. **Explicit Operation Deny Overrides Universal Grant**:
   - Expand `Advanced Operation Rules & Explicit Denies`, enter canonical capability `filesystem.write`, click **Deny Op**.
   - Call `Invoke-StagingMcp -ToolName "files" -Op "read" -ToolArgs @{ path = (Join-Path $SandboxDir "canary.txt") }` -> **succeeds**.
   - Call `Invoke-StagingMcp -ToolName "files" -Op "write" -ToolArgs @{ path = (Join-Path $SandboxDir "denied.txt"); content = "blocked" }` -> **fails** (`explicit_deny`) and no file is created.
3. **Device-Scoped Operator & Principal Isolation**:
   - Check ONLY `staging-win-01` checkbox (`Target: 1 selected device (staging-win-01)`).
   - Expand `Authorize / Update Scoped Operator Identity`, add `principalId`: `operator:staging-ci`, `Display Name`: `Staging CI`, profile: `Read & Inspect Only`, click **Save Operator Policy**.
   - Confirm `staging-win-01` lists `staging-win-01 (read_only)` under `Operator: operator:staging-ci` while `staging-win-02` has NO grant (`operator_policies` empty).
   - Call `files` (`op: "read"`) using `secrets\operator.token` (`-TokenPath`) -> **succeeds**; call `files` (`op: "write"`) / `process` (`op: "run"`) using `secrets\operator.token` -> **fails** (`permission_denied`).
   - Call `device` (`op: "status"`) using `secrets\unpaired.token` -> **fails** (`permission_denied`).
4. **Offline Device Recovery & Anti-Rollback Verification**:
   - Stop `tetherd` in **PowerShell 4** (`Ctrl+C`) -> confirm Portal updates **`staging-win-01`** to **`Offline`**.
   - In Portal, toggle `process` **OFF** on `staging-win-01` -> confirm sync badge says **`Pending Device Ack`** and Audit log records `device_offline`.
   - Attempt `process` (`op: "run"`) -> fails `disconnected` / `permission_denied`.
   - Restart `tetherd` in **PowerShell 4** with the exact same `--state-dir` -> confirm `device_hello` triggers `policy_sync`, ACK converges live to **`Confirmed Active`**, audit entry transitions to `confirmed_by_device`, and `process` (`op: "run"`) fails `permission_denied` (`family_revoked`).
   - Verify local persistence file `<StateDir01>\policy\synchronized-policy.json` contains current revision and `denied_families: ["process"]`.
5. **Emergency Lockdown & Agent Restart Durability**:
   - Clear device checkboxes (`Target: All paired devices`), click **Emergency Access Revocation**, enter reason `Staging emergency test`, confirm modal.
   - Confirm top stat card displays **`LOCKDOWN`**, device badges show **`Emergency Lockdown`**, and both `secrets\owner.token` AND `secrets\operator.token` fail `device` (`op: "status"`) / `files` (`op: "read"`) with `emergency_lockdown`.
   - Stop and restart `tetherd` in **PowerShell 4** cleanly -> verify lock remains enforced across restart (`synchronized-policy.json` has `emergency_lockdown: true`).
6. **Snapshot Filter, Pagination & Monotonic Rollback**:
   - Expand `Recoverable Snapshots & Rollback`. If >10 snapshots exist (or after performing several toggles), verify **Show more snapshots (10/N)** increments visibly; filter dropdown by `staging-win-01` vs `All devices`.
   - Click **Rollback** on **`staging-win-01 rev 1`** (`Universal default permissions assigned to owner-paired device`).
   - Confirm: revision jumps monotonically above pre-rollback revision (`newRevision > lockdownRevision`), `Emergency Lockdown` clears, `filesystem.write` deny and `process` revocation clear, `operator:staging-ci` grant is removed (if not present in rev 1), and both `process` (`op: "run"`) and `files` (`op: "write"`) succeed again for owner (`staging-win-01`) while `operator:staging-ci` is denied (`unpaired_or_unauthorized_identity`).
   - Also validate **Edit** & **Revoke** buttons under `Owner & Operator Identities` after re-adding an operator, and test **Lift Emergency Lockdown** if triggering lockdown a second time (noting per F-7 that **Lift Emergency Lockdown** restores baseline `Universal Access` with `allow_destructive: true`, whereas prior custom restrictions are restored via Snapshot Rollback; human-origin `process.terminate` and unshared human tabs/windows remain blocked in all profiles).

---

## 9. Stage 6 — Mobile Browser Acceptance Checklist

Validate the Control Portal at mobile dimensions using **both** (A) Chromium/Edge responsive device emulation (`390x844` and `360x800`) and (B) a real mobile browser (iOS Safari or Android Chrome):

- For **Part (B) real-phone testing** over a private LAN or Tailscale IP (`$LanIp`), temporarily re-mint the staging cert with `subjectAltName=IP:127.0.0.1,IP:<LanIp>,DNS:localhost`, re-launch **PowerShell 2** (`tether-relay`) with `--host <LanIp> --port 18788`, point **PowerShell 4** (`tetherd`) at `--relay-url wss://<LanIp>:18788/device`, optionally add a temporary scoped firewall rule `New-NetFirewallRule -DisplayName "Tetherplane-Staging-18788" -Direction Inbound -Protocol TCP -LocalPort 18788 -Profile Private -Action Allow`, and open `https://<LanIp>:18788/portal` on the phone (accepting/installing the disposable staging cert only during the test session). If using an explicit trusted HTTPS reverse proxy instead of direct `--tls-cert`/`--tls-key`, launch `tether-relay` with `--allow-insecure-localhost --public-origin https://<proxy-host> --trust-proxy-headers` rather than plain unconfigured HTTP. *(See [Finding F-3](../security/control-portal-security-review.md#31-f-1-through-f-7-remediation--verification-matrix).)*

| # | Mobile Check | Expected Pass Condition | Result |
| --- | --- | --- | --- |
| M1 | Initial viewport fit (`390x844` & `360x800`) | `document.documentElement.scrollWidth <= document.documentElement.clientWidth`; zero clipped cards, inputs, or overlapping badges. | ☐ PASS / ☐ FAIL |
| M2 | Mobile Sign-In & Session Persistence | Paste owner token -> Connect -> token field clears; switching mobile browser tab to background and reloading `/portal` restores authenticated dashboard via `HttpOnly; SameSite=Strict; Secure` cookie without re-prompting. | ☐ PASS / ☐ FAIL |
| M3 | Device Overview & Unavailable Banner | Device cards stack in single column (`@media (max-width: 600px)`), offline vs degraded vs healthy telemetry and unavailable capability text wrap cleanly without overflow. | ☐ PASS / ☐ FAIL |
| M4 | Touch Controls & Family Switches | Per-device checkboxes, `Select All` / `Clear`, and all 6 family `ON`/`OFF` buttons have clean tap response and no mis-taps on adjacent rows. | ☐ PASS / ☐ FAIL |
| M5 | Advanced Operation Rules Accordion | Opening `Advanced Operation Rules & Explicit Denies` fits text input + `Deny Op` / `Allow Op` buttons cleanly inside screen width and survives live SSE re-renders while open. | ☐ PASS / ☐ FAIL |
| M6 | Confirmation Modal & Lockdown Recovery | Clicking `Set Read-Only` / `Emergency Access Revocation` opens full-screen-centered modal with full audit reason input + Cancel/Confirm buttons visible above virtual keyboard; `Lift Lockdown` appears and clears state cleanly. | ☐ PASS / ☐ FAIL |
| M7 | Operator Management UX | `Authorize / Update Scoped Operator Identity` inputs stay 100% width; tapping `Edit` prefills form and syncs device selection checkboxes; `Revoke` removes operator. | ☐ PASS / ☐ FAIL |
| M8 | Snapshot Filter & Rollback on Mobile | Device filter select, `Show more snapshots` button, and `Rollback` buttons fit with zero horizontal scrolling. | ☐ PASS / ☐ FAIL |
| M9 | Live SSE Updates Without Reload | Disconnecting `tetherd` or Chrome on staging Windows updates status badges on phone browser automatically within ~2s without manual refresh. | ☐ PASS / ☐ FAIL |
| M10 | Sign Out & Console Hygiene | Tapping **Sign Out** returns UI to unauthenticated view, kills cookie & SSE, and reloading shows signed-out prompt; zero console errors. | ☐ PASS / ☐ FAIL |

---

## 10. Exact PASS / FAIL Gate Criteria

**Overall Staging Acceptance passes ONLY if ALL criteria below record PASS:**

| Gate | Requirement | Criterion |
| --- | --- | --- |
| **G1** | Production Device Isolation | Zero commands executed against `Leno`, `CUCK`, `Surface`, `RTX`, or `VAULTER`; zero writes to `%LOCALAPPDATA%\Tetherplane`, `HKCU\...\Run`, or Scheduled Tasks. |
| **G2** | Auth, Cookies, CSRF, No XSS | `?token=` returns `400`; non-owner portal login and operator `/pair/approve`, `/devices`, `/devices/*/revoke` return `403`; session cookie has `HttpOnly; SameSite=Strict; Secure`; `localStorage`/`sessionStorage` empty; CSRF/cross-origin mutations return `403`; logout returns session to `401`. |
| **G3** | Real Chrome Extension Pairing & Reconnect | Extension pairs only to staging host, transitions Portal `browser` `Unavailable` -> `12/12 ops active` live via SSE, respects background tab ownership and timed tab-share expiry/detach, transitions to `Unavailable` on Chrome close, and auto-recovers upon Chrome relaunch + re-pair. |
| **G4** | Interactive Windows UIA & Coexistence | Remote `desktop.snapshot` + `desktop.act` succeed on Tetherplane-owned window while physical cursor, clipboard canary, and human fixture focus/text remain completely unchanged and human window mutations are denied. |
| **G5** | Grants, Explicit Denies, Isolation, Offline Recovery, Rollback & Lockdown | Family toggles, explicit denies (`explicit_deny`), scoped operator least privilege, cross-account denial, offline policy convergence via `device_hello`, emergency lockdown persistence across `tetherd` restart, and forward-revision rollback to `rev 1` all enforce on both relay and `tetherd`. |
| **G6** | Mobile Browser Checklist | All items `M1–M10` pass on real mobile viewport + device. |
| **G7** | Clean Staging Teardown | Cleanup removes all staging files, staging root cert (if added temporarily to `CurrentUser\Root`), temporary staging firewall rule (if added for Stage 6), and staging processes with zero leftover listeners or repo working-tree leaks. |

Any **FAIL** in `G1–G7` blocks exiting Draft or authorizing production rollout until diagnosed, covered by a regression test, and re-verified.

---

## 11. Staging Cleanup Procedure

Run this explicit cleanup in **PowerShell 1** immediately after finishing staging tests (or after aborting a failed run):

```powershell
$ErrorActionPreference = "Continue"

# 1. Stop only staging foreground processes spawned from $StagingRoot (never kill unrelated agent processes)
$StagingPrefix = [Regex]::Escape($StagingRoot)
Get-CimInstance Win32_Process | Where-Object {
    ($_.CommandLine -and $_.CommandLine -match $StagingPrefix) -or
    ($_.ExecutablePath -and $_.ExecutablePath -match $StagingPrefix)
} | ForEach-Object {
    Write-Output "Stopping staging PID $($_.ProcessId) ($($_.Name))"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# 2. Remove temporary self-signed staging cert from CurrentUser\Root & temporary Stage 6 firewall rule (if added)
if (Test-Path (Join-Path $StagingRoot "tls\relay.crt")) {
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (Join-Path $StagingRoot "tls\relay.crt")
    Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $cert.Thumbprint } | Remove-Item -Force -ErrorAction SilentlyContinue
}
Remove-NetFirewallRule -DisplayName "Tetherplane-Staging-18788" -ErrorAction SilentlyContinue

# 3. Clear clipboard canary
Set-Clipboard -Value ""

# 4. Delete isolated staging root completely
if (Test-Path $StagingRoot) {
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force
}

# 5. Post-cleanup assertions
$leftoverListeners = Get-NetTCPConnection -LocalPort 18788,17656,17657,17658 -State Listen -ErrorAction SilentlyContinue
if ($leftoverListeners) {
    Write-Warning "Residual listeners detected on staging ports; inspect manually before concluding."
}
if (Test-Path $StagingRoot) {
    throw "Staging directory still exists: $StagingRoot"
}

Write-Output "STAGING_CLEANUP=PASS"
```

Verify that:
1. Production scheduled tasks (`Get-ScheduledTask -TaskName "*Tetherplane*"`) and `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` remain untouched.
2. No staging artifacts exist outside `$env:TEMP\tetherplane-staging-*` (now deleted).

---

## 12. Rollback Instructions

### A. Staging Runtime Policy Rollback (In-Session)

1. Use the Control Portal's **Recoverable Snapshots & Rollback** panel to roll back any modified device to its baseline **`rev 1` (Universal)** snapshot, OR click **Lift Emergency Lockdown** if reversing global lockdown (which restores baseline Universal Access).
2. Confirm the device's `<StateDir>\policy\synchronized-policy.json` advances to the new monotonic revision (`> previous`). *(Never manually edit `revision` downward on disk unless purging and re-pairing an entire staging environment; deleting `$StagingRoot` completely resets staging state.)*

### B. Repository / Pull Request Code Rollback (`PR #150` Safety)

Because PR `#150` remains in **Draft** and `main` (`9c93be6`) is untouched:

1. **Before merge (discard or isolate PR changes)**:
   - Close Draft PR `#150` on GitHub without merging (`main` remains completely clean at `9c93be6`).
   - Optionally revert specific sub-commits on `feat/universal-permissions-control-portal` using `git revert <sha>` if needed.
2. **Post-merge rollback (if ever merged and needing reversal)**:
   - Create a dedicated revert branch off `main` (`git revert -m 1 <merge-commit-sha>` if merge commit, or revert commit range), run full `cargo test --workspace` + `pnpm -r test` + Windows package smoke CI gates, and open an expedited PR restoring prior relay/agent baseline.
   - Because agents persist `synchronized-policy.json` across upgrades, devices upgraded then downgraded from `PolicySync` must have their state file purged (`<state_dir>\policy\synchronized-policy.json`) or remain locked to their last monotonic revision if relay policy semantics change.
