import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test(
  "CDP fallback drives Browser Lab through an isolated Tetherplane-owned Chrome profile",
  { timeout: 45_000 },
  async () => {
    const executablePath = findInstalledChromium();
    assert.ok(
      executablePath,
      "expected an installed compatible Chromium executable",
    );

    const lab = await startBrowserLab();
    try {
      const control = await launchCdpOwnedBrowser({
        executablePath,
      });
      const profileDir = control.profile_dir;
      const backend = new CdpBrowserBackend({
        control,
        pollIntervalMs: 20,
      });

      try {
      assert.equal((await backend.pages()).length, 0);

      const page = await backend.createTab(lab.origin);
      assert.equal(page.active, false);
      assert.equal(page.ownership, "tetherplane");

      const pages = await backend.pages();
      assert.deepEqual(
        pages.map((item) => item.page_id),
        [page.page_id],
      );

      const observed = await backend.observe(page.page_id);
      const names = observed.nodes.map(
        (node) => node.accessible_name,
      );
      assert.ok(names.includes("Project value"));
      assert.ok(names.includes("Save"));
      assert.ok(names.includes("Frame action"));
      assert.ok(
        observed.nodes.some(
          (node) => node.frame_id !== "frame:top",
        ),
      );

      const semantics = new SemanticSnapshotEngine();
      const snapshot = semantics.snapshot(observed.nodes, {
        revision: observed.semantic_revision,
      });
      const input = snapshot.nodes.find(
        (node) =>
          node.role === "textbox" &&
          node.accessible_name === "Project value",
      );
      const save = snapshot.nodes.find(
        (node) =>
          node.role === "button" &&
          node.accessible_name === "Save",
      );
      assert.ok(input);
      assert.ok(save);

      const ownership = new BrowserOwnershipRegistry();
      ownership.register({
        page_id: page.page_id,
        ownership: "tetherplane",
        active: false,
      });
      const engine = new VerifiedActionEngine({
        backend,
        ownership,
        semantics,
      });

      const saved = await engine.execute({
        page_id: page.page_id,
        mode: "background_only",
        expected_resource_revision:
          observed.resource_revision,
        actions: [
          {
            kind: "fill",
            target: input.ref,
            value: "cdp-saved",
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
            equals: "cdp-saved",
          },
          {
            kind: "toast",
            includes: "Saved",
          },
          {
            kind: "resource_revision_changed",
            from: observed.resource_revision,
          },
          {
            kind: "validation_absent",
          },
        ],
        timeout_ms: 5_000,
      });

      assert.equal(saved.state, "verified");

      const persisted = await fetch(
        new URL("/api/state", lab.origin),
      );
      assert.equal(persisted.status, 200);
      const persistedState =
        (await persisted.json()) as Record<string, unknown>;
      assert.equal(persistedState.value, "cdp-saved");
      assert.equal(persistedState.revision, 2);

      const invalid = await engine.execute({
        page_id: page.page_id,
        mode: "background_only",
        actions: [
          {
            kind: "fill",
            target: input.ref,
            value: "",
          },
          {
            kind: "click",
            target: save.ref,
          },
        ],
        expectations: [
          {
            kind: "validation_absent",
          },
        ],
        timeout_ms: 5_000,
      });

      assert.equal(invalid.state, "failed");
      assert.equal(invalid.error?.code, "validation_failed");

      await backend.close(page.page_id);
      assert.equal((await backend.pages()).length, 0);
      } finally {
        await backend.shutdown();
      }

      assert.equal(existsSync(profileDir), false);
    } finally {
      await lab.close();
    }
  },
);


