import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { startBrowserLab } from "@tetherplane/browser-lab";

import {
  BrowserOwnershipRegistry,
  CdpBrowserBackend,
  SemanticSnapshotEngine,
  VerifiedActionEngine,
  findInstalledChromium,
  launchCdpOwnedBrowser,
} from "../src/index.ts";

test(
  "CDP fallback drives Browser Lab through an isolated Tetherplane-owned Chrome profile",
  { timeout: 30_000 },
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
      await lab.close();
    }

    assert.equal(existsSync(profileDir), false);
  },
);
