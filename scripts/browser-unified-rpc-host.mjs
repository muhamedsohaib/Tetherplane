/**
 * Tetherplane local browser RPC composition: isolated CDP + owner-approved Edge.
 *
 * SECURITY: loopback-only, same bearer token as existing browser bridge, no
 * cookie/password access, no remote origin grants, and no ability to attach a
 * human-owned tab without the existing authenticated extension grant.
 *
 * Missing authenticated extension is nonfatal for Tetherplane-owned CDP tabs.
 * A tab: page never falls back to CDP, including during expiry/disconnect.
 */
import net from "node:net";
import process from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const OPERATIONS = Object.freeze([
  "status", "pages", "create_tab", "snapshot", "navigate", "close",
  "act", "wait", "upload", "downloads", "diagnostics", "checkpoint",
]);
const MAX_REQUEST_BYTES = 1_048_576;
const LOOPBACK = "127.0.0.1";
const MANAGED_ID = /^cdp:[0-9A-Fa-f]+$/;
const OWNER_ID = /^tab:[0-9]+$/;

function failure(requestId, code, message) {
  return {
    request_id: requestId,
    status: "error",
    error: { code, message, details: {} },
    verification: "failed",
  };
}
function eqToken(provided, expected) {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function allowedPage(page, source) {
  if (!page || typeof page !== "object" || Array.isArray(page)) return false;
  if (typeof page.page_id !== "string") return false;
  if (source === "managed") {
    return MANAGED_ID.test(page.page_id) && page.ownership === "tetherplane";
  }
  return OWNER_ID.test(page.page_id) &&
    ["shared-observe", "shared-authorized", "tetherplane"].includes(page.ownership);
}
function backendFor(args) {
  if (args && typeof args === "object") {
    const id = args.page_id;
    if (typeof id !== "string") return null;
    if (MANAGED_ID.test(id)) return "managed";
    if (OWNER_ID.test(id)) return "owner";
  }
  return null;
}

export async function callUpstream({ port, request, timeoutMs = 3500 }) {
  return await new Promise((resolve, reject) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      reject(new Error("Invalid upstream port"));
      return;
    }
    const client = net.connect({ host: LOOPBACK, port });
    let done = false, buffer = "";
    function finish(err, data) {
      if (done) return;
      done = true;
      client.destroy();
      if (err) reject(err);
      else resolve(data);
    }
    client.setTimeout(timeoutMs, () => finish(new Error("Upstream deadline")));
    client.once("error", (err) => finish(err));
    client.once("connect", () => client.write(JSON.stringify(request) + "\n"));
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        finish(new Error("Upstream response too large"));
        return;
      }
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, index));
        if (!response || typeof response !== "object" ||
          response.request_id !== request.request_id ||
          (response.status !== "success" && response.status !== "error")) {
          throw new Error("Invalid upstream response");
        }
        finish(null, response);
      } catch {
        finish(new Error("Untrusted upstream response"));
      }
    });
    client.once("end", () => {
      if (!done) finish(new Error("Upstream disconnected"));
    });
  });
}

