import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

import type {
  ClientAuthenticator,
  ClientIdentity,
} from "../auth/static-auth.ts";
import {
  ALL_TOOL_FAMILIES,
  type PermissionProfileId,
  type PolicyMutationInput,
  type PolicyStore,
  type ToolFamily,
} from "../policy/policy-store.ts";
import { renderControlPortalPage } from "../portal/portal-ui.ts";
import type { DeviceRegistry } from "./registry.ts";

const PORTAL_SESSION_COOKIE = "tetherplane_portal_session";
const PORTAL_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_PORTAL_SESSIONS = 256;

type PortalSession = {
  id: string;
  identity: ClientIdentity;
  csrfToken: string;
  expiresAtMs: number;
};

export class RelayControlHttpGateway {
  readonly #registry: DeviceRegistry;
  readonly #authenticator: ClientAuthenticator;
  readonly #disconnectDevice: (deviceId: string) => void;
  readonly #policyStore: PolicyStore | null;
  readonly #secureCookies: boolean;
  readonly #portalSessions = new Map<string, PortalSession>();
  #attachedServer: Server | null = null;
  #requestHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null;

  constructor(options: {
    registry: DeviceRegistry;
    authenticator: ClientAuthenticator;
    disconnectDevice(deviceId: string): void;
    policyStore?: PolicyStore;
    secureCookies?: boolean;
  }) {
    this.#registry = options.registry;
    this.#authenticator = options.authenticator;
    this.#disconnectDevice = options.disconnectDevice;
    this.#policyStore = options.policyStore ?? null;
    this.#secureCookies = options.secureCookies ?? false;
  }

  attach(server: Server): void {
    if (this.#attachedServer) {
      throw new Error("relay control HTTP gateway is already attached");
    }
    this.#attachedServer = server;
    this.#requestHandler = (request, response) => {
      void this.#handleRequest(request, response);
    };
    server.on("request", this.#requestHandler);
  }

  close(): void {
    if (this.#attachedServer && this.#requestHandler) {
      this.#attachedServer.off("request", this.#requestHandler);
    }
    this.#attachedServer = null;
    this.#requestHandler = null;
    this.#portalSessions.clear();
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    try {
      if (
        (url.pathname === "/portal" || url.pathname.startsWith("/portal/")) &&
        hasQueryTokenParameter(url)
      ) {
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("referrer-policy", "no-referrer");
        writeJson(response, 400, {
          error: {
            code: "invalid_arguments",
            message:
              "bearer tokens are not accepted in URL query parameters; submit owner credentials via POST /portal/api/session",
          },
        });
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/portal"
      ) {
        const page = renderControlPortalPage();
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-security-policy", page.contentSecurityPolicy);
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("x-frame-options", "DENY");
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("cross-origin-opener-policy", "same-origin");
        response.setHeader("cross-origin-resource-policy", "same-origin");
        response.end(page.html);
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/pair/start"
      ) {
        await this.#startPairing(request, response);
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/pair/approve"
      ) {
        const identity = await this.#requireIdentity(
          request,
          response,
        );
        if (!identity) return;
        await this.#approvePairing(request, response, identity);
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/devices"
      ) {
        const identity = await this.#requireIdentity(
          request,
          response,
        );
        if (!identity) return;
        writeJson(response, 200, {
          devices: this.#registry.listDevices(identity.accountId),
        });
        return;
      }

