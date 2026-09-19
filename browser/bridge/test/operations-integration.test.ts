import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startBrowserLab } from "@tetherplane/browser-lab";

import {
  BrowserOperationalEngine,
  BrowserOwnershipRegistry,
  CdpBrowserBackend,
  SemanticSnapshotEngine,
  VerifiedActionEngine,
  findInstalledChromium,
  launchCdpOwnedBrowser,
} from "../src/index.ts";

async function waitUntil<T>(
  operation: () => Promise<T | null>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition did not become true before timeout");
}

test(
  "B6 CDP operational path proves native upload download diagnostics checkpoint and conflict",
  { timeout: 30_000 },
  async () => {
    const executablePath = findInstalledChromium();
    assert.ok(
      executablePath,
      "expected an installed compatible Chromium executable",
    );

    const lab = await startBrowserLab();
    const temp = await mkdtemp(
      path.join(os.tmpdir(), "tetherplane-b6-"),
    );
    const uploadPath = path.join(temp, "upload.txt");
    await writeFile(
      uploadPath,
      "native-upload-content",
      "utf8",
    );

    const control = await launchCdpOwnedBrowser({
      executablePath,
    });
    const backend = new CdpBrowserBackend({
      control,
      pollIntervalMs: 20,
    });
    const ownership = new BrowserOwnershipRegistry();
    const semantics = new SemanticSnapshotEngine();

    try {
      const page = await backend.createTab(lab.origin);
      ownership.register({
        page_id: page.page_id,
        ownership: "tetherplane",
        active: false,
      });
      const operations = new BrowserOperationalEngine({
        backend,
        ownership,
        semantics,
      });

      const observed = await backend.observe(page.page_id);
      const snapshot = semantics.snapshot(observed.nodes, {
        revision: observed.semantic_revision,
      });
      const upload = snapshot.nodes.find(
        (node) =>
          node.accessible_name === "Fixture upload",
      );
      const downloadLink = snapshot.nodes.find(
        (node) =>
          node.accessible_name === "Download fixture",
      );
      const failRequest = snapshot.nodes.find(
        (node) =>
          node.accessible_name === "Fail request",
      );
      assert.ok(upload);
      assert.ok(downloadLink);
      assert.ok(failRequest);

      await operations.upload({
        page_id: page.page_id,
        mode: "background_only",
        target: upload.ref,
        file_path: uploadPath,
      });

      const uploaded = await waitUntil(async () => {
        const response = await fetch(
          new URL("/api/upload-state", lab.origin),
        );
        if (!response.ok) {
          return null;
        }
        const state =
          (await response.json()) as Record<string, unknown>;
        return state.last_upload === "native-upload-content"
          ? state
          : null;
      });
      assert.equal(
        uploaded.last_upload,
        "native-upload-content",
      );

      await operations.diagnostics({
        page_id: page.page_id,
        limit: 50,
      });
      await backend.perform(page.page_id, {
        kind: "click",
        backend_id: semantics.reacquire(
          failRequest.ref,
          (await backend.observe(page.page_id)).nodes,
        ).backend_id,
      });

      const diagnostics = await waitUntil(async () => {
        const result = await operations.diagnostics({
          page_id: page.page_id,
          limit: 50,
        });
        return result.events.some(
          (event) => event.response_status === 503,
        )
          ? result
          : null;
      });
      const encodedDiagnostics = JSON.stringify(diagnostics);
      assert.equal(
        encodedDiagnostics.includes(
          "SECRET-BROWSER-TOKEN",
        ),
        false,
      );
      assert.ok(
        diagnostics.events.some(
          (event) => event.response_status === 503,
        ),
      );

      await backend.perform(page.page_id, {
        kind: "click",
        backend_id: semantics.reacquire(
          downloadLink.ref,
          (await backend.observe(page.page_id)).nodes,
        ).backend_id,
      });

      const completedDownload = await waitUntil(async () => {
        const result = await operations.downloads({
          page_id: page.page_id,
        });
        return (
          result.downloads.find(
            (download) => download.state === "complete",
          ) ?? null
        );
      });
      assert.match(
        completedDownload.handle,
        /^download_[0-9a-f]{16}$/,
      );
      assert.ok(completedDownload.local_path);
      assert.equal(
        existsSync(completedDownload.local_path),
        true,
      );
      assert.equal(
        await readFile(
          completedDownload.local_path,
          "utf8",
        ),
        "browser-lab-download\n",
      );

      const checkpoint = await operations.checkpoint({
        page_id: page.page_id,
        mode: "background_only",
      });
      assert.equal(checkpoint.resource_revision, "1");
      assert.equal(
        JSON.stringify(checkpoint).includes("token"),
        false,
      );

      const secondEdit = await fetch(
        new URL("/api/save", lab.origin),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            value: "second-tab-edit",
            expected_revision: 1,
          }),
        },
      );
      assert.equal(secondEdit.status, 200);

      await backend.navigate(page.page_id, lab.origin);
      const actionEngine = new VerifiedActionEngine({
        backend,
        ownership,
        semantics,
      });
      const conflict = await actionEngine.execute({
        page_id: page.page_id,
        mode: "background_only",
        actions: [],
        expected_resource_revision:
          checkpoint.resource_revision,
      });
      assert.equal(conflict.state, "conflict");
      assert.equal(
        conflict.error?.code,
        "resource_conflict",
      );
    } finally {
      await backend.shutdown();
      await lab.close();
      await rm(temp, {
        recursive: true,
        force: true,
      });
    }
  },
);
