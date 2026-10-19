import { test, expect } from "@playwright/test";
import {
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "@tetherplane/relay";
import { ControlCenterServer } from "../src/server.ts";

let relay: RelayServer;
let portal: ControlCenterServer;
let base: string;
test.beforeEach(async () => {
  relay = await RelayServer.create({
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([
      {
        token: "browser-fixture-a",
        accountId: "a",
        clientId: "test",
        principalId: "human:a",
      },
      {
        token: "browser-fixture-empty",
        accountId: "empty",
        clientId: "test",
        principalId: "human:empty",
      },
    ]),
  });
  const pending = await relay.registry.startPairing({
    deviceId: "fixture-device",
    credentialHash: hashDeviceCredential("synthetic-browser-device-credential"),
  });
  await relay.registry.approvePairing({
    accountId: "a",
    userCode: pending.userCode,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  portal = new ControlCenterServer({ relayUrl: address.httpUrl });
  base = await portal.listen({ port: 0 });
});
test.afterEach(async () => {
  await portal.close();
  await relay.close();
});

async function navigate(page: import("@playwright/test").Page, view: "home" | "devices" | "access" | "pairing" | "settings") {
  await page.locator('#main-nav [data-view="' + view + '"]').click();
}

test("authorized directory, exact revoke confirmation and sign-out work through the real relay", async ({
  page,
}) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await navigate(page, "devices");
  await expect(page.locator("#view-devices h1")).toContainText("Your devices");
  await expect(page.locator("#view-devices").getByRole("heading", { name: "fixture-device", exact: true })).toBeVisible();
  await expect(
    page.locator("#view-devices").getByText("Connectivity not reported", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Relay access credential")).toHaveValue("");
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).length + Object.keys(sessionStorage).length,
    ),
  ).toBe(0);
  await navigate(page, "access");
  await page.locator("#view-access")
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Revoke access", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Type device ID to confirm").fill("fixture-device");
  await dialog
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#view-access .badge")).toHaveText("Revoked");
  expect(relay.registry.getDevice("fixture-device")!.revokedAt).not.toBeNull();
  await navigate(page, "settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("fixture-device", { exact: true }),
  ).not.toBeVisible();
});

test("invalid credential and empty account never render invented devices", async ({
  page,
}) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("wrong");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/denied|authorized/i);
  await page
    .getByLabel("Relay access credential")
    .fill("browser-fixture-empty");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await navigate(page, "devices");
  await expect(page.locator("#empty").getByRole("heading", { name: "No devices are paired to this account." })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Revoke access", exact: true }),
  ).toHaveCount(0);
});

test("failed refresh clears stale records and a later refresh can recover", async ({
  page,
}) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await navigate(page, "devices");
  await expect(page.locator("#view-devices").getByRole("heading", { name: "fixture-device" })).toBeVisible();
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: '{"error":{"code":"relay_unavailable","message":"Relay unavailable. Try refreshing."}}',
    }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Relay unavailable");
  await expect(page.locator("#view-devices .device-card")).toHaveCount(0);
  await page.unroute("**/api/devices");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#view-devices").getByRole("heading", { name: "fixture-device" })).toBeVisible();
});

test("approved static ASCII branding loads without mobile overflow", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await expect(page.locator("#brand-field")).toBeVisible();
  const image = await page.locator("#brand-field").evaluate(el => getComputedStyle(el).backgroundImage);
  expect(image).toContain("/assets/ascii/approved-background.svg");
  const asset = await page.request.get(base + "/assets/ascii/approved-background.svg");
  expect(asset.ok()).toBe(true);
  await expect(page.locator("#loading")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/control-center-mobile.png", fullPage: true });
});

test("failed revoke leaves its error visible and does not replay the operation", async ({
  page,
}) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await navigate(page, "access");
  await page.locator("#view-access")
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type device ID to confirm").fill("fixture-device");
  let attempts = 0;
  await page.route("**/api/devices/*/revoke", (route) => {
    attempts++;
    return route.fulfill({
      status: 502,
      contentType: "application/json",
      body: '{"error":{"code":"relay_unavailable","message":"Result uncertain. Refresh before retrying."}}',
    });
  });
  await dialog
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Result uncertain");
  expect(attempts).toBe(1);
  expect(relay.registry.getDevice("fixture-device")!.revokedAt).toBeNull();
});

test("sign-out during an in-flight refresh cannot restore the cleared directory", async ({
  page,
}) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await navigate(page, "devices");
  await expect(page.locator("#view-devices").getByRole("heading", { name: "fixture-device" })).toBeVisible();
  let release!: () => void;
  let started!: () => void;
  const pendingRequest = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/devices", async (route) => {
    started();
    await gate;
    await route.continue().catch(() => {});
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await pendingRequest;
  const loggedOut = page.waitForResponse((response) =>
    response.url().endsWith("/api/logout"),
  );
  // Programmatic click deliberately probes a sign-out race while the full-screen loader blocks human input.
  await page.evaluate(() => (document.getElementById("signout") as HTMLButtonElement).click());
  await loggedOut;
  release();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#view-devices").getByRole("heading", { name: "fixture-device" }),
  ).not.toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

test("brief operations use no splash and delayed loading uses the same static art", async ({ page }) => {
  await page.goto(base);
  await expect(page.locator("#loading")).toBeHidden();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release=resolve; });
  await page.route("**/api/session", async route => {
    if(route.request().method()==="POST") await gate;
    await route.continue().catch(() => {});
  });
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#loading")).toBeVisible();
  const image = await page.locator("#loading").evaluate(el => getComputedStyle(el).backgroundImage);
  expect(image).toContain("/assets/ascii/approved-background.svg");
  await expect(page.locator("#pause-motion, #loading-base, #loading-overlay")).toHaveCount(0);
  release();
  await expect(page.locator("#loading")).toBeHidden();
});

