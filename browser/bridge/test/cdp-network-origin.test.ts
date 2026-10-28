import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  CdpBrowserBackend,
  findInstalledChromium,
  launchCdpOwnedBrowser,
} from "../src/index.ts";
import { CdpLabOnlyBridgeService } from "../src/cdp-lab-service.ts";
import {
  GRANTABLE_LAB_OPERATIONS,
  LocalBrowserLabGrant,
} from "../src/local-lab-grant.ts";

type LocalServer = http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;

async function listen(server: LocalServer): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing local server port"));
      } else {
        resolve(address.port);
      }
    });
  });
}

async function stop(server: LocalServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

test(
  "CDP request-stage guard blocks off-origin fetch and image without blocking allowed fixture",
  { timeout: 65_000 },
  async () => {
    let forbiddenHits = 0;
    let allowedAjaxHits = 0;

    const forbidden = http.createServer((_request, response) => {
      forbiddenHits += 1;
      response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      response.end("must-not-receive-traffic");
    });
    const forbiddenPort = await listen(forbidden);

    const allowed = http.createServer((request, response) => {
      if (request.url === "/allowed") {
        allowedAjaxHits += 1;
        response.writeHead(200);
        response.end("same-origin-ok");
        return;
      }
      const html =
        '<!doctype html><html><body><button onclick="fetch(' +
        "'/allowed'" +
        ").catch(()=>{});fetch('http://127.0.0.1:" +
        String(forbiddenPort) +
        "/probe',{mode:'no-cors'}).catch(()=>{})" +
        '">Probe both</button><img src="http://127.0.0.1:' +
        String(forbiddenPort) +
        '/pixel" /></body></html>';
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html);
    });
    const allowedPort = await listen(allowed);
    const origin = "http://127.0.0.1:" + String(allowedPort);

    const executable = findInstalledChromium();
    assert.ok(executable, "Chromium required for real security acceptance");
    const control = await launchCdpOwnedBrowser({
      executablePath: executable,
      networkOrigin: origin,
    });
    const backend = new CdpBrowserBackend({ control });
    try {
      const grant = new LocalBrowserLabGrant({
        origin,
        operations: GRANTABLE_LAB_OPERATIONS,
        expiresAtMs: Date.now() + 60_000,
      });
      const service = new CdpLabOnlyBridgeService({
        backend,
        labOrigin: origin,
        grant,
      });
      const page = await service.invoke("browser.create_tab", { url: origin });
      const id = String((page.data as { page_id: string }).page_id);
      const observation = await service.invoke("browser.snapshot", {
        page_id: id,
      });
      const nodes = (observation.data as {
        nodes: Array<{
          role: string;
          accessible_name: string;
          ref?: unknown;
        }>;
      }).nodes;
      const trigger = nodes.find(
        (node) => node.role === "button" &&
          node.accessible_name === "Probe both",
      );
      assert.ok(trigger?.ref, "button must be observable before test");

      await service.invoke("browser.act", {
        page_id: id,
        mode: "background_only",
        actions: [{ kind: "click", target: trigger.ref }],
      });
      await delay(500);
      assert.ok(allowedAjaxHits > 0, "same-origin fetch must be allowed");
      assert.equal(
        forbiddenHits,
        0,
        "cross-origin requests must be stopped before reaching destination",
      );
      await assert.rejects(
        backend.navigate(id, "http://127.0.0.1:" + String(forbiddenPort) + "/other"),
      );
      assert.equal(forbiddenHits, 0);
    } finally {
      await backend.shutdown();
      await stop(allowed);
      await stop(forbidden);
    }
  },
);

test("request guard cannot be enabled for a public or credentialed origin", async () => {
  for (const origin of [
    "https://www.amazon.com",
    "http://127.0.0.1",
    "http://user:password@127.0.0.1:49123",
    "http://localhost.example.com:49123",
  ]) {
    await assert.rejects(
      launchCdpOwnedBrowser({ networkOrigin: origin }),
      TypeError,
    );
  }
});
