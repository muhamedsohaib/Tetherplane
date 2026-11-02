import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";
import { startBrowserLab } from "@tetherplane/browser-lab";
import { startLocalCompact } from "./helpers/start-local.ts";
import {
  CdpBrowserBackend,
  findInstalledChromium,
  launchCdpOwnedBrowser,
  startBrowserRpcServer,
} from "../../browser/bridge/src/index.ts";
import { CdpLabOnlyBridgeService } from "../../browser/bridge/src/cdp-lab-service.ts";
import { startCdpLabProxy } from "../../browser/bridge/src/cdp-lab-proxy.ts";
import {
  GRANTABLE_LAB_OPERATIONS,
  LocalBrowserLabGrant,
} from "../../browser/bridge/src/local-lab-grant.ts";

test("real installed Rust agent exposes extension-free, origin-guarded CDP through MCP", {timeout: 90000, skip: !process.env.TETHERPLANE_TEST_TETHERD && "requires explicit local test binary"}, async () => {
  const binary = process.env.TETHERPLANE_TEST_TETHERD;
  assert.ok(binary && existsSync(binary), "set TETHERPLANE_TEST_TETHERD to real installed tetherd.exe");
  const edge = findInstalledChromium();
  assert.ok(edge, "real installed Chromium/Edge required");

  const lab = await startBrowserLab();
  const grant = new LocalBrowserLabGrant({
    origin: lab.origin,
    operations: GRANTABLE_LAB_OPERATIONS,
    expiresAtMs: Date.now() + 12 * 60_000,
  });
  let proxy, backend, bridge, local;
  const token = randomBytes(32).toString("hex");
  try {
    proxy = await startCdpLabProxy({
      approvedOrigin: lab.origin,
      canForward: () => grant.isActive,
    });
    const control = await launchCdpOwnedBrowser({
      executablePath: edge,
      networkOrigin: lab.origin,
      labProxyPort: proxy.port,
    });
    backend = new CdpBrowserBackend({
      control,
      authorizeSite: (op, url) => grant.authorize(op, url),
    });
    const service = new CdpLabOnlyBridgeService({
      backend,
      labOrigin: lab.origin,
      grant,
    });
    bridge = await startBrowserRpcServer({
      host: "127.0.0.1",
      port: 0,
      token,
      service,
    });
    local = await startLocalCompact({
      tetherdPath: binary,
      browserBridge: {address: bridge.address, token},
    });
    const listed = await local.client.listTools();
    assert.ok(listed.tools.some(tool => tool.name === "browser"), "MCP browser tool missing");
    const invoke = async (op, args={}) => {
      const result = await local.client.callTool({
        name: "browser",
        arguments: {op, args},
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent;
    };
    const status = await invoke("status");
    assert.equal(status.available, true);
    assert.equal(status.capabilities.backend, "cdp");
    assert.equal(status.capabilities.experimental_local_lab_only, true);
    assert.equal(status.capabilities.ownership, "tetherplane_only");

    const denied = await local.client.callTool({
      name: "browser",
      arguments: {op:"create_tab", args:{url:"https://example.com/"}},
    });
    assert.equal(denied.isError, true, "unapproved origin must be denied");
    assert.match(JSON.stringify(denied), /permission_denied/);

    const created = await invoke("create_tab", {url:lab.origin});
    assert.equal(created.ownership, "tetherplane");
    const snap = await invoke("snapshot", {page_id:created.page_id});
    const textbox = snap.nodes.find(n=>n.role==="textbox" && n.accessible_name==="Project value");
    const save = snap.nodes.find(n=>n.role==="button" && n.accessible_name==="Save");
    assert.ok(textbox?.ref && save?.ref, "fixture semantic references missing");

    const action = await invoke("act", {
      page_id:created.page_id,
      mode:"background_only",
      actions:[
        {kind:"fill", target:textbox.ref, value:"leno-secure-bridge-verified"},
        {kind:"click", target:save.ref}
      ],
      expectations:[{kind:"toast",includes:"Saved"}],
      timeout_ms:8000,
    });
    assert.equal(action.state, "verified");
    const serverState = await (await fetch(new URL("/api/state",lab.origin))).json();
    assert.equal(serverState.value, "leno-secure-bridge-verified");

    const rejected = await local.client.callTool({
      name:"browser",
      arguments:{op:"navigate",args:{page_id:created.page_id,url:"https://example.com/"}},
    });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected), /permission_denied/);

    const closed = await invoke("close",{page_id:created.page_id});
    assert.equal(closed.closed,true);
    grant.revoke();
    assert.equal((await service.invoke("browser.status",{})).data.available,false);
    console.log("VERIFIED: local Rust MCP + CDP + exact-origin authorization + action + denial + revoke");
  } finally {
    grant.revoke();
    await local?.close().catch(()=>undefined);
    await bridge?.close().catch(()=>undefined);
    await backend?.shutdown().catch(()=>undefined);
    await proxy?.close().catch(()=>undefined);
    await lab.close().catch(()=>undefined);
  }
});
