import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

export class RelayHealthHttpGateway {
  #attachedServer: Server | null = null;
  #readySinceMs: number | null = null;
  #requestHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null;

  attach(server: Server): void {
    if (this.#attachedServer) {
      throw new Error("relay health gateway is already attached");
    }

    this.#attachedServer = server;
    // Ready once serving: all gateways are constructed before attach,
    // so this timestamp marks genuine serving readiness, not process
    // start. Unauthenticated by design; carries no device data.
    this.#readySinceMs = Date.now();
    this.#requestHandler = (request, response) => {
      this.#handleRequest(request, response);
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

  #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    const pathname =
      url.pathname === "/healthz"
        ? "healthz"
        : url.pathname === "/readyz"
          ? "readyz"
          : null;

    if (pathname === null) {
      return;
    }

    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("allow", "GET");
      response.end();
      return;
    }

    // Readiness reflects freshness, not a static string: every reading
    // carries when it was taken plus the serving-since baseline, so a
    // stuck or cached responder is detectable. Per-device capability
    // freshness lives behind authentication (device.capabilities) and
    // is deliberately never exposed on these unauthenticated probes.
    const body =
      pathname === "healthz"
        ? { status: "ok" }
        : {
            status: "ready",
            observed_at: new Date().toISOString(),
            ready_since: new Date(this.#readySinceMs ?? Date.now()).toISOString(),
            uptime_ms: Date.now() - (this.#readySinceMs ?? Date.now()),
          };

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(body));
  }
}