      const revoke = /^\/devices\/([^/]+)\/revoke$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && revoke) {
        const identity = await this.#requireIdentity(
          request,
          response,
        );
        if (!identity) return;
        await this.#revokeDevice(
          response,
          identity,
          decodeURIComponent(revoke[1]!),
        );
        return;
      }

      if (url.pathname.startsWith("/portal/api/")) {
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        await this.#handlePortalApi(request, response, url.pathname);
        return;
      }
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      writeJson(response, 400, {
        error: {
          code: "invalid_arguments",
          message:
            error instanceof Error
              ? error.message
              : "invalid relay control request",
        },
      });
    }
  }

  async #handlePortalApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (!this.#policyStore) {
      writeJson(response, 503, {
        error: {
          code: "capability_unavailable",
          message: "policy store is not enabled on this gateway",
        },
      });
      return;
    }

    if (request.method === "GET" && pathname === "/portal/api/session") {
      const session = this.#resolveCookieSession(request);
      if (!session || isNonOwnerPrincipal(session.identity.principalId)) {
        writeJson(response, 200, { authenticated: false });
        return;
      }
      writeJson(response, 200, {
        authenticated: true,
        accountId: session.identity.accountId,
        ownerPrincipalId: session.identity.principalId,
        csrfToken: session.csrfToken,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/portal/api/session") {
      if (!this.#verifySameOriginHeaders(request, false)) {
        writeJson(response, 403, {
          error: {
            code: "permission_denied",
            message: "cross-origin session creation is denied",
          },
        });
        return;
      }
      const identity = await this.#requireOwnerBearerIdentity(request, response);
      if (!identity) return;
      const session = this.#createPortalSession(identity);
      response.setHeader(
        "set-cookie",
        formatSessionCookieHeader(
          session.id,
          PORTAL_SESSION_TTL_SECONDS,
          this.#secureCookies,
        ),
      );
      writeJson(response, 200, {
        authenticated: true,
        accountId: identity.accountId,
        ownerPrincipalId: identity.principalId,
        csrfToken: session.csrfToken,
      });
      return;
    }

    if (
      request.method === "POST" &&
      pathname === "/portal/api/session/logout"
    ) {
      const existingCookie = parseSessionCookieValue(request.headers.cookie);
      if (existingCookie && this.#portalSessions.has(existingCookie)) {
        const identity = await this.#requireOwnerIdentity(request, response);
        if (!identity) return;
        this.#portalSessions.delete(existingCookie);
      }
      response.setHeader(
        "set-cookie",
        formatSessionCookieHeader("", 0, this.#secureCookies),
      );
      writeJson(response, 200, { authenticated: false });
      return;
    }

    const identity = await this.#requireOwnerIdentity(request, response);
    if (!identity) return;

    if (request.method === "GET" && pathname === "/portal/api/overview") {
      const overview = await this.#policyStore.buildPortalOverview(
        identity.accountId,
      );
      writeJson(response, 200, overview);
      return;
    }

    if (request.method === "GET" && pathname === "/portal/api/audit") {
      writeJson(response, 200, {
        auditHistory: this.#policyStore.listAuditEvents(identity.accountId),
      });
      return;
    }

    const devicePolicyMatch = /^\/portal\/api\/devices\/([^/]+)\/policy$/.exec(
      pathname,
    );
    if (request.method === "POST" && devicePolicyMatch) {
      const deviceId = decodeURIComponent(devicePolicyMatch[1]!);
      const binding = this.#registry.getDevice(deviceId);
      if (
        !binding ||
        binding.accountId !== identity.accountId ||
        binding.revokedAt !== null
      ) {
        writeJson(response, 403, {
          error: {
            code: "permission_denied",
            message: "device is not owned by this account",
          },
        });
        return;
      }

      const body = await readObjectBody(request);
      const mutation = parsePolicyMutation(body);
      const record = await this.#policyStore.updateDevicePolicy({
        accountId: identity.accountId,
        actorPrincipalId: identity.principalId,
        deviceId,
        mutation,
      });
      writeJson(response, 200, {
        device: this.#policyStore.formatDeviceOverview(binding, record),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/portal/api/global/apply") {
      const body = await readObjectBody(request);
      if (body.confirm !== true) {
        writeJson(response, 400, {
          error: {
            code: "invalid_arguments",
            message:
              "explicit confirmation (confirm: true) is required for global bulk permission changes",
          },
        });
        return;
      }
      const mutation = parsePolicyMutation(body);
      const deviceIds = optionalStringArray(body, "deviceIds");
      const updated = await this.#policyStore.applyGlobalPolicy({
        accountId: identity.accountId,
        actorPrincipalId: identity.principalId,
        ...(deviceIds ? { deviceIds } : {}),
        mutation,
      });
      writeJson(response, 200, {
        updatedDevices: updated.map((r) => r.policy.device_id),
        count: updated.length,
      });
      return;
    }

    if (
      request.method === "POST" &&
      pathname === "/portal/api/global/emergency-revoke"
    ) {
      const body = await readObjectBody(request);
      if (body.confirm !== true) {
        writeJson(response, 400, {
          error: {
            code: "invalid_arguments",
            message:
              "explicit confirmation (confirm: true) is required for emergency access revocation",
          },
        });
        return;
      }
      const restore = body.restore === true;
      const deviceIds = optionalStringArray(body, "deviceIds");
      const reason =
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : restore
            ? "Emergency access lockdown lifted by owner"
            : "Emergency access revocation triggered by owner";

      const updated = await this.#policyStore.applyGlobalPolicy({
        accountId: identity.accountId,
        actorPrincipalId: identity.principalId,
        ...(deviceIds ? { deviceIds } : {}),
        actionName: restore
          ? "emergency_lockdown_lifted"
          : "emergency_lockdown",
        mutation: restore
          ? {
              emergencyLockdown: false,
              profileId: "universal",
              reason,
            }
          : {
              emergencyLockdown: true,
              profileId: "lockdown",
              reason,
            },
      });
      writeJson(response, 200, {
        emergencyLockdown: !restore,
        updatedDevices: updated.map((r) => r.policy.device_id),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/portal/api/operators") {
      const body = await readObjectBody(request);
      const operatorPrincipalId = stringField(body, "principalId");
      const displayName =
        typeof body.displayName === "string"
          ? body.displayName.trim()
          : operatorPrincipalId;
      const deviceIds = optionalStringArray(body, "deviceIds");
      const mutation = parsePolicyMutation(body);
      const updated = await this.#policyStore.upsertOperatorPolicy({
        accountId: identity.accountId,
        actorPrincipalId: identity.principalId,
        operatorPrincipalId,
        displayName,
        ...(deviceIds ? { deviceIds } : {}),
        mutation,
      });
      writeJson(response, 200, {
        principalId: operatorPrincipalId,
        updatedDevices: updated.map((r) => r.policy.device_id),
      });
      return;
    }

    const deleteOperatorMatch = /^\/portal\/api\/operators\/([^/]+)$/.exec(
      pathname,
    );
    if (request.method === "DELETE" && deleteOperatorMatch) {
      const operatorPrincipalId = decodeURIComponent(deleteOperatorMatch[1]!);
      await this.#policyStore.removeOperatorPolicy({
        accountId: identity.accountId,
        actorPrincipalId: identity.principalId,
        operatorPrincipalId,
      });
      writeJson(response, 200, { removed: operatorPrincipalId });
      return;
    }

    if (request.method === "POST" && pathname === "/portal/api/rollback") {
      const body = await readObjectBody(request);
      const deviceId = stringField(body, "deviceId");
      const targetRevision = Number(body.targetRevision);
      if (!Number.isInteger(targetRevision) || targetRevision < 1) {
        throw new Error("targetRevision must be a positive integer");
      }
      const binding = this.#registry.getDevice(deviceId);
      if (!binding || binding.accountId !== identity.accountId) {
        writeJson(response, 403, {
          error: {
            code: "permission_denied",
            message: "device is not owned by this account",
          },
        });
        return;
      }
      const record = await this.#policyStore.rollbackDevicePolicy({
        accountId: identity.accountId,
        actorPrincipalId: identity.principalId,
        deviceId,
        targetRevision,
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      });
      writeJson(response, 200, {
        device: this.#policyStore.formatDeviceOverview(binding, record),
      });
      return;
    }

    writeJson(response, 404, {
      error: {
        code: "invalid_arguments",
        message: `unknown portal endpoint: ${pathname}`,
      },
    });
  }

  async #startPairing(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readObjectBody(request);
    const deviceId = stringField(body, "deviceId");
    const credentialHash = stringField(
      body,
      "credentialHash",
    );
    const pending = await this.#registry.startPairing({
      deviceId,
      credentialHash,
    });
    writeJson(response, 200, pending);
  }

  async #approvePairing(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ClientIdentity,
  ): Promise<void> {
    const body = await readObjectBody(request);
    const userCode = stringField(body, "userCode");
    const binding = await this.#registry.approvePairing({
      accountId: identity.accountId,
      userCode,
    });
    if (this.#policyStore) {
      await this.#policyStore.ensureDevicePolicy(
        binding,
        identity.principalId,
      );
    }
    writeJson(response, 200, binding);
  }

  async #revokeDevice(
    response: ServerResponse,
    identity: ClientIdentity,
    deviceId: string,
  ): Promise<void> {
    const binding = this.#registry.getDevice(deviceId);
    if (
      !binding ||
      binding.accountId !== identity.accountId
    ) {
      writeJson(response, 403, {
        error: {
          code: "permission_denied",
          message: "device is not owned by this account",
        },
      });
      return;
    }

    const revoked = await this.#registry.revokeDevice({
      accountId: identity.accountId,
      deviceId,
    });
    this.#disconnectDevice(deviceId);
    writeJson(response, 200, revoked);
  }

  async #requireIdentity(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<ClientIdentity | null> {
    const token = bearerToken(request.headers.authorization);
    const identity = token
      ? await this.#authenticator.authenticate(token)
      : null;
    if (identity) return identity;

    response.statusCode = 401;
    response.setHeader("www-authenticate", "Bearer");
    response.end();
    return null;
  }

  async #requireOwnerBearerIdentity(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<ClientIdentity | null> {
    const identity = await this.#requireIdentity(request, response);
    if (!identity) return null;
    if (isNonOwnerPrincipal(identity.principalId)) {
      writeJson(response, 403, {
        error: {
          code: "permission_denied",
          message:
            "only the device owner identity can manage portal permissions",
        },
      });
      return null;
    }
    return identity;
  }

  async #requireOwnerIdentity(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<ClientIdentity | null> {
    const bearer = bearerToken(request.headers.authorization);
    if (bearer) {
      return await this.#requireOwnerBearerIdentity(request, response);
    }

    const session = this.#resolveCookieSession(request);
    if (!session) {
      response.setHeader("www-authenticate", "Bearer");
      writeJson(response, 401, {
        error: {
          code: "unauthorized",
          message: "portal authentication required",
        },
      });
      return null;
    }

    const isMutation =
      request.method !== "GET" && request.method !== "HEAD";
    if (!this.#verifySameOriginHeaders(request, isMutation)) {
      writeJson(response, 403, {
        error: {
          code: "permission_denied",
          message: "cross-origin portal request is denied",
        },
      });
      return null;
    }

    if (isMutation) {
      const csrfHeader = singleStringHeader(request.headers["x-tetherplane-csrf"]);
      if (!csrfHeader || !constantTimeEqual(csrfHeader, session.csrfToken)) {
        writeJson(response, 403, {
          error: {
            code: "permission_denied",
            message: "missing or invalid portal CSRF token",
          },
        });
        return null;
      }
    }

    if (isNonOwnerPrincipal(session.identity.principalId)) {
      writeJson(response, 403, {
        error: {
          code: "permission_denied",
          message:
            "only the device owner identity can manage portal permissions",
        },
      });
      return null;
    }

    return session.identity;
  }

  #createPortalSession(identity: ClientIdentity): PortalSession {
    const now = Date.now();
    for (const [key, existing] of this.#portalSessions) {
      if (existing.expiresAtMs <= now) {
        this.#portalSessions.delete(key);
      }
    }
    while (this.#portalSessions.size >= MAX_PORTAL_SESSIONS) {
      const oldestKey = this.#portalSessions.keys().next().value;
      if (!oldestKey) break;
      this.#portalSessions.delete(oldestKey);
    }
    const id = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const session: PortalSession = {
      id,
      identity: { ...identity },
      csrfToken,
      expiresAtMs: now + PORTAL_SESSION_TTL_SECONDS * 1000,
    };
    this.#portalSessions.set(id, session);
    return session;
  }

  #resolveCookieSession(request: IncomingMessage): PortalSession | null {
    const sessionId = parseSessionCookieValue(request.headers.cookie);
    if (!sessionId) return null;
    const session = this.#portalSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAtMs <= Date.now()) {
      this.#portalSessions.delete(sessionId);
      return null;
    }
    return session;
  }

  #verifySameOriginHeaders(
    request: IncomingMessage,
    requireSafeRefererIfNoOrigin: boolean,
  ): boolean {
    const fetchSite = singleStringHeader(request.headers["sec-fetch-site"]);
    if (fetchSite && fetchSite.toLowerCase() === "cross-site") {
      return false;
    }
    const hostHeader = singleStringHeader(request.headers.host);
    if (!hostHeader) return false;
    const expectedProtocol = this.#secureCookies ? "https:" : "http:";

    const originHeader = singleStringHeader(request.headers.origin);
    if (originHeader) {
      if (originHeader.toLowerCase() === "null") return false;
      try {
        const parsed = new URL(originHeader);
        return (
          parsed.host === hostHeader &&
          parsed.protocol === expectedProtocol
        );
      } catch {
        return false;
      }
    }

    if (requireSafeRefererIfNoOrigin) {
      const refererHeader = singleStringHeader(request.headers.referer);
      if (refererHeader) {
        try {
          const parsed = new URL(refererHeader);
          return (
            parsed.host === hostHeader &&
            parsed.protocol === expectedProtocol
          );
        } catch {
          return false;
        }
      }
    }

    return true;
  }
}

