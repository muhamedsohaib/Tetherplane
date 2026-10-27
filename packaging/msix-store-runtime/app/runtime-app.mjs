import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(appDirectory, "..");
const MAX_BODY = 8192;
const NO_CACHE = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

export function validateRelayUrl(input) {
  if (typeof input !== "string" || input !== input.trim()) throw new Error("Enter the existing relay WSS address.");
  let u;
  try { u = new URL(input); } catch { throw new Error("The relay URL is invalid."); }
  if (u.protocol !== "wss:" || !u.hostname || u.username || u.password || u.search || u.hash || u.pathname !== "/device") {
    throw new Error("Use a secure wss:// relay address ending in /device, without credentials or query parameters.");
  }
  const protocol = u.hostname + u.host;
  if (protocol.length > 300) throw new Error("The relay address is too long.");
  return u.href;
}

export function validateDeviceId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    throw new Error("Device ID must use letters, numbers, dots, underscores or hyphens.");
  return value;
}

export async function validateAllowedRoot(value, statFile = stat) {
  if (typeof value !== "string" || value.length > 1024 || !isAbsolute(value))
    throw new Error("Choose an absolute existing folder for device access.");
  const entry = await statFile(value);
  if (!entry.isDirectory()) throw new Error("The selected access root is not a folder.");
  return resolve(value);
}

export function agentArgs(config, credentialPath, writableStatePath) {
  return ["--relay-url", validateRelayUrl(config.relayUrl),
    "--device-id", validateDeviceId(config.deviceId),
    "--device-credential-file", credentialPath,
    "--allow", config.allowRoot,
    "--state-dir", writableStatePath];
}

