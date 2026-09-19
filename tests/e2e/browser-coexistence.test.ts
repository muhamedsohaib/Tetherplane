import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startBrowserLab } from "@tetherplane/browser-lab";
import {
  BrowserBridgeService,
  CdpBrowserBackend,
  findInstalledChromium,
  launchCdpOwnedBrowser,
  startBrowserRpcServer,
  type BrowserObservedState,
  type BrowserServiceBackend,
  type BrowserServicePage,
  type RawBrowserDiagnosticEvent,
  type RawBrowserDownload,
  type ResolvedBrowserAction,
} from "@tetherplane/browser-bridge";

import { startLocalCompact } from "./helpers/start-local.ts";

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  return client.callTool({ name, arguments: args });
}

function structured(
  result: Awaited<ReturnType<typeof call>>,
): Record<string, unknown> {
  assert.ok(result.structuredContent, "expected structuredContent");
  return result.structuredContent as Record<string, unknown>;
}

class CoexistenceBackend implements BrowserServiceBackend {
  readonly #delegate: CdpBrowserBackend;
  readonly human: BrowserServicePage = {
    page_id: "human:1",
    ownership: "human",
    active: true,
    url: "https://human.example/work",
  };
  humanMutationAttempts = 0;

  constructor(delegate: CdpBrowserBackend) {
    this.#delegate = delegate;
  }

  capabilities(): Record<string, unknown> {
    return {
      ...this.#delegate.capabilities(),
      coexistence_fixture: true,
    };
  }

  async pages(): Promise<BrowserServicePage[]> {
    return [
      structuredClone(this.human),
      ...(await this.#delegate.pages()),
    ];
  }

  async createTab(url: string): Promise<BrowserServicePage> {
    return this.#delegate.createTab(url);
  }

  async navigate(
    pageId: string,
    url: string,
  ): Promise<BrowserServicePage> {
    this.#rejectHumanMutation(pageId);
    return this.#delegate.navigate(pageId, url);
  }

  async close(pageId: string): Promise<void> {
    this.#rejectHumanMutation(pageId);
    await this.#delegate.close(pageId);
  }

  async observe(pageId: string): Promise<BrowserObservedState> {
    if (pageId === this.human.page_id) {
      return {
        page_id: pageId,
        url: this.human.url,
        semantic_revision: 1,
        resource_revision: null,
        nodes: [],
        validation_messages: [],
        toasts: [],
      };
    }
    return this.#delegate.observe(pageId);
  }

  async perform(
    pageId: string,
    action: ResolvedBrowserAction,
  ): Promise<void> {
    this.#rejectHumanMutation(pageId);
    await this.#delegate.perform(pageId, action);
  }

  async waitForSettled(
    pageId: string,
    afterRevision: number,
    timeoutMs: number,
  ): Promise<BrowserObservedState> {
    if (pageId === this.human.page_id) {
      return this.observe(pageId);
    }
    return this.#delegate.waitForSettled(
      pageId,
      afterRevision,
      timeoutMs,
    );
  }

  async uploadFile(
    pageId: string,
    backendId: string,
    filePath: string,
  ): Promise<void> {
    this.#rejectHumanMutation(pageId);
    await this.#delegate.uploadFile(
      pageId,
      backendId,
      filePath,
    );
  }

  async downloads(
    pageId?: string,
  ): Promise<RawBrowserDownload[]> {
    if (pageId === this.human.page_id) {
      return [];
    }
    return this.#delegate.downloads(pageId);
  }

  async diagnostics(
    pageId: string,
    limit: number,
  ): Promise<RawBrowserDiagnosticEvent[]> {
    if (pageId === this.human.page_id) {
      return [];
    }
    return this.#delegate.diagnostics(pageId, limit);
  }

  #rejectHumanMutation(pageId: string): void {
    if (pageId === this.human.page_id) {
      this.humanMutationAttempts += 1;
      throw new Error("human page reached mutation backend");
    }
  }
}

