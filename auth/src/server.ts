import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
} from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

import type {
  TetherAuthInteractionController,
} from "./interaction.ts";

export type TetherAuthProviderHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

export type TetherAuthTlsOptions = {
  cert: string | Buffer;
  key: string | Buffer;
};

export type TetherAuthServerInteractions =
  Pick<
    TetherAuthInteractionController,
    "beginLogin" | "completeLogin"
  > &
  Partial<
    Pick<
      TetherAuthInteractionController,
      "beginInteraction" | "completeConsent"
    >
  >;

export type TetherAuthServerOptions = {
  providerHandler: TetherAuthProviderHandler;
  interactions?: TetherAuthServerInteractions;
  tls?: TetherAuthTlsOptions;
  allowInsecureLocalhost?: boolean;
  dcrRateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
};

const DEFAULT_DCR_RATE_LIMIT = {
  maxRequests: 30,
  windowMs: 3_600_000,
};
const MAX_FORM_PROOFS = 1024;
const FORM_PROOF_TTL_MS = 5 * 60_000;

export type TetherAuthListenOptions = {
  host: string;
  port: number;
};

export type TetherAuthAddress = {
  url: string;
};

export class TetherAuthServer {
  readonly #providerHandler: TetherAuthProviderHandler;
  readonly #interactions:
    | TetherAuthServerInteractions
    | undefined;
  readonly #tls: TetherAuthTlsOptions | undefined;
  readonly #allowInsecureLocalhost: boolean;
  #server: HttpServer | null = null;
  readonly #formProofs = new Map<string, { csrf: string; kind: "login" | "consent"; expiresAt: number }>();
  readonly #dcrMaxRequests: number;
  readonly #dcrWindowMs: number;
  #dcrWindowStart: number | null = null;
  #dcrCount = 0;

  constructor(options: TetherAuthServerOptions) {
    if (typeof options.providerHandler !== "function") {
      throw new Error(
        "tether-auth requires an OIDC provider handler",
      );
    }
    const dcrMaxRequests =
      options.dcrRateLimit?.maxRequests ??
      DEFAULT_DCR_RATE_LIMIT.maxRequests;
    const dcrWindowMs =
      options.dcrRateLimit?.windowMs ??
      DEFAULT_DCR_RATE_LIMIT.windowMs;
    if (
      !Number.isInteger(dcrMaxRequests) ||
      dcrMaxRequests < 1 ||
      !Number.isInteger(dcrWindowMs) ||
      dcrWindowMs < 1
    ) {
      throw new Error(
        "tether-auth dynamic registration rate limit must use positive integers",
      );
    }
    this.#providerHandler = options.providerHandler;
    this.#interactions = options.interactions;
    this.#tls = options.tls;
    this.#allowInsecureLocalhost =
      options.allowInsecureLocalhost ?? false;
    this.#dcrMaxRequests = dcrMaxRequests;
    this.#dcrWindowMs = dcrWindowMs;
  }

  async listen(
    options: TetherAuthListenOptions,
  ): Promise<TetherAuthAddress> {
    if (this.#server) {
      throw new Error(
        "tether-auth server is already started",
      );
    }
    validateListenOptions(
      options,
      Boolean(this.#tls),
      this.#allowInsecureLocalhost,
    );

    const handler = (
      request: IncomingMessage,
      response: ServerResponse,
    ) => {
      void this.#handleRequest(request, response);
    };

    const server = this.#tls
      ? createHttpsServer(this.#tls, handler)
      : createHttpServer(handler);
    this.#server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port, options.host);
      });
    } catch (error) {
      this.#server = null;
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error(
        "tether-auth server did not expose a TCP address",
      );
    }

