// All CDP browsers must have a bounded shutdown path. An unresponsive
// Browser.close request must not prevent child-process termination and
// disposable-profile cleanup. This is distinct from crash-time OS supervision.
export const CDP_BROWSER_CLOSE_TIMEOUT_MS = 2_000;

export type BrowserCloseTransport = {
  send(method: string): Promise<unknown>;
  close(): void;
};

export async function closeBrowserTransportWithDeadline(
  transport: BrowserCloseTransport,
  timeoutMs = CDP_BROWSER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError("invalid CDP browser close timeout");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => transport.send("Browser.close"))
        .then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    transport.close();
  }
}
