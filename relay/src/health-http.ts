import { performance } from "node:perf_hooks";
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

export class RelayHealthHttpGateway {
  #attachedServer: Server | null = null;
  #readySince: { wallMs: number; monotonicMs: number } | null = null;
  #listeningHandler = () => {
    this.#readySince = {wallMs: Date.now(), monotonicMs: performance.now()};
  };
  #requestHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null;

  attach(server: Server): void {
    if (this.#attachedServer) {
      throw new Error("relay health gateway is already attached");
    }

    this.#attachedServer = server;
    server.on("listening", this.#listeningHandler);
    if (server.listening) this.#listeningHandler();
    this.#requestHandler = (request, response) => {
      this.#handleRequest(request, response);
    };
    server.on("request", this.#requestHandler);
  }

  close(): void {
    if (this.#attachedServer && this.#requestHandler) {
      this.#attachedServer.off("request", this.#requestHandler);
      this.#attachedServer.off("listening", this.#listeningHandler);
    }
    this.#readySince = null;
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

    const status =
      url.pathname === "/healthz"
        ? "ok"
        : url.pathname === "/readyz"
          ? "ready"
          : null;

    if (status === null) {
      return;
    }

    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("allow", "GET");
      response.end();
      return;
    }

    // Public readiness is relay serving health only, not device or
    // capability health. Never leak private fleet or identity data here.
    const ready = this.#readySince;
    const body = status === "ok" ? { status } : ready && this.#attachedServer?.listening
      ? {
          status,
          observed_at: new Date().toISOString(),
          ready_since: new Date(ready.wallMs).toISOString(),
          uptime_ms: Math.max(0, Math.floor(performance.now() - ready.monotonicMs)),
        }
      : { status: "not_ready" };
    response.statusCode = body.status === "not_ready" ? 503 : 200;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(body));
  }
}
