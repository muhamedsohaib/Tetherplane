import { randomUUID } from "node:crypto";
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

import { createCompactMcpServer } from "@tetherplane/compact-mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type {
  ClientAuthenticator,
  ClientIdentity,
} from "../auth/static-auth.ts";
import type { DeviceRouter } from "../routing/device-router.ts";

type McpSession = {
  identity: ClientIdentity;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createCompactMcpServer>;
};

export class RemoteMcpHttpGateway {
  readonly #router: DeviceRouter;
  readonly #authenticator: ClientAuthenticator;
  readonly #sessions = new Map<string, McpSession>();
  #attachedServer: Server | null = null;
  #requestHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null;

  constructor(options: {
    router: DeviceRouter;
    authenticator: ClientAuthenticator;
  }) {
    this.#router = options.router;
    this.#authenticator = options.authenticator;
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
    if (url.pathname !== pathname) {
      return;
    }

    const identity = await this.#authenticate(request);
    if (!identity) {
      response.statusCode = 401;
      response.setHeader("www-authenticate", "Bearer");
      response.end();
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
    identity: ClientIdentity,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const sessionId = singleHeader(
      request.headers["mcp-session-id"],
    );

    if (sessionId) {
      const session = this.#sessions.get(sessionId);
      if (!session) {
        writeJson(response, 404, mcpSessionError("Unknown MCP session"));
        return;
      }
      if (!sameIdentity(session.identity, identity)) {
        writeJson(response, 403, mcpSessionError("MCP session identity mismatch"));
        return;
      }
      await session.transport.handleRequest(request, response, body);
      return;
    }

    if (!isInitializeRequest(body)) {
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
      agentClient: {
        call: (invocation) => this.#router.call(identity, invocation),
      },
    });
    session = {
      identity: { ...identity },
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

  async #handleExistingSession(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ClientIdentity,
  ): Promise<void> {
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
    if (!sameIdentity(session.identity, identity)) {
      writeJson(response, 403, mcpSessionError("MCP session identity mismatch"));
      return;
    }
    await session.transport.handleRequest(request, response);
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