export function createBrowserUnifiedHandler({
  agentToken, managedPort = 17655, ownerPort = 17657,
  timeoutMs = 3500, listTimeoutMs = 1500, upstream = callUpstream,
} = {}) {
  if (typeof agentToken !== "string" || agentToken.length < 16 ||
    agentToken.length > 512 || /[\r\n\0]/.test(agentToken)) {
    throw new Error("Valid local browser token required");
  }
  if (managedPort === ownerPort) throw new Error("Backends require separate ports");
  if (!Number.isInteger(listTimeoutMs) || listTimeoutMs < 100 ||
    listTimeoutMs >= timeoutMs || listTimeoutMs >= 3000) {
    throw new Error("Browser-list deadline must be shorter than the caller deadline");
  }
  const invoke = async (source, request, budgetMs = timeoutMs) =>
    await upstream({
      port: source === "owner" ? ownerPort : managedPort,
      request,
      timeoutMs: budgetMs,
    });

  return async function handle(request) {
    const id = typeof request?.request_id === "string"
      ? request.request_id.slice(0, 256)
      : "unknown";
    if (!eqToken(request?.token, agentToken)) {
      return failure(id, "permission_denied", "browser bridge authentication failed");
    }
    if (request.type === "handshake") {
      // A fail-closed handshake does not depend on extension pairing.
      // The CDP bridge must be reachable to offer the default browser provider.
      try {
        const upstreamResponse = await invoke("managed", {
          type: "handshake", request_id: id, token: agentToken,
        });
        if (upstreamResponse.status !== "success") {
          return failure(id, "capability_unavailable", "managed browser bridge unavailable");
        }
        return {
          request_id: id, status: "success",
          data: { protocol_version: "1.0", operations: [...OPERATIONS] },
          verification: "not_applicable",
        };
      } catch {
        return failure(id, "capability_unavailable", "managed browser bridge unavailable");
      }
    }
    if (request.type !== "invoke" ||
      typeof request.capability !== "string" ||
      !request.capability.startsWith("browser.") ||
      !OPERATIONS.includes(request.capability.slice(8)) ||
      request.arguments === null ||
      (request.arguments !== undefined &&
        (typeof request.arguments !== "object" || Array.isArray(request.arguments)))) {
      return failure(id, "invalid_arguments", "invalid browser RPC invocation");
    }
    const op = request.capability.slice(8);
    const args = request.arguments ?? {};
    const sanitized = { type: "invoke", request_id: id,
      token: agentToken, capability: request.capability, arguments: args };
    if (op === "status") {
      // A listening authenticated RPC socket is not proof that the Edge
      // extension worker is responsive. Only report owner_extension=true
      // after a bounded grant-filtered pages request is answered. Do not
      // include page metadata in the status response.
      const ownerHealth = {
        ...sanitized,
        capability: "browser.pages",
        arguments: {},
      };
      const [managed, owner] = await Promise.allSettled([
        invoke("managed", sanitized, listTimeoutMs),
        invoke("owner", ownerHealth, listTimeoutMs),
      ]);
      const managedOK = managed.status === "fulfilled" &&
        managed.value.status === "success";
      const ownerOK = owner.status === "fulfilled" &&
        owner.value.status === "success" &&
        Array.isArray(owner.value.data?.pages);
      if (!managedOK && !ownerOK) {
        return failure(id, "capability_unavailable", "browser backends are unavailable");
      }
      return {
        request_id: id, status: "success", verification: "not_applicable",
        data: {
          available: true, mode: "background_only",
          capabilities: {
            backend: "cdp_plus_owner_authorized_extension",
            ownership: "tetherplane_and_explicitly_shared",
            operations: [...OPERATIONS],
            unavailable_operations: ["attach", "detach"],
            backends: { cdp: managedOK, owner_extension: ownerOK },
          },
        },
      };
    }
    if (op === "pages") {
      const [managed, owner] = await Promise.allSettled([
        invoke("managed", sanitized, listTimeoutMs),
        invoke("owner", sanitized, listTimeoutMs),
      ]);
      const m = managed.status === "fulfilled" && managed.value.status === "success"
        ? managed.value.data?.pages : null;
      const e = owner.status === "fulfilled" && owner.value.status === "success"
        ? owner.value.data?.pages : null;
      if (!Array.isArray(m) && !Array.isArray(e)) {
        return failure(id, "capability_unavailable", "browser backends are unavailable");
      }
      return {
        request_id: id, status: "success", verification: "not_applicable",
        data: { pages: [
          ...(Array.isArray(m) ? m.filter(p => allowedPage(p, "managed")) : []),
          ...(Array.isArray(e) ? e.filter(p => allowedPage(p, "owner")) : []),
        ] },
      };
    }
    let target = null;
    if (op === "create_tab") {
      if (args.backend !== undefined && args.backend !== "managed" &&
        args.backend !== "owner") {
        return failure(id, "invalid_arguments", "invalid browser backend");
      }
      target = args.backend === "owner" ? "owner" : "managed";
    } else {
      target = backendFor(args);
      if (!target && ["downloads", "diagnostics"].includes(op) &&
        args.page_id === undefined) {
        // Global diagnostics from a signed-in human browser require
        // explicit grant, so global queries default to isolated CDP.
        target = "managed";
      }
    }
    if (!target) {
      return failure(id, "permission_denied",
        "browser page is unavailable or has not been shared");
    }
    try {
      const result = await invoke(target, sanitized);
      if (!result || typeof result !== "object" ||
        (result.status !== "success" && result.status !== "error")) {
        throw new Error("Malformed backend response");
      }
      // Existing authenticated extension policy authorizes the exact tab,
      // origin, operation and TTL. Never route failed owner requests to CDP.
      return result;
    } catch {
      return failure(id, "capability_unavailable",
        target === "owner"
          ? "owner-approved browser extension is not connected"
          : "managed CDP browser bridge is unavailable");
    }
  };
}

export async function startBrowserUnifiedRpcServer({
  host = LOOPBACK, port = 17660, handler,
} = {}) {
  if (host !== LOOPBACK || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Unified browser RPC must bind to an explicit loopback port");
  }
  if (typeof handler !== "function") throw new Error("Unified handler missing");
  const server = net.createServer((socket) => {
    socket.setTimeout(6500, () => socket.destroy());
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (part) => {
      buffer += part.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      socket.removeAllListeners("data");
      const line = buffer.slice(0, i);
      let request;
      try { request = JSON.parse(line); }
      catch {
        socket.end(JSON.stringify(failure("unknown", "invalid_arguments",
          "browser RPC request is not valid JSON")) + "\n");
        return;
      }
      Promise.resolve(handler(request))
        .then(response => { if (!socket.destroyed) socket.end(JSON.stringify(response) + "\n"); })
        .catch(() => { if (!socket.destroyed) socket.end(JSON.stringify(
          failure("unknown", "provider_failure", "browser bridge failure")) + "\n"); });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    address: LOOPBACK + ":" + port,
    close: () => new Promise((resolve, reject) =>
      server.close(err => err ? reject(err) : resolve())),
  };
}

if (process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.join(process.env.LOCALAPPDATA ?? "", "Tetherplane");
  const token = (await readFile(path.join(root, "browser-bridge.token"), "utf8")).trim();
  const handler = createBrowserUnifiedHandler({ agentToken: token });
  const server = await startBrowserUnifiedRpcServer({ handler });
  process.stdout.write("UNIFIED_BROWSER_RPC_READY=" + server.address + "\n");
  const stop = async () => { await server.close(); process.exitCode = 0; };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}