function isNonOwnerPrincipal(principalId: string): boolean {
  return (
    principalId.startsWith("operator:") ||
    principalId.startsWith("external:") ||
    principalId.startsWith("guest:") ||
    principalId.startsWith("unpaired:")
  );
}

function hasQueryTokenParameter(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (
      lower === "token" ||
      lower === "access_token" ||
      lower === "bearer" ||
      lower === "auth" ||
      lower === "authorization"
    ) {
      return true;
    }
  }
  return false;
}

function parseSessionCookieValue(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name === PORTAL_SESSION_COOKIE) {
      const val = part.slice(idx + 1).trim();
      return val || null;
    }
  }
  return null;
}

function formatSessionCookieHeader(
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attrs = [
    `${PORTAL_SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/portal",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

function singleStringHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parsePolicyMutation(
  body: Record<string, unknown>,
): PolicyMutationInput {
  const validProfiles = new Set<PermissionProfileId>([
    "universal",
    "standard",
    "read_only",
    "files_and_process",
    "lockdown",
    "custom",
  ]);
  const profileId =
    typeof body.profileId === "string" &&
    validProfiles.has(body.profileId as PermissionProfileId)
      ? (body.profileId as PermissionProfileId)
      : undefined;

  const allowedFamilies = parseToolFamilies(body, "allowedFamilies");
  const deniedFamilies = parseToolFamilies(body, "deniedFamilies");
  const grantFamilies = parseToolFamilies(body, "grantFamilies");
  const revokeFamilies = parseToolFamilies(body, "revokeFamilies");
  const allowedCapabilities = optionalStringArray(body, "allowedCapabilities");
  const deniedCapabilities = optionalStringArray(body, "deniedCapabilities");
  const grantCapabilities = optionalStringArray(body, "grantCapabilities");
  const revokeCapabilities = optionalStringArray(body, "revokeCapabilities");
  const allowedRoots = optionalStringArray(body, "allowedRoots");

  return {
    ...(profileId ? { profileId } : {}),
    ...(typeof body.universalPermissions === "boolean"
      ? { universalPermissions: body.universalPermissions }
      : {}),
    ...(allowedFamilies ? { allowedFamilies } : {}),
    ...(deniedFamilies ? { deniedFamilies } : {}),
    ...(grantFamilies ? { grantFamilies } : {}),
    ...(revokeFamilies ? { revokeFamilies } : {}),
    ...(allowedCapabilities ? { allowedCapabilities } : {}),
    ...(deniedCapabilities ? { deniedCapabilities } : {}),
    ...(grantCapabilities ? { grantCapabilities } : {}),
    ...(revokeCapabilities ? { revokeCapabilities } : {}),
    ...(allowedRoots ? { allowedRoots } : {}),
    ...(typeof body.allowDestructive === "boolean"
      ? { allowDestructive: body.allowDestructive }
      : {}),
    ...(typeof body.emergencyLockdown === "boolean"
      ? { emergencyLockdown: body.emergencyLockdown }
      : {}),
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
  };
}

function parseToolFamilies(
  body: Record<string, unknown>,
  field: string,
): ToolFamily[] | undefined {
  const raw = optionalStringArray(body, field);
  if (!raw) return undefined;
  const valid = new Set<string>(ALL_TOOL_FAMILIES);
  for (const item of raw) {
    if (!valid.has(item)) {
      throw new Error(`invalid tool family '${item}' in ${field}`);
    }
  }
  return raw as ToolFamily[];
}

function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${field} must contain non-empty strings`);
    }
    return item.trim();
  });
}

async function readObjectBody(
  request: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error("request body exceeds relay control limit");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function stringField(
  body: Record<string, unknown>,
  name: string,
): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
