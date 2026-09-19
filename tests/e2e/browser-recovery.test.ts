import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  BrowserBridgeService,
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
  args: Record<string, unknown>,
) {
  return client.callTool({
    name: "browser",
    arguments: args,
  });
}

function structured(
  result: Awaited<ReturnType<typeof call>>,
): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

class CountingBrowserBackend implements BrowserServiceBackend {
  page: BrowserServicePage | null = {
    page_id: "owned:1",
    ownership: "tetherplane",
    active: false,
    url: "https://fixture.example/editor",
  };
  revision = 1;
  mutationCount = 0;
  toast = "";

  capabilities(): Record<string, unknown> {
    return {
      backend: "counting",
      ownership: "tetherplane_only",
      operations: ["pages", "snapshot", "act"],
    };
  }

  async pages(): Promise<BrowserServicePage[]> {
    return this.page ? [structuredClone(this.page)] : [];
  }

  async createTab(url: string): Promise<BrowserServicePage> {
    this.page = {
      page_id: "owned:restart",
      ownership: "tetherplane",
      active: false,
      url,
    };
    this.revision += 1;
    return structuredClone(this.page);
  }

  async navigate(
    pageId: string,
    url: string,
  ): Promise<BrowserServicePage> {
    const page = this.#requirePage(pageId);
    page.url = url;
    this.page = page;
    this.mutationCount += 1;
    this.revision += 1;
    return structuredClone(page);
  }

  async close(pageId: string): Promise<void> {
    this.#requirePage(pageId);
    this.page = null;
    this.mutationCount += 1;
    this.revision += 1;
  }

  async observe(pageId: string): Promise<BrowserObservedState> {
    const page = this.#requirePage(pageId);
    return {
      page_id: page.page_id,
      url: page.url,
      semantic_revision: this.revision,
      resource_revision: String(this.revision),
      nodes: [
        {
          backend_id: "button:mutate",
          role: "button",
          accessible_name: "Mutate",
          ancestry: [],
          document_id: "document:1",
          frame_id: "frame:top",
        },
      ],
      validation_messages: [],
      toasts: this.toast ? [this.toast] : [],
    };
  }

  async perform(
    pageId: string,
    _action: ResolvedBrowserAction,
  ): Promise<void> {
    this.#requirePage(pageId);
    this.mutationCount += 1;
    this.revision += 1;
    this.toast = "Mutated";
  }

  async waitForSettled(
    pageId: string,
    _afterRevision: number,
    _timeoutMs: number,
  ): Promise<BrowserObservedState> {
    return this.observe(pageId);
  }

  async uploadFile(
    pageId: string,
    _backendId: string,
    _filePath: string,
  ): Promise<void> {
    this.#requirePage(pageId);
    this.mutationCount += 1;
  }

  async downloads(
    _pageId?: string,
  ): Promise<RawBrowserDownload[]> {
    return [];
  }

  async diagnostics(
    pageId: string,
    _limit: number,
  ): Promise<RawBrowserDiagnosticEvent[]> {
    this.#requirePage(pageId);
    return [];
  }

  losePage(): void {
    this.page = null;
    this.revision += 1;
  }

  restartBrowser(): void {
    this.page = {
      page_id: "owned:after-restart",
      ownership: "tetherplane",
      active: false,
      url: "https://fixture.example/restarted",
    };
    this.revision += 1;
    this.toast = "";
  }

  #requirePage(pageId: string): BrowserServicePage {
    if (!this.page || this.page.page_id !== pageId) {
      throw Object.assign(
        new Error("browser page no longer exists"),
        { code: "stale_reference" },
      );
    }
    return structuredClone(this.page);
  }
}

test(
  "B9 duplicate browser.act retry is replayed without a second mutation",
  { timeout: 20_000 },
  async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "tetherplane-browser-idem-"),
    );
    const backend = new CountingBrowserBackend();
    const bridge = await startBrowserRpcServer({
      service: new BrowserBridgeService({ backend }),
      token: "b9-idempotency-token",
    });
    const local = await startLocalCompact({
      stateDir,
      browserBridge: {
        address: bridge.address,
        token: "b9-idempotency-token",
      },
    });

    try {
      const snapshot = structured(
        await call(local.client, {
          op: "snapshot",
          args: { page_id: "owned:1" },
        }),
      );
      const target = (
        snapshot.nodes as Array<Record<string, unknown>>
      )[0]?.ref;
      assert.ok(target);

      const mutation = {
        op: "act",
        idempotency_key: "browser-mutate-once",
        args: {
          page_id: "owned:1",
          actions: [{ kind: "click", target }],
          expectations: [
            { kind: "toast", includes: "Mutated" },
          ],
        },
      };

      const first = structured(
        await call(local.client, mutation),
      );
      const retry = structured(
        await call(local.client, mutation),
      );

      assert.equal(first.state, "verified");
      assert.deepEqual(retry, first);
      assert.equal(
        backend.mutationCount,
        1,
        "idempotent retry reached the browser backend twice",
      );
    } finally {
      await local.close();
      await bridge.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

test(
  "B9 tab loss and browser restart invalidate stale page identity safely",
  { timeout: 20_000 },
  async () => {
    const backend = new CountingBrowserBackend();
    const bridge = await startBrowserRpcServer({
      service: new BrowserBridgeService({ backend }),
      token: "b9-restart-token",
    });
    const local = await startLocalCompact({
      browserBridge: {
        address: bridge.address,
        token: "b9-restart-token",
      },
    });

    try {
      const snapshot = structured(
        await call(local.client, {
          op: "snapshot",
          args: { page_id: "owned:1" },
        }),
      );
      const staleTarget = (
        snapshot.nodes as Array<Record<string, unknown>>
      )[0]?.ref;
      assert.ok(staleTarget);

      backend.losePage();
      const lost = await call(local.client, {
        op: "act",
        args: {
          page_id: "owned:1",
          actions: [{ kind: "click", target: staleTarget }],
        },
      });
      assert.equal(lost.isError, true);
      assert.ok(
        ["invalid_arguments", "stale_reference"].includes(
          String(
            (structured(lost).error as Record<string, unknown>)
              .code,
          ),
        ),
      );
      assert.equal(backend.mutationCount, 0);

      backend.restartBrowser();
      const pages = structured(
        await call(local.client, {
          op: "pages",
          args: {},
        }),
      ).pages as Array<Record<string, unknown>>;
      assert.equal(pages.length, 1);
      assert.equal(
        pages[0]?.page_id,
        "owned:after-restart",
      );

      const oldAfterRestart = await call(local.client, {
        op: "snapshot",
        args: { page_id: "owned:1" },
      });
      assert.equal(oldAfterRestart.isError, true);
      assert.equal(backend.mutationCount, 0);

      const replacement = structured(
        await call(local.client, {
          op: "snapshot",
          args: { page_id: "owned:after-restart" },
        }),
      );
      assert.equal(
        (replacement.nodes as Array<Record<string, unknown>>)
          .length,
        1,
      );
    } finally {
      await local.close();
      await bridge.close();
    }
  },
);