    return {
      url: formatAddress(
        address,
        Boolean(this.#tls),
      ),
    };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#formProofs.clear();
    if (!server || !server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = safePathname(request.url);

    if (
      request.method === "GET" &&
      pathname === "/healthz"
    ) {
      writeJson(response, 200, {
        status: "ok",
      });
      return;
    }
    if (
      request.method === "GET" &&
      pathname === "/readyz"
    ) {
      writeJson(response, 200, {
        status: "ready",
      });
      return;
    }

    if (this.#interactions) {
      const loginMatch =
        /^\/interaction\/([A-Za-z0-9._~-]{8,256})$/.exec(
          pathname,
        );
      if (
        request.method === "GET" &&
        loginMatch?.[1]
      ) {
        try {
          const pending =
            this.#interactions.beginInteraction
              ? await this.#interactions.beginInteraction(
                  request,
                  response,
                  loginMatch[1],
                )
              : {
                  kind: "login" as const,
                  ...(await this.#interactions.beginLogin(
                    request,
                    response,
                    loginMatch[1],
                  )),
                };

          if (!response.writableEnded && wantsHtml(request)) {
            const csrf = this.#issueFormProof(loginMatch[1], pending.kind);
            if (csrf === undefined) {
              response.setHeader("retry-after", String(FORM_PROOF_TTL_MS / 1000));
              writeJson(response, 503, { error: { code: "temporarily_unavailable" } });
              return;
            }
            response.statusCode = 200;
            writeHtml(response, pending.kind === "consent"
              ? consentPage(loginMatch[1], pending.clientId, pending.oidcScopes, pending.resourceScopes, csrf)
              : loginPage(loginMatch[1], pending.userCode, pending.expiresAt, csrf), pending.callbackOrigin);
          } else if (!response.writableEnded) {
            writeJson(
              response,
              200,
              pending.kind === "consent"
                ? {
                    status: "awaiting_consent",
                    clientId: pending.clientId,
                    oidcScopes: pending.oidcScopes,
                    resourceScopes:
                      pending.resourceScopes,
                  }
                : {
                    status:
                      "pending_device_approval",
                    userCode: pending.userCode,
                    expiresAt: pending.expiresAt,
                  },
            );
          }
        } catch {
          if (!response.headersSent) {
            writeJson(response, 400, {
              error: {
                code: "invalid_interaction",
              },
            });
          } else if (!response.writableEnded) {
            response.end();
          }
        }
        return;
      }

      const consentMatch =
        /^\/interaction\/([A-Za-z0-9._~-]{8,256})\/consent$/.exec(
          pathname,
        );
      if (
        request.method === "POST" &&
        consentMatch?.[1]
      ) {
        const bodyKind = interactionBodyKind(request);
        if (bodyKind === undefined) {
          writeJson(response, 415, {
            error: { code: "unsupported_media_type" },
          });
          return;
        }
        try {
          if (!this.#interactions.completeConsent) {
            throw new Error(
              "consent interaction is not supported",
            );
          }
          if (bodyKind === "form") {
            const form = await readForm(request);
            if (!this.#verifyForm(consentMatch[1], "consent", form)) {
              response.writeHead(400).end();
              return;
            }
          }
          await this.#interactions.completeConsent(
            request,
            response,
            consentMatch[1],
          );
          if (
            !response.headersSent &&
            !response.writableEnded
          ) {
            response.statusCode = 204;
            response.end();
          }
        } catch {
          if (!response.headersSent) {
            writeJson(response, 400, {
              error: {
                code: "invalid_interaction",
              },
            });
          } else if (!response.writableEnded) {
            response.end();
          }
        }
        return;
      }

