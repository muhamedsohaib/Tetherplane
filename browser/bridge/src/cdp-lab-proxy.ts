import http from "node:http";
import type { Duplex } from "node:stream";

/**
 * Disposable CDP Browser Lab HTTP proxy.
 *
 * Only a single exact IPv4 loopback fixture origin may receive HTTP traffic.
 * All CONNECT and Upgrade requests (including WebSockets) are denied.
 * No fallback proxy/direct route is provided to Chromium.
 *
 * This is not a production proxy for signed-in sessions or public websites.
 */
export type CdpLabProxy = {
  readonly port: number;
  snapshot(): {
    forwardedHttp: number;
    deniedHttp: number;
    deniedConnect: number;
    deniedUpgrade: number;
    deniedRevoked: number;
  };
  close(): Promise<void>;
};

export async function startCdpLabProxy(input: {
  approvedOrigin: string;
  // Trusted local-only grant evaluation; never accepted from browser RPC.
  canForward: () => boolean;
}): Promise<CdpLabProxy> {
  if (typeof input.canForward !== "function") {
    throw new TypeError("CDP lab proxy requires a live local grant predicate");
  }
  let origin: URL;
  try {
    origin = new URL(input.approvedOrigin);
  } catch {
    throw new TypeError("CDP proxy requires an exact loopback test origin");
  }
  if (
    origin.origin !== input.approvedOrigin ||
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port ||
    origin.username ||
    origin.password
  ) {
    throw new TypeError("CDP proxy accepts only an exact 127.0.0.1 test origin");
  }

  let forwardedHttp = 0;
  let deniedHttp = 0;
  let deniedConnect = 0;
  let deniedUpgrade = 0;
  let deniedRevoked = 0;

  const server = http.createServer((request, response) => {
    if (!input.canForward()) {
      deniedRevoked += 1;
      response.writeHead(403).end();
      return;
    }
    let destination: URL;
    try {
      destination = new URL(request.url ?? "");
    } catch {
      deniedHttp += 1;
      response.writeHead(403).end();
      return;
    }

    if (
      destination.origin !== origin.origin ||
      destination.username ||
      destination.password ||
      !["GET", "HEAD", "POST"].includes(request.method ?? "")
    ) {
      deniedHttp += 1;
      response.writeHead(403).end();
      return;
    }

    forwardedHttp += 1;
    const headers: http.OutgoingHttpHeaders = { ...request.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    delete headers.authorization;
    delete headers.cookie;
    delete headers.host;
    delete headers.connection;
    headers.host = origin.host;
    headers.connection = "close";

    const upstream = http.request(
      destination,
      { method: request.method, headers, timeout: 10_000 },
      (remote) => {
        const responseHeaders: http.OutgoingHttpHeaders = {
          ...remote.headers,
        };
        delete responseHeaders["set-cookie"];
        response.writeHead(remote.statusCode ?? 502, responseHeaders);
        remote.pipe(response);
      },
    );
    upstream.once("timeout", () => upstream.destroy());
    upstream.once("error", () => {
      if (!response.writableEnded) {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      }
    });
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });

  const rejectSocket = (socket: Duplex): void => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  };
  server.on("connect", (_request, socket) => {
    deniedConnect += 1;
    rejectSocket(socket);
  });
  server.on("upgrade", (_request, socket) => {
    deniedUpgrade += 1;
    rejectSocket(socket);
  });
  server.on("clientError", (_error, socket) => {
    rejectSocket(socket);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("CDP proxy did not bind an ephemeral loopback port"));
      } else {
        resolve(address.port);
      }
    });
  });

  let closed = false;
  return {
    port,
    snapshot: () => ({
      forwardedHttp,
      deniedHttp,
      deniedConnect,
      deniedUpgrade,
      deniedRevoked,
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
