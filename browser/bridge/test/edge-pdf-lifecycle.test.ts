import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import {
  CdpBrowserBackend,
  launchCdpOwnedBrowser,
  type LaunchedCdpControl,
} from "../src/index.ts";

const PDF_MARKER = "Tetherplane isolated Edge PDF lifecycle proof";

function installedEdgePath(): string | null {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFiles86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const candidates = [
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles86, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

type CdpReply = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

let nextCdpId = 1;
function sendCdp(
  socket: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): Promise<Record<string, unknown>> {
  const id = nextCdpId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for CDP " + method));
    }, 15_000);
    const onMessage = (data: WebSocket.RawData) => {
      let response: CdpReply;
      try {
        response = JSON.parse(String(data)) as CdpReply;
      } catch {
        return;
      }
      if (response.id !== id) return;
      cleanup();
      if (response.error) {
        reject(new Error(method + ": " + (response.error.message ?? "CDP error")));
        return;
      }
      resolve(response.result ?? {});
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
    socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
      (error) => {
        if (error) {
          cleanup();
          reject(error);
        }
      },
    );
  });
}

async function connectOwnedBrowser(profileDir: string): Promise<WebSocket> {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  const [portText, endpoint] = (await readFile(portFile, "utf8"))
    .trim()
    .split(/\r?\n/);
  const port = Number(portText);
  assert.ok(Number.isInteger(port) && port > 0, "valid CDP loopback port");
  assert.ok(endpoint?.startsWith("/devtools/browser/"), "expected browser-owned CDP endpoint");

  const socket = new WebSocket("ws://127.0.0.1:" + port + endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

test(
  "installed Windows Edge CDP launches, prints a PDF and fully closes its isolated profile",
  { skip: process.platform !== "win32", timeout: 120_000 },
  async (t) => {
    const executablePath = installedEdgePath();
    assert.ok(executablePath, "Windows Edge executable must exist on Windows CI");
    const root = await mkdtemp(path.join(os.tmpdir(), "tetherplane-edge-pdf-"));
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        "<!doctype html><html><head><meta charset='utf-8'>" +
          "<style>@page { size: A4; margin: 20mm; }</style></head>" +
          "<body><h1>" + PDF_MARKER + "</h1><p>Local test fixture only.</p></body></html>",
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    let control: LaunchedCdpControl | null = null;
    let pdfSocket: WebSocket | null = null;
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const url = "http://127.0.0.1:" + address.port + "/";
      control = await launchCdpOwnedBrowser({
        executablePath,
        profileParent: root,
        launchTimeoutMs: 60_000,
      });
      const profile = control.profile_dir;
      assert.ok(profile.startsWith(root + path.sep));
      const backend = new CdpBrowserBackend({ control });
      const page = await backend.createTab(url);
      assert.equal(page.ownership, "tetherplane");
      assert.equal(page.active, false);
      const observed = await backend.observe(page.page_id);
      assert.ok(
        observed.nodes.some((node) => node.accessible_name.includes(PDF_MARKER)),
        "test content must be visible via first-party CDP observation",
      );

      // Experiment only: a second loopback connection prints the page,
      // without introducing an unreviewed public browser/PDF operation.
      pdfSocket = await connectOwnedBrowser(profile);
      const attached = await sendCdp(pdfSocket, "Target.attachToTarget", {
        targetId: page.page_id.slice("cdp:".length),
        flatten: true,
      });
      assert.equal(typeof attached.sessionId, "string");
      const sessionId = attached.sessionId as string;
      await sendCdp(pdfSocket, "Page.enable", {}, sessionId);
      const printed = await sendCdp(
        pdfSocket,
        "Page.printToPDF",
        { printBackground: true, preferCSSPageSize: true },
        sessionId,
      );
      assert.equal(typeof printed.data, "string");
      const pdf = Buffer.from(printed.data as string, "base64");
      assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
      assert.ok(pdf.length >= 1_024, "PDF must have substantive content");
      assert.ok(pdf.length <= 2_000_000, "PDF output must remain bounded");
      assert.ok(pdf.subarray(-2_048).toString("latin1").includes("%%EOF"));
      t.diagnostic(
        "edge_pdf_bytes=" + pdf.length +
          " installed_edge=" + path.basename(executablePath) +
          " no_browser_installer_invoked=true",
      );

      pdfSocket.close();
      pdfSocket = null;
      await backend.shutdown();
      control = null;
      assert.equal(existsSync(profile), false, "owned profile cleaned up");
    } finally {
      if (pdfSocket) pdfSocket.terminate();
      if (control) await control.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