      const completeMatch =
        /^\/interaction\/([A-Za-z0-9._~-]{8,256})\/device-login$/.exec(
          pathname,
        );
      if (
        request.method === "POST" &&
        completeMatch?.[1]
      ) {
        const bodyKind = interactionBodyKind(request);
        if (bodyKind === undefined) {
          writeJson(response, 415, {
            error: { code: "unsupported_media_type" },
          });
          return;
        }
        try {
          const body = bodyKind === "form"
            ? await readForm(request)
            : await readObjectBody(request);
          if (bodyKind === "form" && !this.#verifyForm(completeMatch[1], "login", body)) {
            response.writeHead(400).end();
            return;
          }
          const userCode = stringField(
            body,
            "userCode",
          );
          validateUserCode(userCode);

          const result =
            await this.#interactions.completeLogin(
              request,
              response,
              {
                interactionUid:
                  completeMatch[1],
                userCode,
              },
            );

          if (result === "pending") {
            if (!response.writableEnded) {
              if (bodyKind === "form") {
                response.statusCode = 202;
                writeHtml(response, shell("Device approval pending", "<p>Waiting for approval on your paired device. Return to the previous page after approving and submit again.</p>"));
              } else {
                writeJson(response, 202, {
                  status: "pending_device_approval",
                });
              }
            }
            return;
          }

          if (
            !response.headersSent &&
            !response.writableEnded
          ) {
            response.statusCode = 204;
            response.end();
          }
        } catch {
          if (!response.headersSent) {
            writeJson(response, 400, {
              error: {
                code: "invalid_interaction",
              },
            });
          } else if (!response.writableEnded) {
            response.end();
          }
        }
        return;
      }
    }

    if (
      request.method === "POST" &&
      /^\/reg\/?$/i.test(pathname) &&
      !this.#consumeDcrBudget()
    ) {
      const retryAfterSeconds = this.#dcrRetryAfterSeconds();
      response.setHeader(
        "retry-after",
        String(retryAfterSeconds),
      );
      writeJson(response, 429, {
        error: "temporarily_unavailable",
        error_description:
          "dynamic client registration rate limit exceeded",
      });
      return;
    }

    this.#providerHandler(
      request,
      response,
    );
  }

  #consumeDcrBudget(): boolean {
    const now = Date.now();
    if (
      this.#dcrWindowStart === null ||
      now - this.#dcrWindowStart >= this.#dcrWindowMs
    ) {
      this.#dcrWindowStart = now;
      this.#dcrCount = 0;
    }
    if (this.#dcrCount >= this.#dcrMaxRequests) {
      return false;
    }
    this.#dcrCount += 1;
    return true;
  }

  #dcrRetryAfterSeconds(): number {
    if (this.#dcrWindowStart === null) {
      return 1;
    }
    const remainingMs =
      this.#dcrWindowStart +
      this.#dcrWindowMs -
      Date.now();
    return Math.max(
      1,
      Math.ceil(remainingMs / 1000),
    );
  }

  #issueFormProof(uid: string, kind: "login" | "consent"): string | undefined {
    const now = Date.now();
    for (const [key, proof] of this.#formProofs) {
      if (proof.expiresAt < now) this.#formProofs.delete(key);
    }
    if (!this.#formProofs.has(uid) && this.#formProofs.size >= MAX_FORM_PROOFS) {
      return undefined;
    }
    const csrf = randomBytes(32).toString("hex");
    this.#formProofs.set(uid, { csrf, kind, expiresAt: now + FORM_PROOF_TTL_MS });
    return csrf;
  }

  #verifyForm(uid: string, kind: "login" | "consent", form: Record<string, unknown>): boolean {
    const proof = this.#formProofs.get(uid);
    if (!proof || proof.kind !== kind || proof.expiresAt < Date.now()) {
      this.#formProofs.delete(uid);
      return false;
    }
    const value = form["csrf"];
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return false;
    const received = Buffer.from(value, "hex");
    const expected = Buffer.from(proof.csrf, "hex");
    return timingSafeEqual(received, expected);
  }
}

function validateListenOptions(
  options: TetherAuthListenOptions,
  secure: boolean,
  allowInsecureLocalhost: boolean,
): void {
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error(
      "tether-auth port must be an integer between 0 and 65535",
    );
  }
  if (!options.host.trim()) {
    throw new Error(
      "tether-auth host must be non-empty",
    );
  }

  if (secure) {
    return;
  }
  if (!allowInsecureLocalhost) {
    throw new Error(
      "TLS is required unless insecure localhost mode is explicitly enabled",
    );
  }
  if (!isLoopbackHost(options.host)) {
    throw new Error(
      "plaintext tether-auth binding is restricted to loopback",
    );
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

function safePathname(
  rawUrl: string | undefined,
): string {
  try {
    return new URL(
      rawUrl ?? "/",
      "http://localhost",
    ).pathname;
  } catch {
    return "/";
  }
}

async function readObjectBody(
  request: IncomingMessage,
  maxBytes = 16 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error(
        "interaction request body exceeds size limit",
      );
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const parsed = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "interaction request body must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function stringField(
  body: Record<string, unknown>,
  name: string,
): string {
  const value = body[name];
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(
      `${name} must be a non-empty string`,
    );
  }
  return value.trim();
}

