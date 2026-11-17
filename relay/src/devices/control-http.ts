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
import { renderControlPortalHtml } from "../portal/portal-ui.ts";
import type { DeviceRegistry } from "./registry.ts";

export class RelayControlHttpGateway {
  readonly #registry: DeviceRegistry;
  readonly #authenticator: ClientAuthenticator;
  readonly #disconnectDevice: (deviceId: string) => void;
  readonly #policyStore: PolicyStore | null;
  #attachedServer: Server | null = null;
  #requestHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null;

  constructor(options: {
    registry: DeviceRegistry;
    authenticator: ClientAuthenticator;
    disconnectDevice(deviceId: string): void;
    policyStore?: PolicyStore;
  }) {
    this.#registry = options.registry;
    this.#authenticator = options.authenticator;
    this.#disconnectDevice = options.disconnectDevice;
    this.#policyStore = options.policyStore ?? null;
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
        request.method === "GET" &&
        url.pathname === "/portal"
      ) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(renderControlPortalHtml());
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

  async #requireOwnerIdentity(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<ClientIdentity | null> {
    const identity = await this.#requireIdentity(request, response);
    if (!identity) return null;
    if (
      identity.principalId.startsWith("operator:") ||
      identity.principalId.startsWith("external:") ||
      identity.principalId.startsWith("guest:") ||
      identity.principalId.startsWith("unpaired:")
    ) {
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
