import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: "browser.spec.ts",
  workers: 1,
  fullyParallel: false,
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "off",
    screenshot: "only-on-failure",
  },
});
