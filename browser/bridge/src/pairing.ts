import http from "node:http";

export type ExtensionPairingBroker = {
  readonly url: string;
  close(): Promise<void>;
};

export async function startExtensionPairingBroker(options: {
  launchToken: string;
  bridgeUrl: string;
  port?: number;
  expectedExtensionId?: string;
  onPaired?: (extensionId: string) => void | Promise<void>;
}): Promise<ExtensionPairingBroker> {
  const launchToken = options.launchToken.trim();
  if (!launchToken) {
    throw new Error("pairing launch token must be non-empty");
  }

  const bridgeUrl = validateBridgeUrl(options.bridgeUrl);
  const expectedExtensionId =
    options.expectedExtensionId === undefined
      ? undefined
      : validateExtensionId(options.expectedExtensionId);

  let consumed = false;

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
      }
      response.end(JSON.stringify({ error: "pairing_failed" }));
    });
  });

  async function handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const origin = request.headers.origin ?? "";
    const originExtensionId = extensionIdFromOrigin(origin);

    if (request.method === "OPTIONS") {
      if (!originExtensionId) {
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      setCors(response, origin);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST" || request.url !== "/pair") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    if (!originExtensionId) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }

    if (
      expectedExtensionId !== undefined &&
      originExtensionId !== expectedExtensionId
    ) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }

    if (consumed) {
      setCors(response, origin);
      sendJson(response, 410, { error: "pairing_consumed" });
      return;
    }

    const body = await readJsonBody(request);
    const extensionId =
      typeof body.extension_id === "string"
        ? body.extension_id
        : "";

    if (extensionId !== originExtensionId) {
      setCors(response, origin);
      sendJson(response, 403, { error: "forbidden" });
      return;
    }

    consumed = true;
    await options.onPaired?.(extensionId);

    setCors(response, origin);
    sendJson(response, 200, {
      bridge_url: bridgeUrl,
      launch_token: launchToken,
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("pairing broker did not bind a TCP address");
  }

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

function setCors(
  response: http.ServerResponse,
  origin: string,
): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader(
    "access-control-allow-headers",
    "content-type",
  );
  response.setHeader(
    "access-control-allow-methods",
    "POST, OPTIONS",
  );
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.statusCode = status;
  response.setHeader(
    "content-type",
    "application/json; charset=utf-8",
  );
  response.end(JSON.stringify(body));
}

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) {
      throw new Error("pairing request body is too large");
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }

  const parsed = JSON.parse(text) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("pairing request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function validateBridgeUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "ws:" ||
    !isLoopbackHost(parsed.hostname)
  ) {
    throw new Error(
      "pairing bridge URL must use ws:// loopback",
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function extensionIdFromOrigin(
  origin: string,
): string | null {
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(
    origin,
  );
  return match?.[1] ?? null;
}

function validateExtensionId(value: string): string {
  if (!/^[a-p]{32}$/.test(value)) {
    throw new Error("extension ID is invalid");
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}
