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

test("authorized directory, exact revoke confirmation and sign-out work through the real relay", async ({
  page,
}) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your devices" }),
  ).toBeVisible();
  await expect(page.getByText("fixture-device", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Connectivity not reported", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Relay access credential")).toHaveValue("");
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).length + Object.keys(sessionStorage).length,
    ),
  ).toBe(0);
  await page
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
  await expect(page.locator(".badge.revoked")).toHaveText("Revoked");
  expect(relay.registry.getDevice("fixture-device")!.revokedAt).not.toBeNull();
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
  await expect(
    page.getByText("No devices are paired to this account."),
  ).toBeVisible();
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
  await expect(page.getByText("fixture-device", { exact: true })).toBeVisible();
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: '{"error":{"code":"relay_unavailable","message":"Relay unavailable. Try refreshing."}}',
    }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Relay unavailable");
  await expect(
    page.getByText("fixture-device", { exact: true }),
  ).not.toBeVisible();
  await page.unroute("**/api/devices");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("fixture-device", { exact: true })).toBeVisible();
});

test("supplied branding loads, reduced motion is static, and mobile layout fits", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await expect(
    page.getByRole("img", { name: "Tetherplane logo", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator(".ascii-loop img")
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/control-center-mobile.png",
    fullPage: true,
  });
});

test("failed revoke leaves its error visible and does not replay the operation", async ({
  page,
}) => {
  await page.goto(base);
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
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
  await expect(page.getByText("fixture-device", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await loggedOut;
  release();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("fixture-device", { exact: true }),
  ).not.toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

test("loading artwork follows the supplied ping-pong order without a blank interval", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(base);
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/session", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue().catch(() => {});
  });
  await page.getByLabel("Relay access credential").fill("browser-fixture-a");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("status")).toBeVisible();
  const frames = await page.locator(".ascii-loop").evaluate((loop) => {
    const animations = loop.getAnimations({ subtree: true });
    const images = [...loop.querySelectorAll("img")];
    return [0, 2000, 4000, 6000, 8000, 10000].map((time) => {
      animations.forEach((animation) => {
        animation.pause();
        animation.currentTime = time;
      });
      const visible = images.find(
        (image) => Number(getComputedStyle(image).opacity) > 0.99,
      );
      return visible?.getAttribute("src")?.split("/").at(-1) ?? "blank";
    });
  });
  release();
  expect(frames).toEqual([
    "1.png",
    "2.png",
    "3.png",
    "4.png",
    "3.png",
    "2.png",
  ]);
});
