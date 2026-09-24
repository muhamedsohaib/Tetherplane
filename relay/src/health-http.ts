import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

export class RelayHealthHttpGateway {
  #attachedServer: Server | null = null;
  #requestHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null;

  attach(server: Server): void {
    if (this.#attachedServer) {
      throw new Error("relay health gateway is already attached");
    }

    this.#attachedServer = server;
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

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ status }));
  }
}