test(
  "B8 compact MCP completes a verified browser workflow without touching active human state",
  { timeout: 60_000 },
  async () => {
    const executablePath = findInstalledChromium();
    assert.ok(
      executablePath,
      "expected an installed compatible Chromium executable",
    );

    const lab = await startBrowserLab();
    const control = await launchCdpOwnedBrowser({
      executablePath,
    });
    const cdp = new CdpBrowserBackend({
      control,
      pollIntervalMs: 20,
    });
    const backend = new CoexistenceBackend(cdp);
    const bridge = await startBrowserRpcServer({
      host: "127.0.0.1",
      port: 0,
      token: "b8-ephemeral-token",
      service: new BrowserBridgeService({ backend }),
    });
    const local = await startLocalCompact({
      browserBridge: {
        address: bridge.address,
        token: "b8-ephemeral-token",
      },
    });

    try {
      const tools = await local.client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        ["batch", "browser", "desktop", "device", "files", "process"],
      );

      const pages = structured(
        await call(local.client, "browser", {
          op: "pages",
          args: {},
        }),
      ).pages as Array<Record<string, unknown>>;
      const human = pages.find(
        (page) => page.page_id === backend.human.page_id,
      );
      assert.equal(human?.active, true);
      assert.equal(human?.ownership, "human");

      const denied = await call(local.client, "browser", {
        op: "navigate",
        args: {
          page_id: backend.human.page_id,
          url: "https://blocked.example/",
          ownership: "tetherplane",
        },
      });
      assert.equal(denied.isError, true);
      assert.equal(
        (structured(denied).error as Record<string, unknown>).code,
        "permission_denied",
      );

      const created = structured(
        await call(local.client, "browser", {
          op: "create_tab",
          args: { url: lab.origin },
        }),
      );
      const pageId = created.page_id as string;
      assert.match(pageId, /^cdp:/);
      assert.equal(created.active, false);
      assert.equal(created.ownership, "tetherplane");

      const snapshot = structured(
        await call(local.client, "browser", {
          op: "snapshot",
          args: { page_id: pageId },
        }),
      );
      const nodes = snapshot.nodes as Array<Record<string, unknown>>;
      const input = nodes.find(
        (node) => node.accessible_name === "Project value",
      );
      const save = nodes.find(
        (node) => node.accessible_name === "Save",
      );
      assert.ok(input);
      assert.ok(save);

      const saved = structured(
        await call(local.client, "browser", {
          op: "act",
          args: {
            page_id: pageId,
            actions: [
              {
                kind: "fill",
                target: input.ref,
                value: "b8-saved",
              },
              {
                kind: "click",
                target: save.ref,
              },
            ],
            expectations: [
              {
                kind: "value",
                target: input.ref,
                equals: "b8-saved",
              },
              { kind: "toast", includes: "Saved" },
              { kind: "validation_absent" },
            ],
            timeout_ms: 5_000,
          },
        }),
      );
      assert.equal(saved.state, "verified");

      const persisted = await fetch(
        new URL("/api/state", lab.origin),
      );
      assert.equal(persisted.status, 200);
      const persistedState =
        (await persisted.json()) as Record<string, unknown>;
      assert.equal(persistedState.value, "b8-saved");

      const uploadPath = path.join(local.root, "b8-upload.txt");
      await writeFile(uploadPath, "b8-native-upload", "utf8");
      const afterSave = structured(
        await call(local.client, "browser", {
          op: "snapshot",
          args: { page_id: pageId },
        }),
      );
      const afterSaveNodes =
        afterSave.nodes as Array<Record<string, unknown>>;
      const upload = afterSaveNodes.find(
        (node) => node.accessible_name === "Fixture upload",
      );
      const download = afterSaveNodes.find(
        (node) => node.accessible_name === "Download fixture",
      );
      const failRequest = afterSaveNodes.find(
        (node) => node.accessible_name === "Fail request",
      );
      assert.ok(upload);
      assert.ok(download);
      assert.ok(failRequest);

      const uploaded = await call(local.client, "browser", {
        op: "upload",
        args: {
          page_id: pageId,
          target: upload.ref,
          file_path: uploadPath,
        },
      });
      assert.equal(uploaded.isError, undefined);

      const uploadState = await waitFor(async () => {
        const response = await fetch(
          new URL("/api/upload-state", lab.origin),
        );
        const state =
          (await response.json()) as Record<string, unknown>;
        return state.last_upload === "b8-native-upload"
          ? state
          : null;
      });
      assert.equal(uploadState.last_upload, "b8-native-upload");

      await call(local.client, "browser", {
        op: "diagnostics",
        args: { page_id: pageId, limit: 50 },
      });
      await call(local.client, "browser", {
        op: "act",
        args: {
          page_id: pageId,
          actions: [
            { kind: "click", target: failRequest.ref },
          ],
        },
      });
      const diagnostic = await waitFor(async () => {
        const result = structured(
          await call(local.client, "browser", {
            op: "diagnostics",
            args: { page_id: pageId, limit: 50 },
          }),
        );
        const events =
          result.events as Array<Record<string, unknown>>;
        return (
          events.find(
            (event) => event.response_status === 503,
          ) ?? null
        );
      });
      assert.equal(diagnostic.response_status, 503);
      assert.equal(
        JSON.stringify(diagnostic).includes(
          "SECRET-BROWSER-TOKEN",
        ),
        false,
      );

      await call(local.client, "browser", {
        op: "act",
        args: {
          page_id: pageId,
          actions: [
            { kind: "click", target: download.ref },
          ],
        },
      });
      const completedDownload = await waitFor(async () => {
        const result = structured(
          await call(local.client, "browser", {
            op: "downloads",
            args: { page_id: pageId },
          }),
        );
        const downloads =
          result.downloads as Array<Record<string, unknown>>;
        return (
          downloads.find(
            (item) => item.state === "complete",
          ) ?? null
        );
      });
      assert.match(
        String(completedDownload.handle),
        /^download_[0-9a-f]{16}$/,
      );

      const checkpoint = structured(
        await call(local.client, "browser", {
          op: "checkpoint",
          args: { page_id: pageId },
        }),
      );
      const checkpointRevision =
        checkpoint.resource_revision as string;
      assert.ok(checkpointRevision);

      const competingEdit = await fetch(
        new URL("/api/save", lab.origin),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value: "b8-competing-edit",
            expected_revision: Number(checkpointRevision),
          }),
        },
      );
      assert.equal(competingEdit.status, 200);

      await cdp.navigate(pageId, lab.origin);
      const conflict = structured(
        await call(local.client, "browser", {
          op: "act",
          args: {
            page_id: pageId,
            expected_resource_revision:
              checkpointRevision,
            actions: [],
          },
        }),
      );
      assert.equal(conflict.state, "conflict");
      assert.equal(
        (conflict.error as Record<string, unknown>).code,
        "resource_conflict",
      );

      const finalPages = structured(
        await call(local.client, "browser", {
          op: "pages",
          args: {},
        }),
      ).pages as Array<Record<string, unknown>>;
      const finalHuman = finalPages.find(
        (page) => page.page_id === backend.human.page_id,
      );
      assert.equal(finalHuman?.active, true);
      assert.equal(
        finalHuman?.url,
        "https://human.example/work",
      );
      assert.equal(backend.humanMutationAttempts, 0);
    } finally {
      await local.close();
      await bridge.close();
      await cdp.shutdown();
      await lab.close();
    }
  },
);

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("timed out waiting for browser fixture state");
}
