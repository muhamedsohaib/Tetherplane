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
    // Only fixed stage names, never an actual browser URL, credential or path.
    const phase = (name: string): void => {
      console.log("B6_STAGE=" + name);
    };
    phase("chromium-discovery");
    const executablePath = findInstalledChromium();
    assert.ok(
      executablePath,
      "expected an installed compatible Chromium executable",
    );

    phase("fixture-start");
    const lab = await startBrowserLab();
    phase("fixture-ready");
    let temp: string | undefined;
    let backend: CdpBrowserBackend | undefined;
    try {
      temp = await mkdtemp(
        path.join(os.tmpdir(), "tetherplane-b6-"),
      );
      const uploadPath = path.join(temp, "upload.txt");
      await writeFile(
        uploadPath,
        "native-upload-content",
        "utf8",
      );

      phase("chromium-launch");
      // Fail with the launcher's own typed error and owned-process cleanup
      // before this 30-second test deadline; never increase the test budget.
      const control = await launchCdpOwnedBrowser({
        executablePath,
        launchTimeoutMs: 12_000,
        onStartupDiagnostic: event => console.log("CDP_STARTUP=" + JSON.stringify(event)),
      });
      phase("chromium-ready");
      backend = new CdpBrowserBackend({
        control,
        pollIntervalMs: 20,
      });
      const ownership = new BrowserOwnershipRegistry();
      const semantics = new SemanticSnapshotEngine();

      phase("create-tab");
      const page = await backend.createTab(lab.origin);
      phase("tab-created");
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

      phase("observe");
      const observed = await backend.observe(page.page_id);
      phase("observed");
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

      phase("native-upload");
      await operations.upload({
        page_id: page.page_id,
        mode: "background_only",
        target: upload.ref,
        file_path: uploadPath,
      });

      phase("wait-upload");
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

      phase("wait-diagnostics");
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

      phase("click-download");
      await backend.perform(page.page_id, {
        kind: "click",
        backend_id: semantics.reacquire(
          downloadLink.ref,
          (await backend.observe(page.page_id)).nodes,
        ).backend_id,
      });

      // Keep the original five-second completion contract. On failure,
      // report bounded event and final-file evidence rather than silently
      // retrying or treating an unfinished download as complete.
      phase("wait-download");
      const completedDownload = await waitUntil(async () => {
        const result = await operations.downloads({
          page_id: page.page_id,
        });
        return (
          result.downloads.find(
            (download) => download.state === "complete",
          ) ?? null
        );
      }).catch(async (cause: unknown) => {
        let diagnostic = "download observation unavailable";
        try {
          const observation = await operations.downloads({
            page_id: page.page_id,
          });
          diagnostic = JSON.stringify({
            truncated: observation.truncated,
            downloads: observation.downloads.slice(0, 10).map((download) => ({
              filename: download.filename.slice(0, 100),
              state: download.state,
              bytes_received: download.bytes_received,
              total_bytes: download.total_bytes,
              final_file_exists: download.local_path
                ? existsSync(download.local_path)
                : false,
            })),
          });
        } catch {
          // Preserve the primary timeout rather than hiding it with a
          // secondary observation failure.
        }
        throw new Error(
          "B6_DOWNLOAD_COMPLETION_UNVERIFIED " + diagnostic,
          { cause },
        );
      });
      phase("download-complete");
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

      phase("checkpoint");
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
      phase("cleanup-browser");
      try {
        await backend?.shutdown();
      } finally {
        phase("cleanup-lab");
        try {
          await lab.close();
        } finally {
          phase("cleanup-temp");
          if (temp) await rm(temp, { recursive: true, force: true });
          phase("cleanup-complete");
        }
      }
    }
  },
);
