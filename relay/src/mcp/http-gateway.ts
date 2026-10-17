import { oauthChallenge, resourceMetadataUrl, validateOAuthResource, type OAuthResource } from "../auth/oauth-resource.ts";
import { randomUUID } from "node:crypto";
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

import { createCompactMcpServer } from "@tetherplane/compact-mcp";
import { markClaimed } from "../http-claim.ts";
import type { AccessLog } from "../access-log.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type {
  ClientAuthenticator,
  ClientIdentity,
} from "../auth/static-auth.ts";
import type { DeviceRouter } from "../routing/device-router.ts";

type McpSession = {
  identity: ClientIdentity | null;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createCompactMcpServer>;
};

export class RemoteMcpHttpGateway {
  readonly #router: DeviceRouter;
  readonly #oauth: OAuthResource | undefined;
  readonly #authenticator: ClientAuthenticator;
  readonly #accessLog: AccessLog | undefined;
  readonly #sessions = new Map<string, McpSession>();
  #attachedServer: Server | null = null;
  #requestHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null;

  constructor(options: {
    router: DeviceRouter;
    authenticator: ClientAuthenticator;
    oauth?: OAuthResource;
    accessLog?: AccessLog;
  }) {
    this.#oauth = options.oauth ? validateOAuthResource(options.oauth) : undefined;
    this.#router = options.router;
    this.#authenticator = options.authenticator;
    this.#accessLog = options.accessLog;
  }

  attach(server: Server, pathname = "/mcp"): void {
    if (this.#attachedServer) {
      throw new Error("remote MCP HTTP gateway is already attached");
    }
    this.#attachedServer = server;
    this.#requestHandler = (request, response) => {
      void this.#handleRequest(request, response, pathname);
    };
    server.on("request", this.#requestHandler);
  }

