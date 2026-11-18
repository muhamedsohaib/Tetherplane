import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

import {
  isAuthorizedOwnerIdentity,
  type ClientAuthenticator,
  type ClientIdentity,
} from "../auth/static-auth.ts";
import { validatePublicOrigin } from "../cli-config.ts";
import {
  ALL_TOOL_FAMILIES,
  assertCanonicalCapabilities,
  type PermissionProfileId,
  type PolicyMutationInput,
  type PolicyStore,
  type ToolFamily,
} from "../policy/policy-store.ts";
import { renderControlPortalPage } from "../portal/portal-ui.ts";
import { PairingCapacityError, type DeviceRegistry } from "./registry.ts";

const PORTAL_SESSION_COOKIE = "tetherplane_portal_session";
const PORTAL_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_PORTAL_SESSIONS = 256;

export type EndpointRateLimit = {
  maxRequests: number;
  windowMs: number;
};

export type RelayRateLimitConfig = {
  pairStart?: EndpointRateLimit;
  pairApprove?: EndpointRateLimit;
  portalSession?: EndpointRateLimit;
};

const DEFAULT_PAIR_START_RATE_LIMIT: EndpointRateLimit = {
  maxRequests: 30,
  windowMs: 60_000,
};

const DEFAULT_PAIR_APPROVE_RATE_LIMIT: EndpointRateLimit = {
  maxRequests: 30,
  windowMs: 60_000,
};

const DEFAULT_PORTAL_SESSION_RATE_LIMIT: EndpointRateLimit = {
  maxRequests: 60,
  windowMs: 60_000,
};

type PortalSession = {
  id: string;
  identity: ClientIdentity;
  csrfToken: string;
  expiresAtMs: number;
};

type SseClient = {
  sessionId: string | null;
  cleanup(): void;
};

