import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { RelayClient, PortalError, validDeviceId } from "./relay-client.ts";

type Session = { token: string; csrf: string; expiresAt: number };

export class ControlCenterServer {
  readonly #relay: RelayClient;
  readonly #sessions = new Map<string, Session>();
  readonly #expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #server;
  #origin = "";
  #cookieName = "";
  #loginWindow = 0;
  #loginAttempts = 0;
  #pairWindow = 0;
  #pairAttempts = 0;

  constructor(options: {
    relayUrl: string;
    sessionTtlMs?: number;
    now?: () => number;
  }) {
    this.#relay = new RelayClient(options.relayUrl);
    this.#now = options.now ?? Date.now;
    this.#ttl = options.sessionTtlMs ?? 15 * 60_000;
    if (!Number.isFinite(this.#ttl) || this.#ttl < 1 || this.#ttl > 15 * 60_000)
      throw new Error("Session lifetime must be between 1 ms and 15 minutes.");
    this.#server = createServer(
      {
        maxHeaderSize: 16 * 1024,
        requestTimeout: 10_000,
        headersTimeout: 5000,
      },
      (request, response) => {
        void this.#handle(request, response);
      },
    );
  }

  async listen(options: { port?: number } = {}): Promise<string> {
    const port = options.port ?? 8790;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid local port.");
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string")
      throw new Error("Local listener unavailable.");
    this.#origin = `http://127.0.0.1:${address.port}`;
    this.#cookieName = `tetherplane_cc_${address.port}`;
    return this.#origin;
  }

  async close(): Promise<void> {
    for (const id of this.#sessions.keys()) this.#forget(id);
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    secureHeaders(response);
    let sessionId: string | undefined;
    try {
      if (
        request.headers.host !== new URL(this.#origin).host ||
        request.headers["sec-fetch-site"] === "cross-site" ||
        (request.headers.origin && request.headers.origin !== this.#origin)
      ) {
        throw new PortalError(
          403,
          "origin_denied",
          "Open Control Center at its local address.",
        );
      }
      if (request.url?.includes("?") || !request.url?.startsWith("/"))
        throw new PortalError(404, "not_found", "Page not found.");
      const pathname = request.url;
      if (!pathname.startsWith("/api/")) {
        const file = staticFiles[pathname];
        if (!file) throw new PortalError(404, "not_found", "Page not found.");
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new PortalError(
            405,
            "method_not_allowed",
            "Method not allowed.",
          );
        const content = await readFile(
          new URL(`../public/${file[0]}`, import.meta.url),
        );
        response.writeHead(200, { "content-type": file[1] });
        response.end(request.method === "HEAD" ? undefined : content);
        return;
      }
      const revoke =
        /^\/api\/devices\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/revoke$/.exec(
          pathname,
        );
      const methods =
        pathname === "/api/session"
          ? ["GET", "POST"]
          : pathname === "/api/devices"
            ? ["GET"]
            : pathname === "/api/logout" || pathname === "/api/pair/approve" || revoke
              ? ["POST"]
              : [];
      if (!methods.length)
        throw new PortalError(404, "not_found", "Operation not found.");
      if (!methods.includes(request.method ?? "")) {
        response.setHeader("allow", methods.join(", "));
        throw new PortalError(405, "method_not_allowed", "Method not allowed.");
      }
      if (request.method === "POST") {
        if (request.headers.origin !== this.#origin)
          throw new PortalError(
            403,
            "origin_denied",
            "A same-origin request is required.",
          );
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            request.headers["content-type"] ?? "",
          )
        )
          throw new PortalError(
            415,
            "unsupported_media_type",
            "Send JSON requests only.",
          );
      }
      this.#prune();
      sessionId = getCookie(request.headers.cookie, this.#cookieName);
      if (pathname === "/api/session" && request.method === "POST") {
        this.#limitLogin();
        const body = await readJson(request);
        if (
          typeof body.token !== "string" ||
          body.token.length > 8192 ||
          !/^[A-Za-z0-9._~+\/-]+=*$/.test(body.token)
        )
          throw new PortalError(
            400,
            "invalid_credential",
            "Enter an existing authorized relay access credential.",
          );
        const devices = await this.#relay.directory(body.token);
        if (this.#sessions.size >= 64)
          throw new PortalError(
            429,
            "session_limit",
            "Too many local sessions. Sign out or wait for expiry.",
          );
        if (sessionId) this.#forget(sessionId);
        const id = randomBytes(32).toString("base64url");
        const session = {
          token: body.token,
          csrf: randomBytes(32).toString("base64url"),
          expiresAt: this.#now() + this.#ttl,
        };
        this.#sessions.set(id, session);
        const expiry = setTimeout(() => this.#forget(id), this.#ttl);
        expiry.unref();
        this.#expiryTimers.set(id, expiry);
        response.setHeader(
          "set-cookie",
          `${this.#cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(this.#ttl / 1000)}`,
        );
        writeJson(response, 200, this.#view(session, devices));
        return;
      }
      const session = sessionId ? this.#sessions.get(sessionId) : undefined;
      if (!session)
        throw new PortalError(
          401,
          "authentication_required",
          "Sign in with an authorized relay credential.",
        );
      if (
        request.method === "POST" &&
        !equalSecret(request.headers["x-csrf-token"], session.csrf)
      )
        throw new PortalError(
          403,
          "csrf_denied",
          "Refresh this page before trying again.",
        );
      if (pathname === "/api/logout") {
        this.#forget(sessionId!);
        writeJson(response, 200, { signedOut: true });
        return;
      }
      if (pathname === "/api/pair/approve") {
        const body = await readJson(request);
        if (body.confirmOwnership !== true || typeof body.userCode !== "string" ||
            !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(body.userCode))
          throw new PortalError(400, "confirmation_required",
            "Enter the code displayed on your authorized device and confirm you requested pairing.");
        const now = this.#now();
        if (now - this.#pairWindow >= 60_000) {
          this.#pairWindow = now;
          this.#pairAttempts = 0;
        }
        if (++this.#pairAttempts > 10)
          throw new PortalError(429, "rate_limited", "Too many pairing attempts. Wait one minute, then refresh.");
        await this.#relay.directory(session.token);
        if (!this.#sessions.has(sessionId!) || session.expiresAt <= this.#now())
          throw new PortalError(401, "authentication_required", "Session expired. Sign in again.");
        const deviceId = await this.#relay.approvePairing(session.token, body.userCode);
        writeJson(response, 200, { paired: true, deviceId });
        return;
      }
      if (revoke) {
        const body = await readJson(request);
        const deviceId = revoke[1]!;
        if (!validDeviceId(deviceId) || body.confirmDeviceId !== deviceId)
          throw new PortalError(
            400,
            "confirmation_required",
            "Type the exact device ID to confirm revocation.",
          );
        const devices = await this.#relay.directory(session.token);
        const device = devices.find(
          (device) => device.deviceId === deviceId && device.revokedAt === null,
        );
        if (!device)
          throw new PortalError(
            403,
            "permission_denied",
            "This active device is not in your current account directory.",
          );
        if (!this.#sessions.has(sessionId!) || session.expiresAt <= this.#now())
          throw new PortalError(
            401,
            "authentication_required",
            "Session expired. Sign in again.",
          );
        await this.#relay.revoke(session.token, deviceId);
        writeJson(response, 200, { revoked: true });
        return;
      }
      const devices = await this.#relay.directory(session.token);
      if (!this.#sessions.has(sessionId!) || session.expiresAt <= this.#now())
        throw new PortalError(
          401,
          "authentication_required",
          "Session expired. Sign in again.",
        );
      writeJson(response, 200, this.#view(session, devices));
    } catch (error) {
      const failure =
        error instanceof PortalError
          ? error
          : new PortalError(
              500,
              "internal_error",
              "The local portal could not complete this request.",
            );
      if (failure.status === 401) {
        if (sessionId) this.#forget(sessionId);
      }
      writeJson(response, failure.status, {
        error: { code: failure.code, message: failure.message },
      });
    }
  }

  #view(
    session: Session,
    devices: Awaited<ReturnType<RelayClient["directory"]>>,
  ) {
    return {
      devices,
      csrfToken: session.csrf,
      expiresAt: new Date(session.expiresAt).toISOString(),
      observedAt: new Date(this.#now()).toISOString(),
    };
  }
  #forget(id: string) {
    clearTimeout(this.#expiryTimers.get(id));
    this.#expiryTimers.delete(id);
    this.#sessions.delete(id);
    // Do not clear browser cookies from an old request: its response may arrive
    // after a replacement login. An expired opaque ID carries no authority.
  }
  #prune() {
    for (const [id, session] of this.#sessions)
      if (session.expiresAt <= this.#now()) this.#forget(id);
  }
  #limitLogin() {
    const now = this.#now();
    if (now - this.#loginWindow >= 60_000) {
      this.#loginWindow = now;
      this.#loginAttempts = 0;
    }
    if (++this.#loginAttempts > 30)
      throw new PortalError(
        429,
        "rate_limited",
        "Too many sign-in attempts. Wait one minute and try again.",
      );
  }
}

const staticFiles: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/assets/logo.jpg": ["assets/logo.jpg", "image/jpeg"],
  ...Object.fromEntries(
    [1, 2, 3, 4].map((n) => [
      `/assets/ascii/${n}.png`,
      [`assets/ascii/${n}.png`, "image/png"] as [string, string],
    ]),
  ),
};

function secureHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
}
function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}
function getCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  const values = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
}
function equalSecret(
  actual: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const data = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      rejected = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 12 * 1024) {
        if (!rejected) {
          rejected = true;
          reject(
            new PortalError(413, "body_too_large", "Request is too large."),
          );
        }
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    request.once("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.once("error", reject);
    request.once("aborted", () =>
      reject(
        new PortalError(400, "invalid_request", "Request was interrupted."),
      ),
    );
  });
  try {
    const body: unknown = JSON.parse(data.toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body))
      return body as Record<string, unknown>;
  } catch {
    /* Never echo request bodies. */
  }
  throw new PortalError(400, "invalid_request", "A JSON object is required.");
}
