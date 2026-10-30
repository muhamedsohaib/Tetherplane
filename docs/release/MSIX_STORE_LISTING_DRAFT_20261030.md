# Microsoft Store listing — Tetherplane (review copy only)

**DRAFT; NOT SUBMITTED.** Prepared against current Store preview in PR #109. The account's verified personal-name publisher is pending Microsoft support request `2610290010001747`; do not use the legacy public `ARCUS Labs` publisher as a substitute if the request requires a change.

## Store fields (English, Windows desktop only)

**Title:** Tetherplane

**Price:** Free (subject to owner choice and Partner Center confirmation)

**Category:** Developer tools / Utilities — owner must choose from actual Partner Center category options.

**Short description (proposed):** Connect an authorized Windows device to compatible MCP clients through owner-approved pairing and scoped controls.

**Description (proposed):**

Tetherplane is an open-source Windows connectivity application for people who want to connect their own authorized computer to compatible Model Context Protocol (MCP) clients. Pair a device through an existing authorized relay, approve access as the device owner, and use only the capabilities permitted for the connected client.

The current software exposes device, file, process, browser, desktop, and batch tools. Operations remain subject to authentication, per-principal permission boundaries, device-specific access restrictions, and human approval where required. An unauthorized request should be denied rather than silently expanding access.

Tetherplane requires a compatible MCP client and an owner-controlled, already-configured relay. It does not provide a relay account or automatically create a cloud identity. Desktop and browser operations require their own applicable local permissions. The Store preview is not a remote-control bypass or a background service registered without the device owner's approval.

**Feature lines (proposed):**

- Owner-approved pairing to an authorized relay.
- Six MCP tool families with explicit permission boundaries.
- Windows 11 x64 device agent and first-run setup.
- Scoped operation denial and authenticated device status.
- Open-source code with separately documented setup requirements.

**System requirements:** Windows 11 x64; internet access for a remote WSS relay; authorized relay/device account; compatible MCP client; per-capability permissions. Verify compatibility, dependencies, and background behavior on the final certified artifact before publication.

**Screenshot #1:** Genuine untouched unpaired setup form from a disposable approved Windows install, minimum 1366×768 PNG, no credentials or private data. **Status: NOT CAPTURED.**

**Optional Store tile:** 300×300 PNG mechanically exported from the exact owner-selected `Logo.jpg` emblem; export review and final SHA-256 approval are still pending. The separate `Logo with word mark.jpg` is the approved design direction for larger brand media; do not shrink it into the app icon. No source JPEG is uploaded to public GitHub.

**Privacy disclosure:** Select **Yes** for app access/collection/transmission of personal information. The agent can handle personal file/process/browser/desktop data; a configured relay can inspect MCP requests and results, and the local agent may persist audit metadata and completed idempotent results. See `MSIX_STORE_PRIVACY_DATAFLOW_AUDIT_20261030.md` and the **unapproved** `MSIX_STORE_PRIVACY_NOTICE_DRAFT_20261030.md`. Microsoft allows policy text entered directly in Partner Center or a valid URL. **Status: PRIVACY POLICY NOT APPROVED OR PUBLISHED; CONTACT AND RETENTION STILL UNVERIFIED.**

**Support contact:** Pending the owner's new preferred support email or verified website. Do not put the retired email or any personal credentials into the listing.

**Private audience:** Existing planned `Tetherplane Internal Testers`, direct link only; actual audience assignment and Store workflow subject to owner approval and Microsoft's response.

**Excluded claims:** 'Microsoft certified', 'Store-signed', 'auto-starts on reboot', 'works with every Windows device', 'unrestricted computer control', 'four production devices verified with this version', and 'Smart App Control accepted'. None is independently established for the Store package.

## Review conditions

This text is not a substitute for a real Store listing or approved public privacy notice. Independently review policy claims, owner identity, Store screenshots and package evidence before submitting. Store screenshots and optional tile images must not be generated from mock connection states.

Official guidance:
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-and-edit-store-listing-info
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/screenshots-and-images
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/support-info