test(
  "CDP fallback performs real B6 upload download diagnostics and checkpoint operations",
  { timeout: 55_000 },
  async () => {
    const executablePath = findInstalledChromium();
    assert.ok(
      executablePath,
      "expected an installed compatible Chromium executable",
    );

    const lab = await startBrowserLab();
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "tetherplane-b6-upload-"),
    );
    try {
      const uploadPath = path.join(tempRoot, "fixture-upload.txt");
      await writeFile(uploadPath, "uploaded-through-cdp\n", "utf8");

      const control = await launchCdpOwnedBrowser({
        executablePath,
      });
      const backend = new CdpBrowserBackend({
        control,
        pollIntervalMs: 20,
      });
      const ownership = new BrowserOwnershipRegistry();
      const semantics = new SemanticSnapshotEngine();
      const operations = new BrowserOperationalEngine({
        backend,
        ownership,
        semantics,
      });

      try {
      const page = await backend.createTab(lab.origin);
      ownership.register({
        page_id: page.page_id,
        ownership: "tetherplane",
        active: false,
      });

      const observed = await backend.observe(page.page_id);
      const snapshot = semantics.snapshot(observed.nodes, {
        revision: observed.semantic_revision,
      });
      const uploadNode = snapshot.nodes.find(
        (node) => node.accessible_name === "Fixture upload",
      );
      const downloadNode = snapshot.nodes.find(
        (node) => node.accessible_name === "Download fixture",
      );
      assert.ok(uploadNode);
      assert.ok(downloadNode);

      const uploaded = await operations.upload({
        page_id: page.page_id,
        mode: "background_only",
        target: uploadNode.ref,
        file_path: uploadPath,
      });
      assert.deepEqual(uploaded, {
        uploaded: true,
        page_id: page.page_id,
      });

      const uploadedState = await waitForValue(
        async () => {
          const response = await fetch(
            new URL("/api/upload-state", lab.origin),
          );
          assert.equal(response.status, 200);
          const state =
            (await response.json()) as Record<string, unknown>;
          return state.last_upload === "uploaded-through-cdp\n"
            ? state
            : null;
        },
        5_000,
      );
      assert.equal(
        uploadedState.last_upload,
        "uploaded-through-cdp\n",
      );

      const checkpoint = await operations.checkpoint({
        page_id: page.page_id,
        mode: "background_only",
      });
      assert.equal(checkpoint.page_id, page.page_id);
      assert.equal(checkpoint.ownership, "tetherplane");
      assert.ok(
        checkpoint.form_state.some(
          (entry) =>
            entry.accessible_name === "Project value" &&
            entry.value === "initial",
        ),
      );
      assert.equal(
        JSON.stringify(checkpoint).includes(uploadPath),
        false,
      );

      const current = await backend.observe(page.page_id);
      const resolvedDownload = semantics.reacquire(
        downloadNode.ref,
        current.nodes,
      );
      await backend.perform(page.page_id, {
        kind: "click",
        backend_id: resolvedDownload.backend_id,
      });

      const completedDownload = await waitForValue(
        async () => {
          const result = await operations.downloads({
            page_id: page.page_id,
          });
          return (
            result.downloads.find(
              (download) =>
                download.filename ===
                  "browser-lab-download.txt" &&
                download.state === "complete",
            ) ?? null
          );
        },
        8_000,
      );
      assert.ok(completedDownload.local_path);
      assert.equal(
        await readFile(completedDownload.local_path, "utf8"),
        "browser-lab-download\n",
      );

      const diagnosticsPage = await backend.createTab(lab.origin);
      ownership.register({
        page_id: diagnosticsPage.page_id,
        ownership: "tetherplane",
        active: false,
      });
      await operations.diagnostics({
        page_id: diagnosticsPage.page_id,
        limit: 50,
      });

      await backend.navigate(
        diagnosticsPage.page_id,
        new URL("/api/fail", lab.origin).toString(),
      );

      const failureDiagnostic = await waitForValue(
        async () => {
          const result = await operations.diagnostics({
            page_id: diagnosticsPage.page_id,
            limit: 50,
          });
          return (
            result.events.find(
              (event) => event.response_status === 503,
            ) ?? null
          );
        },
        5_000,
      );
      assert.equal(failureDiagnostic.response_status, 503);
      assert.equal(
        JSON.stringify(failureDiagnostic).includes("authorization"),
        false,
      );
      } finally {
        await backend.shutdown();
      }
    } finally {
      await lab.close();
      await rm(tempRoot, {
        recursive: true,
        force: true,
      });
    }
  },
);

async function waitForValue<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("timed out waiting for Browser Lab state");
}
