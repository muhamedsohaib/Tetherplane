# WebView2 invisible browser — isolated Windows proof

**Status (2026-10-28):** Windows laboratory acceptance on Leno **PASS**. This is **not** a production browser backend, device installation, or permission to automate signed-in websites.

## Why this proof exists

On Leno, ordinary Edge 156.0.4314.42 exits its original launcher and creates a replacement process before the private CDP handshake. Hosted Windows Edge 155.0.4283.62 and Chrome passed the private pipe. This discrepancy remains in draft PRs #81–83 and canonical issue #75.

Microsoft-signed WebView2 Runtime is already installed on Leno. WebView2 exposes CoreWebView2.CallDevToolsProtocolMethodAsync to invoke page-level CDP through the hosting application without requiring a raw DevTools TCP listener. This lab tests that path without changing installed Edge security or installing another browser.

## Exact physical proof

- Leno: Windows interactive session, existing non-elevated authenticated Tetherplane agent 0.1.0, background_only.
- Runtime: **155.0.4283.62**, Microsoft Authenticode-signed.
- SDK: **Microsoft.Web.WebView2 1.0.4258.31**, NuGet Microsoft author signature verified using Microsoft-signed NuGet CLI **6.14.0**.
- SDK package SHA256: **56F7F4B8BF9AEE4B8EFEFBBDD4F67D5F74EBD1B100ED0806DA71BF76AF481AA9**.
- NuGet CLI SHA256: **92DBED160DDEE0F64B901E907439E021211B428E57C089ECC12FC38DCC4BD9A5**.
- Core, WinForms, and native x64 WebView2 loader DLLs individually passed Microsoft Authenticode verification. No proprietary binaries are committed.
- Compiler: preinstalled .NET Framework csc.exe; no SDK, system installer, administrative privilege or production configuration change.
- Host: WinForms zero-opacity, off-screen, WS_EX_NOACTIVATE, no taskbar entry; retains STA and UI message loop.
- Profile: unique random temporary userDataFolder.
- Page: static in-memory NavigateToString HTML, with no external websites, personal tabs, passwords, uploads or downloads.
- CDP: Runtime.evaluate reads local status=initial, invokes a button action, verifies status=clicked.
- Host internally checks foreground window, clipboard sequence and cursor; independent PowerShell process samples those values and test browser process ownership, TCP listeners, unsafe debugging flags and cleanup without exposing process command lines.

## Physical acceptance results

Initial proof: CDP action passed; foreground and clipboard unchanged; cursor changed once for an **unknown reason**, so no-interference acceptance was not claimed for that run.

Three subsequent fresh-profile runs with an off-screen 1%-opacity host each passed: verified CDP action, zero foreground/cursor/clipboard changes, zero remaining test-owned processes, profile removed.

A zero-opacity host run passed with **six** test-owned WebView2 processes observed, **zero** TCP listening sockets owned by them, **no** remote-debugging-port or no-sandbox flags, no DevToolsActivePort file, no foreground/cursor/clipboard changes, and no residual test-owned processes or profile.

The reproducible run-acceptance.ps1 script was then executed on Leno; result **exit 0, verdict=PASS** with the same observations and tempDirectoryRemoved=true. It fetched and verified the pinned signed dependencies, compiled the exact committed C# source, and removed its temporary files.

## Reproduce

Explicitly run **run-acceptance.ps1** on an authorized Windows interactive desktop. No parameters are required. The script fails closed on unsigned/mismatched downloads, compilation failures, missing browser actions, any measured workspace input/focus change, raw TCP listeners, debugging flags, or incomplete cleanup.

The script only kills WebView2 processes containing its unique disposable browser profile path and only removes its own temporary directory. A moving human pointer can cause this strict test to fail; that alone does not establish browser-caused interference.

## Known limits and integration gates

**Observed:** Invisible, nonactivating Microsoft WebView2 can execute a verified local browser action through page-level CDP on Leno without exposing an owned TCP listener in this configuration.

**Not demonstrated:** Compatibility with the existing entire CdpWire protocol (a WebView2 adapter would need to map independently owned controllers/pages), real signed-in sessions, owner-approved revocable site/action grants, threat-modelled per-process isolation, arbitrary popup/dialog/network/worker/WebSocket/WebRTC restrictions, unattended broker crash and rollback, simultaneous active human operation, clean Windows installation, and four-device acceptance.

The security-hardened browser beta remains **NO-GO** until these boundaries pass. This proof does not replace the existing Chromium private-pipe work, alter production identity settings, access personal browser sessions, merge protected branches, or release software.