export class RelayControlHttpGateway {
  readonly #registry: DeviceRegistry;
  readonly #authenticator: ClientAuthenticator;
  readonly #disconnectDevice: (deviceId: string) => void;
  readonly #policyStore: PolicyStore | null;
  readonly #secureCookies: boolean;
  readonly #publicOriginUrl: URL | null;
  readonly #trustProxyHeaders: boolean;
  readonly #pairStartLimiter: SlidingWindowRateLimiter;
  readonly #pairApproveIpLimiter: SlidingWindowRateLimiter;
  readonly #pairApproveAccountLimiter: SlidingWindowRateLimiter;
  readonly #portalSessionLimiter: SlidingWindowRateLimiter;
  readonly #portalSessions = new Map<string, PortalSession>();
  readonly #sseClients = new Set<SseClient>();
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
    publicOrigin?: string;
    trustProxyHeaders?: boolean;
    rateLimits?: RelayRateLimitConfig;
  }) {
    const normalizedPublicOrigin =
      options.publicOrigin === undefined
        ? null
        : validatePublicOrigin(options.publicOrigin);
    const trustProxyHeaders = options.trustProxyHeaders ?? false;
    if (trustProxyHeaders && !normalizedPublicOrigin) {
      throw new Error("trustProxyHeaders requires explicit publicOrigin");
    }
    this.#registry = options.registry;
    this.#authenticator = options.authenticator;
    this.#disconnectDevice = options.disconnectDevice;
    this.#policyStore = options.policyStore ?? null;
    this.#publicOriginUrl = normalizedPublicOrigin
      ? new URL(normalizedPublicOrigin)
      : null;
    this.#trustProxyHeaders = trustProxyHeaders;
    this.#secureCookies =
      options.secureCookies ??
      (this.#publicOriginUrl?.protocol === "https:");

    const pairStartRule =
      options.rateLimits?.pairStart ?? DEFAULT_PAIR_START_RATE_LIMIT;
    const pairApproveRule =
      options.rateLimits?.pairApprove ?? DEFAULT_PAIR_APPROVE_RATE_LIMIT;
    const portalSessionRule =
      options.rateLimits?.portalSession ?? DEFAULT_PORTAL_SESSION_RATE_LIMIT;
    this.#pairStartLimiter = new SlidingWindowRateLimiter(pairStartRule);
    this.#pairApproveIpLimiter = new SlidingWindowRateLimiter(pairApproveRule);
    this.#pairApproveAccountLimiter = new SlidingWindowRateLimiter(
      pairApproveRule,
    );
    this.#portalSessionLimiter = new SlidingWindowRateLimiter(
      portalSessionRule,
    );
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
    for (const client of [...this.#sseClients]) {
      client.cleanup();
    }
    this.#sseClients.clear();
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
        const limit = this.#pairStartLimiter.consume(
          `ip:${clientIpKey(request)}`,
        );
        if (!limit.allowed) {
          writeRateLimited(
            response,
            limit.retryAfterSeconds,
            "too many pairing start requests; retry later",
          );
          return;
        }
        await this.#startPairing(request, response);
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/pair/approve"
      ) {
        const ipLimit = this.#pairApproveIpLimiter.consume(
          `ip:${clientIpKey(request)}`,
        );
        if (!ipLimit.allowed) {
          writeRateLimited(
            response,
            ipLimit.retryAfterSeconds,
            "too many pairing approval attempts; retry later",
          );
          return;
        }
        const identity = await this.#requireOwnerBearerIdentity(
          request,
          response,
        );
        if (!identity) return;
        const accountLimit = this.#pairApproveAccountLimiter.consume(
          `account:${identity.accountId}`,
        );
        if (!accountLimit.allowed) {
          writeRateLimited(
            response,
            accountLimit.retryAfterSeconds,
            "too many pairing approval attempts for account; retry later",
          );
          return;
        }
        await this.#approvePairing(request, response, identity);
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/devices"
      ) {
        const identity = await this.#requireOwnerBearerIdentity(
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
        const identity = await this.#requireOwnerBearerIdentity(
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
      if (!session || !isAuthorizedOwnerIdentity(session.identity)) {
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
      const limit = this.#portalSessionLimiter.consume(
        `ip:${clientIpKey(request)}`,
      );
      if (!limit.allowed) {
        writeRateLimited(
          response,
          limit.retryAfterSeconds,
          "too many portal authentication attempts; retry later",
        );
        return;
      }
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
        for (const client of [...this.#sseClients]) {
          if (client.sessionId === existingCookie) {
            client.cleanup();
          }
        }
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

    if (request.method === "GET" && pathname === "/portal/api/events") {
      this.#handleSseSubscription(request, response, identity.accountId);
      return;
    }

    if (request.method === "GET" && pathname === "/portal/api/overview") {
      const overview = await this.#policyStore.buildPortalOverview(
        identity.accountId,
        identity.principalId,
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

  #handleSseSubscription(
    request: IncomingMessage,
    response: ServerResponse,
    accountId: string,
  ): void {
    if (!this.#policyStore) {
      writeJson(response, 503, {
        error: {
          code: "capability_unavailable",
          message: "policy store is not enabled on this gateway",
        },
      });
      return;
    }

    const sessionId = bearerToken(request.headers.authorization)
      ? null
      : parseSessionCookieValue(request.headers.cookie);

    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();

    let closed = false;
    let coalesceTimer: NodeJS.Timeout | null = null;
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let unsubscribe = () => {};

    const clientEntry: SseClient = {
      sessionId,
      cleanup: () => {
        if (closed) return;
        closed = true;
        if (coalesceTimer) {
          clearTimeout(coalesceTimer);
          coalesceTimer = null;
        }
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        unsubscribe();
        this.#sseClients.delete(clientEntry);
        try {
          if (!response.writableEnded) response.end();
          if (response.socket && !response.socket.destroyed) {
            response.socket.destroy();
          }
        } catch {
          // Ignore teardown errors
        }
      },
    };

    const sessionStillValid = (): boolean => {
      if (!sessionId) return true;
      const existing = this.#portalSessions.get(sessionId);
      if (!existing || existing.expiresAtMs <= Date.now()) {
        if (existing) this.#portalSessions.delete(sessionId);
        return false;
      }
      return true;
    };

    const scheduleOverviewPush = () => {
      if (closed || coalesceTimer) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        if (closed || response.writableEnded) return;
        if (!sessionStillValid()) {
          try {
            response.write("event: session_expired\ndata: {}\n\n");
          } catch {
            // ignore
          }
          clientEntry.cleanup();
          return;
        }
        try {
          response.write(
            `event: overview\ndata: ${JSON.stringify({ updatedAtMs: Date.now() })}\n\n`,
          );
        } catch {
          clientEntry.cleanup();
        }
      }, 20);
      coalesceTimer.unref?.();
    };

    unsubscribe = this.#policyStore.subscribe(accountId, scheduleOverviewPush);
    keepaliveTimer = setInterval(() => {
      if (closed || response.writableEnded) return;
      if (!sessionStillValid()) {
        clientEntry.cleanup();
        return;
      }
      try {
        response.write(": keepalive\n\n");
      } catch {
        clientEntry.cleanup();
      }
    }, 25_000);
    keepaliveTimer.unref?.();

    this.#sseClients.add(clientEntry);
    request.once("close", clientEntry.cleanup);
    response.once("close", clientEntry.cleanup);

    try {
      response.write(`event: ready\ndata: ${JSON.stringify({ type: "ready" })}\n\n`);
    } catch {
      clientEntry.cleanup();
    }
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
    try {
      const pending = await this.#registry.startPairing({
        deviceId,
        credentialHash,
      });
      writeJson(response, 200, pending);
    } catch (error) {
      if (error instanceof PairingCapacityError) {
        writeRateLimited(response, 30, error.message);
        return;
      }
      throw error;
    }
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
      await this.#policyStore.ensureDevicePolicy(binding, identity);
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
    this.#policyStore?.notifyChange(identity.accountId);
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
    if (!isAuthorizedOwnerIdentity(identity)) {
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

    if (!isAuthorizedOwnerIdentity(session.identity)) {
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
    requireExplicitOrigin: boolean,
  ): boolean {
    const fetchSite = singleStringHeader(request.headers["sec-fetch-site"]);
    if (fetchSite && fetchSite.toLowerCase() === "cross-site") {
      return false;
    }

    let expectedOrigin: string;
    if (this.#publicOriginUrl) {
      if (this.#trustProxyHeaders) {
        const expectedProto = this.#publicOriginUrl.protocol.slice(0, -1);
        const forwardedProto = firstForwardedHeaderValue(
          request.headers["x-forwarded-proto"],
        )?.toLowerCase();
        if (forwardedProto !== undefined && forwardedProto !== expectedProto) {
          return false;
        }
        const forwardedHost = firstForwardedHeaderValue(
          request.headers["x-forwarded-host"],
        )?.toLowerCase();
        if (
          forwardedHost !== undefined &&
          forwardedHost !== this.#publicOriginUrl.host.toLowerCase()
        ) {
          return false;
        }
      }
      expectedOrigin = this.#publicOriginUrl.origin;
    } else {
      const hostHeader = singleStringHeader(request.headers.host);
      if (!hostHeader) return false;
      const expectedProtocol = this.#secureCookies ? "https:" : "http:";
      expectedOrigin = `${expectedProtocol}//${hostHeader}`;
    }

    const originHeader = singleStringHeader(request.headers.origin);
    if (originHeader) {
      if (originHeader.toLowerCase() === "null") return false;
      try {
        const parsed = new URL(originHeader);
        return parsed.origin === expectedOrigin;
      } catch {
        return false;
      }
    }

    const refererHeader = singleStringHeader(request.headers.referer);
    if (refererHeader) {
      try {
        const parsed = new URL(refererHeader);
        return parsed.origin === expectedOrigin;
      } catch {
        return false;
      }
    }

    return !requireExplicitOrigin;
  }
}

