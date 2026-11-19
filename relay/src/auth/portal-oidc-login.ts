import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeJwt } from "jose";
import type { ClientAuthenticator, ClientIdentity } from "./static-auth.ts";
import { isAuthorizedOwnerIdentity } from "./static-auth.ts";

const PENDING_FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_FLOWS = 96;
const MAX_OWNER_SESSION_SECONDS = 60 * 60;
export const PORTAL_OIDC_STATE_COOKIE = "tetherplane_portal_oidc_state";

export type PortalOidcLoginConfig = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  clientId: string;
  resource: string;
  scopes: string[];
};

export type PortalLoginResult = {
  identity: ClientIdentity;
  sessionMaxAgeSeconds: number;
};

type PendingFlow = {
  verifier: string;
  expiresAt: number;
};

function checkedHttpsOrLoopback(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid portal OIDC " + label);
  }
  const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
    url.username || url.password || url.hash || url.search
  ) {
    throw new Error("Unsafe portal OIDC " + label);
  }
  return url;
}

function constantTimeMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function pendingCookie(value: string, secure: boolean, maxAge: number): string {
  return (
    PORTAL_OIDC_STATE_COOKIE + "=" + value +
    "; Path=/portal/auth; HttpOnly; SameSite=Lax; Max-Age=" + maxAge +
    (secure ? "; Secure" : "")
  );
}

export function clearPendingCookie(secure: boolean): string {
  return pendingCookie("", secure, 0);
}

export function readPendingCookie(raw: string | undefined): string | null {
  if (!raw) return null;
  const entries = raw.split(";").map((s) => s.trim());
  const found = entries.filter((s) => s.startsWith(PORTAL_OIDC_STATE_COOKIE + "="));
  if (found.length !== 1) return null;
  const value = found[0]!.slice(PORTAL_OIDC_STATE_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{32,96}$/.test(value) ? value : null;
}

/**
 * Server-side Authorization Code + PKCE login. The browser only receives the
 * one-time state cookie and its existing opaque HttpOnly portal session cookie.
 * Neither access tokens nor PKCE verifiers enter URL parameters, DOM or storage.
 */
export class PortalOidcLogin {
  readonly #options: PortalOidcLoginConfig;
  readonly #authenticator: ClientAuthenticator;
  readonly #pending = new Map<string, PendingFlow>();
  readonly secureCookies: boolean;

  constructor(options: PortalOidcLoginConfig, authenticator: ClientAuthenticator) {
    const issuer = checkedHttpsOrLoopback(options.issuer, "issuer");
    const authorizationEndpoint = checkedHttpsOrLoopback(options.authorizationEndpoint, "authorizationEndpoint");
    const tokenEndpoint = checkedHttpsOrLoopback(options.tokenEndpoint, "tokenEndpoint");
    const redirectUri = checkedHttpsOrLoopback(options.redirectUri, "redirectUri");
    const resource = checkedHttpsOrLoopback(options.resource, "resource");
    if (
      issuer.pathname !== "/" ||
      !["/auth"].includes(authorizationEndpoint.pathname) ||
      tokenEndpoint.pathname !== "/token" ||
      redirectUri.pathname !== "/portal/auth/callback" ||
      authorizationEndpoint.origin !== issuer.origin ||
      tokenEndpoint.origin !== issuer.origin ||
      resource.origin !== issuer.origin ||
      options.clientId.length < 8 ||
      options.clientId.length > 256 ||
      /[\x00-\x20\x7F]/.test(options.clientId) ||
      !options.scopes.includes("openid") ||
      !options.scopes.includes("tetherplane:access") ||
      options.scopes.some((scope) => !/^[A-Za-z0-9:._-]+$/.test(scope))
    ) {
      throw new Error("Portal OIDC settings do not match approved TetherAuth boundaries");
    }
    this.#options = structuredClone(options);
    this.#authenticator = authenticator;
    this.secureCookies = redirectUri.protocol === "https:";
  }

  begin(): { location: string; cookie: string } {
    const now = Date.now();
    for (const [key, value] of this.#pending) {
      if (value.expiresAt <= now) this.#pending.delete(key);
    }
    while (this.#pending.size >= MAX_PENDING_FLOWS) {
      const first = this.#pending.keys().next().value;
      if (!first) break;
      this.#pending.delete(first);
    }

    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    this.#pending.set(state, {
      verifier,
      expiresAt: now + PENDING_FLOW_TTL_MS,
    });
    const url = new URL(this.#options.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#options.clientId);
    url.searchParams.set("redirect_uri", this.#options.redirectUri);
    url.searchParams.set("scope", this.#options.scopes.join(" "));
    url.searchParams.set("resource", this.#options.resource);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    return {
      location: url.href,
      cookie: pendingCookie(state, this.secureCookies, PENDING_FLOW_TTL_MS / 1000),
    };
  }

  async finish(args: {
    state: string | null;
    code: string | null;
    cookie: string | null;
  }): Promise<PortalLoginResult> {
    const { state, code, cookie } = args;
    if (
      !state || !code || !cookie ||
      !/^[A-Za-z0-9_-]{32,96}$/.test(state) ||
      code.length > 4096 ||
      !constantTimeMatch(state, cookie)
    ) {
      throw new Error("Invalid or missing portal OAuth state");
    }

    const pending = this.#pending.get(state);
    // Consume the state *before* token exchange, even if exchange fails.
    this.#pending.delete(state);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new Error("Portal OAuth state has expired or already been used");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.#options.redirectUri,
      client_id: this.#options.clientId,
      code_verifier: pending.verifier,
      resource: this.#options.resource,
    });
    // Never follow redirects to another token endpoint; do not log responses.
    const response = await fetch(this.#options.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(7_000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    if (!response.ok) throw new Error("TetherAuth did not issue a valid authorization response");
    const raw = await response.text();
    if (raw.length > 32_768) throw new Error("Oversized TetherAuth response");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid TetherAuth token response");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Malformed TetherAuth token response");
    }
    const data = parsed as Record<string, unknown>;
    if (
      typeof data.access_token !== "string" ||
      data.access_token.length < 8 ||
      typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer"
    ) {
      throw new Error("Invalid TetherAuth access token response");
    }

    const identity = await this.#authenticator.authenticate(data.access_token);
    if (!isAuthorizedOwnerIdentity(identity) || identity?.clientId !== this.#options.clientId) {
      throw new Error("TetherAuth credential is not an authorized owner for this portal");
    }
    let expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? Math.floor(data.expires_in)
      : 900;
    // The authenticator has already verified the JWT signature, issuer,
    // audience and scope. A login session must never outlive the signed exp.
    try {
      const claims = decodeJwt(data.access_token);
      if (typeof claims.exp === "number") {
        expiresIn = Math.min(expiresIn, Math.floor(claims.exp - Date.now() / 1000));
      }
    } catch {
      // Test-only static authenticators accept opaque local fixtures; the
      // production OIDC authenticator always rejects opaque access tokens.
    }
    if (expiresIn < 1) throw new Error("TetherAuth access credential is already expired");
    return {
      identity,
      sessionMaxAgeSeconds: Math.min(MAX_OWNER_SESSION_SECONDS, expiresIn),
    };
  }

  close(): void {
    this.#pending.clear();
  }
}