function send(res, status, data) {
  const text = JSON.stringify(data);
  res.writeHead(status, { ...NO_CACHE, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function parseBody(req) {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new Error("JSON request required.");
  let data = "";
  for await (const part of req) {
    data += part.toString();
    if (data.length > MAX_BODY) throw new Error("Request body exceeds limit.");
  }
  const value = JSON.parse(data || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required.");
  return value;
}

export async function requestPairing(config, options = {}) {
  const remote = new URL(validateRelayUrl(config.relayUrl));
  remote.protocol = "https:";
  remote.pathname = "/pair/start";
  const hash = createHash("sha256").update(config.secret).digest("hex");
  const http = options.fetchImpl || fetch;
  const response = await http(remote.href, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ deviceId: validateDeviceId(config.deviceId), credentialHash: hash })
  });
  if (response.status !== 200) throw new Error("Relay rejected the pairing request (HTTP " + response.status + ").");
  const body = await response.json();
  if (!body || !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(body.userCode) ||
    typeof body.pairingId !== "string" || !Number.isFinite(Date.parse(body.expiresAt))) {
    throw new Error("Relay returned an invalid pairing challenge.");
  }
  if (Date.parse(body.expiresAt) <= Date.now()) throw new Error("Pairing challenge already expired.");
  return { userCode: body.userCode, expiresAt: body.expiresAt };
}

export async function readSavedConfig(stateRoot) {
  let saved;
  try { saved = JSON.parse(await readFile(join(stateRoot, "device.json"), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Existing setup file is invalid; preserving it for recovery.");
  }
  if (!saved || saved.version !== 1) throw new Error("Existing setup version is unsupported.");
  validateDeviceId(saved.deviceId);
  validateRelayUrl(saved.relayUrl);
  await validateAllowedRoot(saved.allowRoot);
  const credential = (await readFile(join(stateRoot, "device-credential.txt"), "utf8")).trim();
  if (credential.length < 32) throw new Error("Existing device credential is invalid.");
  return { version: 1, deviceId: saved.deviceId, relayUrl: saved.relayUrl, allowRoot: saved.allowRoot };
}

export async function persistApprovedConfig(stateRoot, pending) {
  if (!pending || Date.now() >= pending.expiresAt) throw new Error("Pairing code expired; start again.");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const credentialPath = join(stateRoot, "device-credential.txt");
  const configurationPath = join(stateRoot, "device.json");
  let wroteCredential = false;
  try {
    await writeFile(credentialPath, pending.secret + "\n", { flag: "wx", mode: 0o600 });
    wroteCredential = true;
    await writeFile(configurationPath, JSON.stringify({
      version: 1, deviceId: pending.deviceId, relayUrl: pending.relayUrl, allowRoot: pending.allowRoot
    }) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (wroteCredential) await unlink(credentialPath).catch(() => {});
    throw new Error("Could not save the device identity without replacing existing state.");
  }
}

function constantTimeTokenMatches(provided, token) {
  if (typeof provided !== "string" || provided.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

export async function createWizard(options = {}) {
  const stateRoot = options.stateRoot || join(process.env.LOCALAPPDATA || "", "TetherplaneStoreDevOnly");
  if (!isAbsolute(stateRoot)) throw new Error("User-local state directory is required.");
  const packageRoot = options.packageRoot || packageDirectory;
  const readAssets = options.readAssets || readFile;
  const spawnAgent = options.spawnAgent || spawn;
  const fetchImpl = options.fetchImpl || fetch;
  const token = randomBytes(32).toString("base64url");
  const current = { pending: null, agent: null, status: "idle", lastError: null };
  const saved = await readSavedConfig(stateRoot);
  const server = createServer(async (req, res) => {
    try {
      const origin = "http://127.0.0.1:" + server.address().port;
      const host = "127.0.0.1:" + server.address().port;
      if (req.headers.host !== host) return send(res, 400, { error: "Invalid local host." });
      const url = new URL(req.url || "/", origin);
      if (req.method === "GET" && ["/", "/setup-client.js", "/setup.css"].includes(url.pathname)) {
        const name = url.pathname === "/" ? "setup.html" : url.pathname.slice(1);
        const body = await readAssets(join(appDirectory, name));
        res.writeHead(200, { ...NO_CACHE, "content-type": name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html",
          "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(body);
        return;
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
      if (!constantTimeTokenMatches(req.headers["x-tetherplane-setup"], token))
        return send(res, 403, { error: "Local setup authorization required." });
      if (req.method === "GET" && url.pathname === "/api/status") {
        return send(res, 200, {
          state: current.status, hasSavedIdentity: Boolean(saved),
          pending: current.pending ? { userCode: current.pending.userCode, expiresAt: new Date(current.pending.expiresAt).toISOString() } : null,
          lastError: current.lastError,
          connected: "not_verified"
        });
      }
      if (req.method !== "POST" || req.headers.origin !== origin) return send(res, 403, { error: "Same-origin user action required." });
      const body = await parseBody(req);
      if (url.pathname === "/api/pair") {
        if (saved || current.pending) throw new Error("An existing identity or pairing session must not be replaced.");
        const deviceId = validateDeviceId(body.deviceId);
        const relayUrl = validateRelayUrl(body.relayUrl);
        const allowRoot = await validateAllowedRoot(body.allowRoot);
        const secret = randomBytes(32).toString("base64url");
        const challenge = await requestPairing({ deviceId, relayUrl, secret }, { fetchImpl });
        current.pending = { deviceId, relayUrl, allowRoot, secret, userCode: challenge.userCode, expiresAt: Date.parse(challenge.expiresAt) };
        current.status = "awaiting_owner_approval";
        return send(res, 200, { userCode: challenge.userCode, expiresAt: challenge.expiresAt, guidance: "Approve this code in your existing owner-authenticated Tetherplane Control Center." });
      }
      if (url.pathname === "/api/start") {
        if (current.agent && current.agent.exitCode === null) throw new Error("This wizard already owns a running agent.");
        if (body.confirmation !== "I APPROVED THIS DEVICE") throw new Error("Explicit owner approval confirmation required.");
        let config;
        if (saved) config = saved;
        else {
          if (!current.pending) throw new Error("Request and approve a pairing code first.");
          await persistApprovedConfig(stateRoot, current.pending);
          config = { deviceId: current.pending.deviceId, relayUrl: current.pending.relayUrl, allowRoot: current.pending.allowRoot };
          current.pending = null;
        }
        const executable = join(packageRoot, "bin", "tetherd.exe");
        if (!(await stat(executable)).isFile()) throw new Error("Packaged agent executable is missing.");
        const args = agentArgs(config, join(stateRoot, "device-credential.txt"), join(stateRoot, "agent-state"));
        await mkdir(join(stateRoot, "agent-state"), { recursive: true, mode: 0o700 });
        const child = spawnAgent(executable, args, { cwd: stateRoot, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        current.agent = child;
        current.status = "agent_started_not_verified";
        current.lastError = null;
        child.once("error", () => { current.status = "start_failed"; current.lastError = "Agent launch failed; inspect the local application event log."; });
        child.once("exit", (code) => {
          if (current.agent === child) { current.agent = null; current.status = "agent_exited"; current.lastError = "Agent exited (code " + Number(code) + "). Authorization and Smart App Control have not been independently verified."; }
        });
        child.stderr?.resume();
        return send(res, 200, { state: current.status, connected: "not_verified" });
      }
      if (url.pathname === "/api/stop") {
        if (current.agent && current.agent.exitCode === null) current.agent.kill();
        current.status = "stopping";
        return send(res, 200, { state: current.status });
      }
      return send(res, 404, { error: "Unknown action" });
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : "Setup failed." });
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const url = "http://127.0.0.1:" + server.address().port + "/#" + token;
  return {
    url, server, state: current,
    close: async () => { await new Promise(resolveClose => server.close(resolveClose)); },
  };
}

async function verifyPackage() {
  const expected = ["bin/tetherd.exe", "runtime/node.exe", "adapters/compact-mcp/dist/stdio-server.js"];
  const results = {};
  for (const name of expected) {
    try { results[name] = (await stat(join(packageDirectory, ...name.split("/")))).isFile(); }
    catch { results[name] = false; }
  }
  console.log(JSON.stringify({ kind: "msix-runtime-self-test", assets: results, success: Object.values(results).every(Boolean) }));
  if (Object.values(results).some(x => !x)) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).includes("--self-test")) await verifyPackage();
  else {
    const wizard = await createWizard();
    if (process.platform === "win32") {
      const child = spawn("explorer.exe", [wizard.url], { windowsHide: true, stdio: "ignore" });
      child.on("error", () => console.error("Open the Store app again if the browser did not launch."));
    } else console.error("Wizard available only on Windows.");
  }
}