function firstForwardedHeaderValue(
  value: string | string[] | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value.join(",") : value;
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 1) {
    return null;
  }
  return parts[0]!;
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
  if (allowedCapabilities) {
    assertCanonicalCapabilities(allowedCapabilities, "allowedCapabilities");
  }
  if (deniedCapabilities) {
    assertCanonicalCapabilities(deniedCapabilities, "deniedCapabilities");
  }
  if (grantCapabilities) {
    assertCanonicalCapabilities(grantCapabilities, "grantCapabilities");
  }
  if (revokeCapabilities) {
    assertCanonicalCapabilities(revokeCapabilities, "revokeCapabilities");
  }
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

const MAX_RATE_LIMIT_KEYS = 2048;

class SlidingWindowRateLimiter {
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #buckets = new Map<string, number[]>();

  constructor(rule: EndpointRateLimit) {
    if (!Number.isSafeInteger(rule.maxRequests) || rule.maxRequests < 1) {
      throw new Error("rate limit maxRequests must be a positive integer");
    }
    if (!Number.isSafeInteger(rule.windowMs) || rule.windowMs < 1) {
      throw new Error("rate limit windowMs must be a positive integer");
    }
    this.#maxRequests = rule.maxRequests;
    this.#windowMs = rule.windowMs;
  }

  consume(
    key: string,
    now = Date.now(),
  ): { allowed: boolean; retryAfterSeconds: number } {
    const cutoff = now - this.#windowMs;
    const existing = this.#buckets.get(key);
    if (existing) {
      while (existing.length > 0 && existing[0]! <= cutoff) {
        existing.shift();
      }
      if (existing.length >= this.#maxRequests) {
        const oldest = existing[0]!;
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((oldest + this.#windowMs - now) / 1000),
        );
        return { allowed: false, retryAfterSeconds };
      }
      existing.push(now);
      this.#buckets.delete(key);
      this.#buckets.set(key, existing);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (this.#buckets.size >= MAX_RATE_LIMIT_KEYS) {
      for (const [entryKey, timestamps] of this.#buckets) {
        while (timestamps.length > 0 && timestamps[0]! <= cutoff) {
          timestamps.shift();
        }
        if (timestamps.length === 0) {
          this.#buckets.delete(entryKey);
        }
      }
      if (this.#buckets.size >= MAX_RATE_LIMIT_KEYS) {
        const oldestKey = this.#buckets.keys().next().value;
        if (oldestKey !== undefined) {
          this.#buckets.delete(oldestKey);
        }
      }
    }

    this.#buckets.set(key, [now]);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function clientIpKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function writeRateLimited(
  response: ServerResponse,
  retryAfterSeconds: number,
  message: string,
): void {
  response.setHeader("retry-after", String(Math.max(1, retryAfterSeconds)));
  writeJson(response, 429, {
    error: {
      code: "rate_limited",
      message,
    },
  });
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