test("device-side pairing, revocation and fresh re-pairing use the real authenticated directory", async ({ page }) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("browser-fixture-empty");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const pair = async (secret: string) => {
    await navigate(page, "pairing");
    const pending = await relay.registry.startPairing({ deviceId: "new-device", credentialHash: hashDeviceCredential(secret) });
    await page.getByLabel("Device pairing code", { exact: true }).fill(pending.userCode.toLowerCase());
    await page.getByLabel("I requested this code on a device I am authorized to manage.").check();
    await page.getByRole("button", { name: "Approve pairing", exact: true }).click();
    await expect(page.getByLabel("Device pairing code", { exact: true })).toHaveValue("");
    await expect(page.getByRole("heading", { name: "new-device", exact: true })).toBeVisible();
  };
  await pair("browser-first-synthetic-device-secret");
  expect(await relay.registry.authenticateDevice("new-device", "browser-first-synthetic-device-secret")).toBe("empty");
  await navigate(page, "access");
  await page.locator("#view-access").getByRole("button", { name: "Revoke access", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type device ID to confirm").fill("new-device");
  await dialog.getByRole("button", { name: "Revoke access", exact: true }).click();
  await expect(page.locator("#view-access .badge")).toHaveText("Revoked");
  await expect(page.locator("#view-access").getByText("Fresh authorized pairing required", { exact: true })).toBeVisible();
  expect(await relay.registry.authenticateDevice("new-device", "browser-first-synthetic-device-secret")).toBeNull();
  await pair("browser-fresh-synthetic-device-secret");
  await expect(page.locator("#view-devices .badge")).toHaveText("Paired");
  expect(await relay.registry.authenticateDevice("new-device", "browser-fresh-synthetic-device-secret")).toBe("empty");
  expect(await relay.registry.authenticateDevice("new-device", "browser-first-synthetic-device-secret")).toBeNull();
  await expect(page.locator("#view-devices").getByText("Connectivity not reported", { exact: true })).toBeVisible();
});

test("uncertain approval clears its code, never replays and requires a fresh directory before another action", async ({ page }) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await navigate(page, "pairing");
  await page.getByLabel("Device pairing code", { exact: true }).fill("ABCD-1234");
  const approve = page.getByRole("button", { name: "Approve pairing", exact: true });
  await expect(approve).toBeDisabled();
  await page.getByLabel("I requested this code on a device I am authorized to manage.").check();
  let attempts = 0;
  await page.route("**/api/pair/approve", route => {
    attempts++;
    return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { message: "Result uncertain. Refresh before retrying." } }) });
  });
  await approve.click();
  await expect(page.getByRole("alert")).toContainText("Result uncertain");
  await expect(page.getByLabel("Device pairing code", { exact: true })).toHaveValue("");
  await page.getByLabel("Device pairing code", { exact: true }).fill("ABCD-1234");
  await page.getByLabel("I requested this code on a device I am authorized to manage.").check();
  await expect(approve).toBeDisabled();
  expect(attempts).toBe(1);
  await navigate(page, "devices");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await navigate(page, "pairing");
  await expect(approve).toBeEnabled();
});

test("sign-out while approval is pending does not restore account records", async ({ page }) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await page.route("**/api/pair/approve", async route => {
    entered(); await gate; await route.continue().catch(() => {});
  });
  await navigate(page, "pairing");
  await page.getByLabel("Device pairing code", { exact: true }).fill("ABCD-1234");
  await page.getByLabel("I requested this code on a device I am authorized to manage.").check();
  await page.getByRole("button", { name: "Approve pairing", exact: true }).click();
  await started;
  // Finish logout before HTTP-server teardown; the held pairing route is
  // always released, including if the assertion or logout wait fails.
  const loggedOut = page.waitForResponse(
    response => response.url().endsWith("/api/logout") &&
      response.request().method() === "POST",
  );
  try {
    await page.evaluate(() => (document.getElementById("signout") as HTMLButtonElement).click());
    await loggedOut;
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "fixture-device", exact: true })).not.toBeVisible();
  await expect(page.getByLabel("Device pairing code", { exact: true })).toHaveValue("");
});

test("approved original field persists across all routes and responsive viewports", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(base);
  const brand = page.locator("#brand-field");
  await expect(brand).toBeVisible();
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width: width!, height: height! });
    for (const view of ["home", "devices", "access", "pairing", "settings"] as const) {
      if (width! <= 790) {
        await page.locator("#mobile-nav-toggle").click();
        await expect(page.locator("#mobile-nav-toggle")).toHaveAttribute("aria-expanded", "true");
      }
      console.log(`responsive sweep entering ${width}x${height}: ${view}`);
      await navigate(page, view);
      await expect(page.locator("#view-" + view)).toBeVisible();
      console.log(`responsive sweep verified ${width}x${height}: ${view}`);
      await expect(brand).toBeVisible();
      await expect(page.locator("#loading")).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  const rendering = await brand.evaluate(el => ({
    source: getComputedStyle(el).backgroundImage,
    size: getComputedStyle(el).backgroundSize,
  }));
  expect(rendering.size).toBe("cover");
  expect(rendering.source).toContain("/assets/ascii/approved-background.svg");
});
