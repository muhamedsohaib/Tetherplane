import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

export async function readChromiumBrowserEndpoint(profileDir: string): Promise<{ port: number; browserPath: string }> {
  const content = await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8");
  const [first = "", browserPath = ""] = content.split(/\r?\n/);
  const port = Number(first);
  if (!/^[0-9]+$/.test(first) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid Chromium debugging port in the test profile");
  }
  return { port, browserPath };
}

/** Read only the port assigned to this freshly created, test-owned profile. */
export async function readChromiumDevToolsPort(profileDir: string): Promise<number> {
  return (await readChromiumBrowserEndpoint(profileDir)).port;
}

/**
 * Shut down the browser through its private browser endpoint even when Chrome's
 * launcher has exited and reparented the real browser. Never rediscover a target
 * by port alone, enumerate arbitrary browsers, or silently swallow cleanup failure.
 */
export async function closeChromiumFromProfile(profileDir: string, timeoutMs = 10_000): Promise<void> {
  const { port, browserPath } = await readChromiumBrowserEndpoint(profileDir);
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath)) {
    throw new Error("invalid Chromium browser endpoint in the test profile");
  }
  const deadline = Date.now() + timeoutMs;
  const socket = new WebSocket("ws://127.0.0.1:" + port + browserPath);
  try {
    await new Promise<void>((resolve, reject) => {
      let sent = false;
      const timer = setTimeout(() => reject(new Error("Chromium cleanup timed out waiting for browser shutdown")), timeoutMs);
      const done = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      socket.once("error", (error) => done(error));
      socket.once("open", () => {
        sent = true;
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      });
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as { id?: number; error?: { message?: string } };
          if (message.id === 1 && message.error) {
            done(new Error(message.error.message ?? "Chromium rejected browser shutdown"));
          }
        } catch { done(new Error("invalid Chromium shutdown response")); }
      });
      socket.once("close", () => done(sent ? undefined : new Error("Chromium closed before shutdown was requested")));
    });
    // A CDP acknowledgement or disconnected socket alone is not cleanup proof:
    // the browser must also stop listening, and a timeout is not a closed port.
    while (Date.now() < deadline) {
      const closed = await new Promise<boolean>((resolve) => {
        const probe = createConnection({ host: "127.0.0.1", port });
        const finish = (value: boolean) => { probe.destroy(); resolve(value); };
        probe.once("connect", () => finish(false));
        probe.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED"));
        probe.setTimeout(Math.max(1, Math.min(200, deadline - Date.now())), () => finish(false));
      });
      if (closed) return;
      await delay(Math.min(25, Math.max(0, deadline - Date.now())));
    }
    throw new Error("Chromium cleanup timed out: owned debugger did not close");
  } finally {
    socket.terminate();
  }
}

type Cleanup = () => void | Promise<void>;
export async function withChromiumTestResources<T>(
  body: (defer: (cleanup: Cleanup) => void) => Promise<T>,
): Promise<T> {
  const resources: Cleanup[] = [];
  let failed = false;
  let original: unknown;
  try {
    return await body((cleanup) => resources.push(cleanup));
  } catch (error) {
    failed = true;
    original = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const cleanup of resources.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      const causes = [...(failed ? [original] : []), ...errors];
      const summary = causes.map((cause) => {
        const message = cause instanceof Error ? cause.message : "unknown resource failure";
        return message.replace(/https?:\/\/[^\s]+/g, "[redacted-url]")
          .replace(/(?:bearer\s+|token[=:]\s*)[^\s]+/gi, "[redacted-secret]")
          .slice(0, 250);
      }).join("; ").slice(0, 600);
      throw new AggregateError(causes, "Chromium test resource cleanup failed: " + summary);
    }
  }
}

export type TestCdp = {
  send<T = unknown>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (method: string, text: string) => void): void;
  close(): void;
};

/** Bounded test-only CDP transport; disconnect rejects all outstanding calls. */
export async function connectTestCdp(url: string, timeoutMs = 5000): Promise<TestCdp> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.terminate();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("CDP connection timed out")), timeoutMs);
    const closed = () => fail(new Error("CDP connection closed during startup"));
    socket.once("error", fail);
    socket.once("close", closed);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.off("error", fail);
      socket.off("close", closed);
      resolve();
    });
  });
  let nextId = 1;
  const pending = new Map<number, {
    resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout;
  }>();
  const listeners = new Set<(method: string, text: string) => void>();
  const rejectAll = (error: Error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  socket.on("error", rejectAll);
  socket.on("close", () => rejectAll(new Error("CDP connection closed")));
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw)) as {
        id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string };
      };
      if (typeof message.id === "number") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"));
        else entry.resolve(message.result);
      } else if (message.method) {
        for (const listener of listeners) listener(message.method, JSON.stringify(message.params ?? null).slice(0, 300));
      }
    } catch {
      rejectAll(new Error("invalid CDP response"));
      socket.terminate();
    }
  });
  return {
    send<T>(method: string, params?: unknown): Promise<T> {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP connection closed"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("CDP request timed out: " + method));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        socket.send(JSON.stringify({ id, method, params }), (error) => {
          if (!error) return;
          const entry = pending.get(id);
          if (entry) { clearTimeout(entry.timer); pending.delete(id); entry.reject(error); }
        });
      });
    },
    onEvent(listener) { listeners.add(listener); },
    close() {
      rejectAll(new Error("CDP connection closed"));
      listeners.clear();
      socket.terminate();
    },
  };
}
