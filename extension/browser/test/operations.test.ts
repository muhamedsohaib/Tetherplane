import assert from "node:assert/strict";
import test from "node:test";

import {
  ChromeOperationalAgent,
  type ChromeDebuggerApi,
  type ChromeDebuggerEventListener,
  type ChromeDownloadsApi,
} from "../src/operations.ts";

class FakeController {
  readonly records = new Map([
    [
      "tab:7",
      {
        page_id: "tab:7",
        tab_id: 7,
        window_id: 1,
        url: "https://fixture.example/editor",
        active: false,
        ownership: "tetherplane" as const,
      },
    ],
    [
      "tab:1",
      {
        page_id: "tab:1",
        tab_id: 1,
        window_id: 1,
        url: "https://human.example/",
        active: true,
        ownership: "human" as const,
      },
    ],
  ]);

  pages() {
    return [...this.records.values()].map((record) =>
      structuredClone(record),
    );
  }
}

class FakeDebugger implements ChromeDebuggerApi {
  readonly attached: number[] = [];
  readonly detached: number[] = [];
  readonly commands: Array<{
    tabId: number;
    method: string;
    params?: Record<string, unknown>;
  }> = [];
  listener: ChromeDebuggerEventListener | null = null;

  readonly onEvent = {
    addListener: (listener: ChromeDebuggerEventListener) => {
      this.listener = listener;
    },
    removeListener: (listener: ChromeDebuggerEventListener) => {
      if (this.listener === listener) {
        this.listener = null;
      }
    },
  };

  async attach(target: { tabId: number }, _version: string) {
    this.attached.push(target.tabId);
  }

  async detach(target: { tabId: number }) {
    this.detached.push(target.tabId);
  }

  async sendCommand(
    target: { tabId: number },
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.commands.push({
      tabId: target.tabId,
      method,
      ...(params ? { params: structuredClone(params) } : {}),
    });

    if (method === "DOM.getDocument") {
      return { root: { nodeId: 100 } };
    }
    if (method === "DOM.querySelector") {
      return { nodeId: 101 };
    }
    if (method === "DOM.resolveNode") {
      return { object: { objectId: "object-upload-input" } };
    }
    return {};
  }

  emit(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    this.listener?.({ tabId }, method, structuredClone(params));
  }
}

class FakeDownloads implements ChromeDownloadsApi {
  items = [
    {
      id: 42,
      url: "https://fixture.example/download.txt",
      referrer: "https://fixture.example/editor",
      filename: "C:\\Downloads\\browser-lab-download.txt",
      state: "complete",
      bytesReceived: 21,
      totalBytes: 21,
    },
    {
      id: 99,
      url: "https://other.example/file.txt",
      referrer: "https://other.example/",
      filename: "C:\\Downloads\\other.txt",
      state: "complete",
      bytesReceived: 5,
      totalBytes: 5,
    },
  ];

  async search() {
    return structuredClone(this.items);
  }
}

function setup() {
  const controller = new FakeController();
  const debuggerApi = new FakeDebugger();
  const downloadsApi = new FakeDownloads();
  const agent = new ChromeOperationalAgent({
    controller,
    debuggerApi,
    downloadsApi,
    maxDiagnosticEvents: 3,
  });
  return { controller, debuggerApi, downloadsApi, agent };
}

test("native file upload uses DOM.setFileInputFiles and never invokes a file picker", async () => {
  const { agent, debuggerApi } = setup();

  await agent.uploadFile(
    "tab:7",
    "frame:0|css:#upload-input",
    "C:\\fixtures\\upload.txt",
  );

  assert.deepEqual(debuggerApi.attached, [7]);
  assert.deepEqual(
    debuggerApi.commands.map((command) => command.method),
    [
      "DOM.enable",
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.setFileInputFiles",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
    ],
  );
  assert.deepEqual(debuggerApi.commands[3]?.params, {
    nodeId: 101,
    files: ["C:\\fixtures\\upload.txt"],
  });
  assert.equal(
    debuggerApi.commands.at(-1)?.params?.objectId,
    "object-upload-input",
  );
});

test("native upload refuses human-owned tab and non-top-frame fallback", async () => {
  const { agent, debuggerApi } = setup();

  await assert.rejects(
    () =>
      agent.uploadFile(
        "tab:1",
        "frame:0|css:#upload-input",
        "C:\\fixtures\\upload.txt",
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "permission_denied",
  );

  await assert.rejects(
    () =>
      agent.uploadFile(
        "tab:7",
        "frame:2|css:#upload-input",
        "C:\\fixtures\\upload.txt",
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "capability_unavailable",
  );

  assert.equal(debuggerApi.commands.length, 0);
});

test("download tracking maps browser downloads to backend records scoped to page origin", async () => {
  const { agent } = setup();

  assert.deepEqual(await agent.downloads("tab:7"), [
    {
      backend_id: "chrome:42",
      page_id: "tab:7",
      filename: "browser-lab-download.txt",
      local_path: "C:\\Downloads\\browser-lab-download.txt",
      state: "complete",
      bytes_received: 21,
      total_bytes: 21,
    },
  ]);
});

test("debugger diagnostics are bounded and strip credential headers before bridge transport", async () => {
  const { agent, debuggerApi } = setup();

  assert.deepEqual(await agent.diagnostics("tab:7", 10), []);
  assert.deepEqual(debuggerApi.attached, [7]);
  assert.ok(
    debuggerApi.commands.some(
      (command) => command.method === "Log.enable",
    ),
  );
  assert.ok(
    debuggerApi.commands.some(
      (command) => command.method === "Network.enable",
    ),
  );

  debuggerApi.emit(7, "Log.entryAdded", {
    entry: {
      level: "error",
      text: "synthetic console failure",
      url: "https://fixture.example/editor",
      timestamp: 100,
    },
  });
  debuggerApi.emit(7, "Network.requestWillBeSent", {
    request: {
      url: "https://fixture.example/api",
      headers: {
        Authorization: "Bearer SECRET",
        Cookie: "session=SECRET",
        "Content-Type": "application/json",
      },
    },
    timestamp: 101,
  });
  debuggerApi.emit(7, "Log.entryAdded", {
    entry: { level: "warning", text: "second", timestamp: 102 },
  });
  debuggerApi.emit(7, "Log.entryAdded", {
    entry: { level: "info", text: "third", timestamp: 103 },
  });

  const events = await agent.diagnostics("tab:7", 10);
  assert.equal(events.length, 3);
  const encoded = JSON.stringify(events);
  assert.equal(encoded.includes("SECRET"), false);
  assert.equal(encoded.includes("Authorization"), false);
  assert.equal(encoded.includes("Cookie"), false);
  assert.ok(encoded.includes("Content-Type"));
  assert.equal(
    events.some((event) => event.message === "synthetic console failure"),
    false,
  );
});

test("debugger diagnostics refuse attaching to ordinary human tab", async () => {
  const { agent, debuggerApi } = setup();

  await assert.rejects(
    () => agent.diagnostics("tab:1", 10),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "permission_denied",
  );
  assert.equal(debuggerApi.attached.length, 0);
});
