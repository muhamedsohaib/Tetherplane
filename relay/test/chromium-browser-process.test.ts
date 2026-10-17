import assert from "node:assert/strict";
import test from "node:test";

import { windowsChromiumImageName } from "./helpers/chromium-image-name.ts";

test("Windows owned-profile cleanup audits Edge and Chrome by their actual executable names", () => {
  assert.equal(windowsChromiumImageName("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"), "msedge.exe");
  assert.equal(windowsChromiumImageName("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), "chrome.exe");
  assert.equal(windowsChromiumImageName("C:\\sandbox\\chromium.exe"), "chromium.exe");
});

test("Windows owned-profile cleanup refuses unsupported or injected image names", () => {
  assert.throws(() => windowsChromiumImageName("C:\\Tools\\not-a-browser.exe"), /unsupported chromium/i);
  assert.throws(() => windowsChromiumImageName("C:\\Tools\\chrome.exe'; Stop-Process -Id 42; '.exe"), /unsupported chromium/i);
});