function validateUserCode(
  value: string,
): void {
  if (
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(
      value,
    )
  ) {
    throw new Error(
      "device-login code is invalid",
    );
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader(
    "content-type",
    "application/json",
  );
  response.setHeader(
    "cache-control",
    "no-store",
  );
  response.setHeader(
    "content-length",
    Buffer.byteLength(body),
  );
  response.end(body);
}

function formatAddress(
  address: AddressInfo,
  secure: boolean,
): string {
  const protocol = secure
    ? "https"
    : "http";
  const host =
    address.family === "IPv6"
      ? `[${address.address}]`
      : address.address;
  return `${protocol}://${host}:${address.port}`;
}


function wantsHtml(request: IncomingMessage): boolean {
  return (request.headers.accept ?? "").includes("text/html");
}
function interactionBodyKind(request: IncomingMessage): "form" | "json" | undefined {
  const contentType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType === "application/x-www-form-urlencoded") return "form";
  if (contentType === "application/json") return "json";
  return undefined;
}
async function readForm(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.from(chunk as Uint8Array).toString("utf8");
    if (Buffer.byteLength(body, "utf8") > 16 * 1024) throw new Error("interaction form exceeds limit");
  }
  const params = new URLSearchParams(body);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw new Error("duplicate interaction form field");
    result[key] = value;
  }
  return result;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function shell(title: string, body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
    escapeHtml(title) + '</title></head><body><main><h1>' + escapeHtml(title) + '</h1>' + body + '</main></body></html>';
}
function csrfField(csrf: string): string {
  return '<input type="hidden" name="csrf" value="' + csrf + '">';
}
function loginPage(uid: string, userCode: string, expiresAt: string, csrf: string): string {
  return shell("Tetherplane device approval", '<p>Approve this one-time code on your paired Tetherplane device:</p><p><strong>' +
    escapeHtml(userCode) + '</strong></p><p>Expires: ' + escapeHtml(expiresAt) +
    '</p><form method="post" action="/interaction/' + encodeURIComponent(uid) + '/device-login">' +
    csrfField(csrf) + '<input type="hidden" name="userCode" value="' + escapeHtml(userCode) +
    '"><button type="submit">Continue after approving</button></form>');
}
function consentPage(uid: string, clientId: string, oidcScopes: string[], resourceScopes: Array<{ resource: string; scopes: string[] }>, csrf: string): string {
  const entries = [...oidcScopes, ...resourceScopes.flatMap(x => x.scopes.map(scope => x.resource + " : " + scope))];
  const scopes = entries.map(x => "<li>" + escapeHtml(x) + "</li>").join("");
  return shell("Tetherplane authorization", '<p>Client: <strong>' + escapeHtml(clientId) + '</strong></p><p>Requested permissions:</p><ul>' +
    scopes + '</ul><form method="post" action="/interaction/' + encodeURIComponent(uid) +
    '/consent">' + csrfField(csrf) + '<button type="submit">Authorize</button></form>');
}
const SAFE_FORM_ACTION_ORIGIN =
  /^(https:\/\/[A-Za-z0-9.-]+(?::\d+)?|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?)$/;
function writeHtml(response: ServerResponse, body: string, formActionOrigin?: string): void {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  const formAction =
    formActionOrigin && SAFE_FORM_ACTION_ORIGIN.test(formActionOrigin)
      ? `form-action 'self' ${formActionOrigin}`
      : "form-action 'self'";
  response.setHeader("content-security-policy", `default-src 'none'; ${formAction}; base-uri 'none'; frame-ancestors 'none'`);
  response.end(body);
}