  async close(): Promise<void> {
    if (this.#attachedServer && this.#requestHandler) {
      this.#attachedServer.off("request", this.#requestHandler);
    }
    this.#attachedServer = null;
    this.#requestHandler = null;

    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        await session.transport.close().catch(() => undefined);
        await session.server.close().catch(() => undefined);
      }),
    );
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    if (this.#oauth && ["/.well-known/oauth-protected-resource", new URL(resourceMetadataUrl(this.#oauth)).pathname].includes(url.pathname)) {
      markClaimed(response);
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" }).end();
      } else {
        writeJson(response, 200, { resource: this.#oauth.resource, authorization_servers: [this.#oauth.issuer], scopes_supported: this.#oauth.scopes, bearer_methods_supported: ["header"] });
      }
      return;
    }
    if (url.pathname !== pathname) {
      return;
    }
    markClaimed(response);

    const identity = await this.#authenticate(request).catch(() => null);
    // OAuth discovery must work even when the client sends stale credentials.
    // POST dispatch below limits unauthenticated sessions to discovery methods.
    const anonymousDiscovery = this.#oauth && request.method === "POST";
    if (!identity && !anonymousDiscovery) {
      this.#rejectAuthentication(response);
      return;
    }

    try {
      switch (request.method) {
        case "POST":
          await this.#handlePost(request, response, identity);
          return;
        case "GET":
        case "DELETE":
          await this.#handleExistingSession(
            request,
            response,
            identity,
          );
          return;
        default:
          response.statusCode = 405;
          response.setHeader("allow", "GET, POST, DELETE");
          response.end();
      }
    } catch {
      if (!response.headersSent) {
        writeJson(response, 500, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: "Internal server error",
          },
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  }

  async #handlePost(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ClientIdentity | null,
  ): Promise<void> {
    const body = await readJsonBody(request);
    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "method" in body
    ) {
      this.#accessLog?.noteMcpMethod(response, body.method);
    }
    const sessionId = singleHeader(
      request.headers["mcp-session-id"],
    );
    const approval = approvePairingCall(body);
    if (approval) {
      markClaimed(response);
      await this.#handleApprovePairing(
        response,
        identity,
        sessionId,
        approval,
      );
      return;
    }

    if (sessionId) {
      const session = this.#sessions.get(sessionId);
      if (!session) {
        writeJson(response, 404, mcpSessionError("Unknown MCP session"));
        return;
      }
      if (!identity) {
        // Block tools/call before the compact server, including local schema lookup.
        if (session.identity || !isDiscoveryRequest(body)) {
          this.#rejectAuthentication(response, body);
          return;
        }
      } else if (session.identity && !sameIdentity(session.identity, identity)) {
        writeJson(response, 403, mcpSessionError("MCP session identity mismatch"));
        return;
      } else {
        // Bind once, synchronously before dispatch; never replace a bound identity.
        session.identity ??= { ...identity };
      }
      await session.transport.handleRequest(request, response, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      if (!identity) {
        this.#rejectAuthentication(response, body);
        return;
      }
      writeJson(
        response,
        400,
        mcpSessionError("Initialize request required for a new MCP session"),
      );
      return;
    }

    let session!: McpSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        this.#sessions.set(newSessionId, session);
      },
      onsessionclosed: (closedSessionId) => {
        this.#sessions.delete(closedSessionId);
      },
    });
    const compactServer = createCompactMcpServer({
      ...(this.#oauth ? { oauthScopes: this.#oauth.scopes } : {}),
      agentClient: {
        call: async (invocation) => {
          if (!session.identity) throw new Error("Authentication required");
          return this.#router.call(session.identity, invocation);
        },
      },
    });
    session = {
      identity: identity ? { ...identity } : null,
      transport,
      server: compactServer,
    };

    transport.onclose = () => {
      const currentId = transport.sessionId;
      if (currentId) this.#sessions.delete(currentId);
    };

    await compactServer.connect(transport as never);
    await transport.handleRequest(request, response, body);
  }

  async #handleApprovePairing(
    response: ServerResponse,
    identity: ClientIdentity | null,
    sessionId: string | null,
    approval: { id: unknown; userCode: unknown; expectedDeviceId: unknown; malformed: boolean },
  ): Promise<void> {
    const id =
      typeof approval.id === "string" || typeof approval.id === "number"
        ? approval.id
        : null;
    if (sessionId) {
      const session = this.#sessions.get(sessionId);
      if (!session) {
        writeJson(response, 404, mcpSessionError("Unknown MCP session"));
        return;
      }
      if (!identity) {
        this.#rejectAuthentication(
          response,
          approvalBody(id, approval),
        );
        return;
      }
      if (
        session.identity && !sameIdentity(session.identity, identity)
      ) {
        writeJson(
          response,
          403,
          mcpSessionError("MCP session identity mismatch"),
        );
        return;
      }
      session.identity ??= { ...identity };
    } else if (!identity) {
      this.#rejectAuthentication(
        response,
        approvalBody(id, approval),
      );
      return;
    }
    if (
      approval.malformed ||
      typeof approval.userCode !== "string" ||
      !approval.userCode.trim() ||
      typeof approval.expectedDeviceId !== "string" ||
      !approval.expectedDeviceId.trim()
    ) {
      writeJson(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: "approve_pairing requires a non-empty userCode and expectedDeviceId",
            },
          ],
        },
      });
      return;
    }
    const bound = identity;
    if (!bound) {
      this.#rejectAuthentication(
        response,
        approvalBody(id, approval),
      );
      return;
    }
    try {
      // Identity and account come exclusively from the validated session
      // bearer. Arguments can never override them.
      const binding = await this.#router.approveDevicePairing({
        accountId: bound.accountId,
        userCode: approval.userCode.trim(),
        expectedDeviceId: approval.expectedDeviceId.trim(),
      });
      writeJson(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `Paired device ${binding.deviceId}`,
            },
          ],
          structuredContent: {
            paired: true,
            device_id: binding.deviceId,
            account_id: binding.accountId,
          },
        },
      });
    } catch (error) {
      writeJson(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "pairing approval failed",
            },
          ],
        },
      });
    }
  }

  async #handleExistingSession(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ClientIdentity | null,
  ): Promise<void> {
    if (!identity) {
      this.#rejectAuthentication(response);
      return;
    }
    const sessionId = singleHeader(
      request.headers["mcp-session-id"],
    );
    if (!sessionId) {
      writeJson(response, 400, mcpSessionError("Missing MCP session ID"));
      return;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      writeJson(response, 404, mcpSessionError("Unknown MCP session"));
      return;
    }
    if (session.identity && !sameIdentity(session.identity, identity)) {
      writeJson(response, 403, mcpSessionError("MCP session identity mismatch"));
      return;
    }
    session.identity ??= { ...identity };
    await session.transport.handleRequest(request, response);
  }

  #rejectAuthentication(response: ServerResponse, body?: unknown): void {
    const challenge = this.#oauth ? oauthChallenge(this.#oauth) : "Bearer";
    response.setHeader("www-authenticate", challenge);
    if (this.#oauth && body && typeof body === "object" && !Array.isArray(body) &&
      "method" in body && body.method === "tools/call" && "id" in body &&
      (typeof body.id === "string" || typeof body.id === "number")) {
      writeJson(response, 200, {
        jsonrpc: "2.0", id: body.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "Authentication required" }],
          _meta: { "mcp/www_authenticate": [challenge + ', error="invalid_token", error_description="Authentication required"'] },
        },
      });
      return;
    }
    response.writeHead(401).end();
  }

  async #authenticate(
    request: IncomingMessage,
  ): Promise<ClientIdentity | null> {
    const token = bearerToken(request.headers.authorization);
    return token
      ? this.#authenticator.authenticate(token)
      : null;
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error("MCP request body exceeds relay limit");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isDiscoveryRequest(body: unknown): boolean {
  return !!body && typeof body === "object" && !Array.isArray(body) &&
    "method" in body && typeof body.method === "string" &&
    ["tools/list", "notifications/initialized", "ping"].includes(body.method);
}

function approvePairingCall(body: unknown): {
  id: unknown;
  userCode: unknown;
  expectedDeviceId: unknown;
  malformed: boolean;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!("method" in body) || body.method !== "tools/call") return null;
  if (!("params" in body) || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
    return null;
  }
  const params = body.params as Record<string, unknown>;
  if (params.name !== "device") return null;
  if (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments)) {
    return null;
  }
  // The installed device tool schema exposes only op, args, device,
  // response_mode and friends. Pairing values live inside args; account and
  // principal overrides are never honored from any envelope level.
  const outer = params.arguments as Record<string, unknown>;
  if (outer.op !== "approve_pairing") return null;
  const id = "id" in body ? (body as Record<string, unknown>).id : null;
  if (!outer.args || typeof outer.args !== "object" || Array.isArray(outer.args)) {
    // Recognized outer op with malformed args: fail locally instead of
    // falling through to physical-device routing.
    return { id, userCode: undefined, expectedDeviceId: undefined, malformed: true };
  }
  const args = outer.args as Record<string, unknown>;
  return {
    id,
    userCode: args.userCode,
    expectedDeviceId: args.expectedDeviceId,
    malformed: false,
  };
}

function approvalBody(
  id: unknown,
  approval: { userCode: unknown; expectedDeviceId: unknown },
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "device",
      arguments: { op: "approve_pairing" },
    },
  };
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function singleHeader(
  value: string | string[] | undefined,
): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function sameIdentity(
  left: ClientIdentity,
  right: ClientIdentity,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.clientId === right.clientId &&
    left.principalId === right.principalId
  );
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

function mcpSessionError(message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32000,
      message,
    },
  };
}
