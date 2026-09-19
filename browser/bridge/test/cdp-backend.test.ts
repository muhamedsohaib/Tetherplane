import assert from "node:assert/strict";
import test from "node:test";

import {
  CdpBackendError,
  CdpBrowserBackend,
  buildIsolatedChromiumArgs,
  type CdpControl,
  type CdpFrame,
  type CdpFrameObservation,
  type CdpTargetInfo,
} from "../src/index.ts";

class FakeCdpControl implements CdpControl {
  readonly targets = new Map<string, CdpTargetInfo>();
  readonly created: Array<{ url: string; background: boolean }> = [];
  readonly closed: string[] = [];
  readonly navigations: Array<{ targetId: string; url: string }> = [];
  readonly performed: Array<{
    targetId: string;
    frameId: string;
    selectorToken: string;
    action: Record<string, unknown>;
  }> = [];
  frameList: CdpFrame[] = [
    {
      frame_id: "top",
      document_id: "loader-top",
      parent_frame_id: null,
    },
  ];
  observations = new Map<string, CdpFrameObservation>();
  nextTarget = 1;

  async createTarget(
    url: string,
    background: boolean,
  ): Promise<string> {
    this.created.push({ url, background });
    const targetId = `target-${this.nextTarget++}`;
    this.targets.set(targetId, {
      target_id: targetId,
      type: "page",
      url,
    });
    return targetId;
  }

  async listTargets(): Promise<CdpTargetInfo[]> {
    return [...this.targets.values()].map((item) =>
      structuredClone(item),
    );
  }

  async closeTarget(targetId: string): Promise<void> {
    this.closed.push(targetId);
    this.targets.delete(targetId);
  }

  async navigateTarget(
    targetId: string,
    url: string,
  ): Promise<void> {
    this.navigations.push({ targetId, url });
    const target = this.targets.get(targetId);
    if (target) {
      target.url = url;
    }
  }

  async frames(_targetId: string): Promise<CdpFrame[]> {
    return this.frameList.map((frame) => structuredClone(frame));
  }

  async observeFrame(
    _targetId: string,
    frameId: string,
  ): Promise<CdpFrameObservation> {
    const observed = this.observations.get(frameId);
    if (!observed) {
      throw new Error(`missing observation for ${frameId}`);
    }
    return structuredClone(observed);
  }

  async performFrame(
    targetId: string,
    frameId: string,
    selectorToken: string,
    action: Record<string, unknown>,
  ): Promise<void> {
    this.performed.push({
      targetId,
      frameId,
      selectorToken,
      action: structuredClone(action),
    });
  }

  async close(): Promise<void> {}
}

function observation(
  overrides: Partial<CdpFrameObservation> = {},
): CdpFrameObservation {
  return {
    url: "https://fixture.example/editor",
    semantic_revision: 1,
    resource_revision: "1",
    nodes: [
      {
        backend_id: "css:#value-input",
        role: "textbox",
        accessible_name: "Project value",
        value: "initial",
      },
    ],
    validation_messages: [],
    toasts: [],
    ...overrides,
  };
}

test("CDP fallback advertises reduced Tetherplane-owned capability surface truthfully", () => {
  const backend = new CdpBrowserBackend({
    control: new FakeCdpControl(),
  });

  assert.deepEqual(backend.capabilities(), {
    backend: "cdp",
    ownership: "tetherplane_only",
    operations: [
      "pages",
      "create_tab",
      "snapshot",
      "act",
      "wait",
      "navigate",
      "close",
    ],
    unavailable_operations: [
      "attach",
      "detach",
      "upload",
      "downloads",
      "diagnostics",
      "checkpoint",
    ],
  });
});

test("isolated Chromium args always use a dedicated profile and ephemeral debugging port", () => {
  const args = buildIsolatedChromiumArgs(
    "C:\\Temp\\tetherplane-cdp-profile",
  );

  assert.ok(
    args.includes(
      "--user-data-dir=C:\\Temp\\tetherplane-cdp-profile",
    ),
  );
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--no-first-run"));
  assert.equal(
    args.some((arg) => /remote-debugging-address/i.test(arg)),
    false,
  );
  assert.equal(
    args.some((arg) => /user-data-dir=.*Chrome\\User Data/i.test(arg)),
    false,
  );
});

test("CDP backend creates only owned background targets and rejects unknown targets", async () => {
  const control = new FakeCdpControl();
  const backend = new CdpBrowserBackend({ control });

  const page = await backend.createTab(
    "https://fixture.example/editor",
  );

  assert.equal(page.ownership, "tetherplane");
  assert.equal(page.active, false);
  assert.deepEqual(control.created, [
    {
      url: "https://fixture.example/editor",
      background: true,
    },
  ]);

  await backend.navigate(
    page.page_id,
    "https://fixture.example/next",
  );
  assert.deepEqual(control.navigations, [
    {
      targetId: "target-1",
      url: "https://fixture.example/next",
    },
  ]);

  await assert.rejects(
    () =>
      backend.navigate(
        "cdp:human-target",
        "https://blocked.example/",
      ),
    (error: unknown) =>
      error instanceof CdpBackendError &&
      error.code === "permission_denied",
  );
});

test("CDP semantic observation preserves frame and document identity", async () => {
  const control = new FakeCdpControl();
  control.frameList = [
    {
      frame_id: "top",
      document_id: "loader-top",
      parent_frame_id: null,
    },
    {
      frame_id: "child",
      document_id: "loader-child",
      parent_frame_id: "top",
    },
  ];
  control.observations.set(
    "top",
    observation({
      semantic_revision: 4,
      toasts: ["Saved"],
    }),
  );
  control.observations.set(
    "child",
    observation({
      url: "https://fixture.example/frame",
      semantic_revision: 2,
      resource_revision: null,
      nodes: [
        {
          backend_id: "css:#frame-action",
          role: "button",
          accessible_name: "Frame action",
        },
      ],
    }),
  );

  const backend = new CdpBrowserBackend({ control });
  const page = await backend.createTab(
    "https://fixture.example/editor",
  );
  const observed = await backend.observe(page.page_id);

  assert.equal(observed.nodes.length, 2);
  assert.equal(observed.nodes[0]?.frame_id, "frame:top");
  assert.equal(observed.nodes[0]?.document_id, "loader-top");
  assert.equal(
    observed.nodes[0]?.backend_id,
    "frame:top|css:#value-input",
  );
  assert.equal(observed.nodes[1]?.frame_id, "frame:child");
  assert.equal(observed.nodes[1]?.document_id, "loader-child");
  assert.equal(
    observed.nodes[1]?.backend_id,
    "frame:child|css:#frame-action",
  );
  assert.deepEqual(observed.toasts, ["Saved"]);
});

test("CDP semantic action returns to the exact observed frame", async () => {
  const control = new FakeCdpControl();
  control.observations.set("top", observation());
  const backend = new CdpBrowserBackend({ control });
  const page = await backend.createTab(
    "https://fixture.example/editor",
  );

  await backend.perform(page.page_id, {
    kind: "fill",
    backend_id: "frame:top|css:#value-input",
    value: "updated",
  });

  assert.deepEqual(control.performed, [
    {
      targetId: "target-1",
      frameId: "top",
      selectorToken: "css:#value-input",
      action: {
        kind: "fill",
        backend_id: "frame:top|css:#value-input",
        value: "updated",
      },
    },
  ]);
});
