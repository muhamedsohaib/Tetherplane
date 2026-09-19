import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type LabState = {
  value: string;
  revision: number;
  last_saved_at: number | null;
  validation_error: string | null;
  last_upload: string | null;
};

export type BrowserLab = {
  origin: string;
  close(): Promise<void>;
};

export async function startBrowserLab(): Promise<BrowserLab> {
  const state: LabState = {
    value: "initial",
    revision: 1,
    last_saved_at: null,
    validation_error: null,
    last_upload: null,
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response, state);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
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

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: LabState,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://browser-lab.local");

  if (request.method === "GET" && url.pathname === "/") {
    return html(response, mainPage(state));
  }

  if (request.method === "GET" && url.pathname === "/frame") {
    return html(
      response,
      "<!doctype html><html><body><button id=\"frame-action\">Frame action</button></body></html>",
    );
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    return json(response, 200, publicState(state));
  }

  if (request.method === "POST" && url.pathname === "/api/save") {
    const delayMs = boundedDelay(url.searchParams.get("delay_ms"));
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const body = await readJson(request);
    const value = typeof body.value === "string" ? body.value : "";
    const expectedRevision =
      typeof body.expected_revision === "number"
        ? body.expected_revision
        : null;

    if (expectedRevision !== null && expectedRevision !== state.revision) {
      return json(response, 409, {
        code: "resource_conflict",
        current_revision: state.revision,
      });
    }

    if (!value.trim()) {
      state.validation_error = "Value is required";
      return json(response, 422, {
        code: "validation_failed",
        field: "value",
        message: "Value is required",
      });
    }

    state.value = value;
    state.revision += 1;
    state.last_saved_at = state.revision;
    state.validation_error = null;
    return json(response, 200, publicState(state));
  }

  if (request.method === "POST" && url.pathname === "/api/upload") {
    const content = await readText(request);
    state.last_upload = content;
    return json(response, 200, {
      received_bytes: Buffer.byteLength(content),
      revision: state.revision,
    });
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/upload-state"
  ) {
    return json(response, 200, {
      last_upload: state.last_upload,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/slow") {
    const delayMs = boundedDelay(url.searchParams.get("delay_ms") ?? "150");
    await sleep(delayMs);
    return json(response, 200, { code: "slow_complete", delay_ms: delayMs });
  }

  if (request.method === "GET" && url.pathname === "/api/fail") {
    return json(response, 503, { code: "synthetic_failure" });
  }

  if (request.method === "GET" && url.pathname === "/download.txt") {
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader(
      "content-disposition",
      'attachment; filename="browser-lab-download.txt"',
    );
    response.end("browser-lab-download\n");
    return;
  }

  json(response, 404, { code: "not_found" });
}

function publicState(state: LabState) {
  return {
    value: state.value,
    revision: state.revision,
    last_saved_at: state.last_saved_at,
    validation_error: state.validation_error,
  };
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function mainPage(state: LabState): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Tetherplane Browser Lab</title></head>
<body>
  <main aria-label="Browser Lab">
    <label for="value-input">Project value</label>
    <input id="value-input" value="${escapeHtmlAttribute(state.value)}" />
    <button id="save-button" type="button">Save</button>
    <div id="validation" role="alert" hidden></div>
    <div id="toast" role="status" aria-live="polite"></div>
    <div id="revision" data-revision="${state.revision}">Revision ${state.revision}</div>
    <iframe title="Nested fixture" src="/frame"></iframe>
    <input id="upload-input" type="file" aria-label="Fixture upload" />
    <a id="download-link" href="/download.txt">Download fixture</a>
    <button id="fail-request" type="button">Fail request</button>
  </main>
  <script>
    let revision = ${state.revision};
    const input = document.getElementById("value-input");
    const save = document.getElementById("save-button");
    const validation = document.getElementById("validation");
    const toast = document.getElementById("toast");
    const revisionNode = document.getElementById("revision");
    const uploadInput = document.getElementById("upload-input");
    const failRequest = document.getElementById("fail-request");

    failRequest.addEventListener("click", async () => {
      const response = await fetch("/api/fail", {
        headers: {
          authorization: "Bearer SECRET-BROWSER-TOKEN",
        },
      });
      toast.textContent = "Fail request " + response.status;
    });

    uploadInput.addEventListener("change", async () => {
      const file = uploadInput.files?.[0];
      if (!file) {
        return;
      }
      const response = await fetch("/api/upload", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: await file.text(),
      });
      if (response.ok) {
        toast.textContent = "Uploaded";
      }
    });

    save.addEventListener("click", async () => {
      const response = await fetch("/api/save?delay_ms=60", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: input.value,
          expected_revision: revision,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        validation.hidden = false;
        validation.textContent = payload.message ?? payload.code;
        return;
      }
      revision = payload.revision;
      validation.hidden = true;
      toast.textContent = "Saved";
      const replacement = revisionNode.cloneNode(true);
      replacement.dataset.revision = String(revision);
      replacement.textContent = "Revision " + revision;
      revisionNode.replaceWith(replacement);
    });
  </script>
</body>
</html>`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readText(request);
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to an empty payload
  }
  return {};
}

async function readText(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_000_000) {
      break;
    }
  }
  return body;
}

function boundedDelay(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(2_000, Math.floor(parsed)));
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, value: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(value);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
