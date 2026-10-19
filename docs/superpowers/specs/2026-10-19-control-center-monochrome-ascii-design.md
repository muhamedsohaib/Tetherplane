# Tetherplane Control Center — Monochrome ASCII Experience

Date: 2026-10-19
Status: approved direction; written specification for user review
Scope: local Control Center visual/interaction redesign only
Baseline: feature/control-center-m2-20261019 at 61a36c7a41b4a0590d2d00aa71cb1f4d32ab45bd

## Product goal and non-negotiable design rules

Replace the current pale-green sidebar-heavy milestone UI with a premium, unambiguous, minimal ivory/ink Control Center. Maintain the existing authorized device directory, pairing approval, revocation, refresh and sign-out. This is not a replacement for the model-neutral control plane, a production identity migration or a release authorization.

The following comes directly from the user's approved visual direction:

- At **all times on every screen** there is a **single persistent image of the complete ASCII Tetherplane emblem and wordmark inside a dense field of ASCII characters**, behind foreground content. Use the supplied **darker-field** image named **Logo with word mark.jpg**. A standalone emblem, floating wordmark, blank canvas or repeating isolated logo is incorrect.
- Reserve the **four supplied ASCII PNG frames** for actual startup/loading states, major asynchronous transitions and the initial Home splash. Never run them continually behind idle forms, lists or settings.
- Match the original ZIP's museum crossfade exactly: frame indices **1 → 2 → 3 → 4 → 3 → 2 → 1**, each step **700ms fully held plus 1300ms eased crossfade**, easing **0.5 − 0.5 cos(πp)**. No pan, zoom, jitter, displacement or cut.
- Use **ivory white / ink black**, with monochrome neutrals only. Default ivory #F4F1E8, ink #111111; no green, crimson, SaaS accent gradients, glassmorphism, dense charts or decorative telemetry.
- Make the product understandable to a novice: obvious screens and real actions only, sparse copy, clear states and no invented device capabilities.

This design supersedes accent-heavy older dashboard mockups without replacing the canonical 2026-09-17 architecture or device-local policy authority. The existing four-device setup, six MCP tools, production OAuth audience/scopes/client identities and protected relay boundaries remain unchanged.

## Artwork and supplied-code authority

The actual user-supplied artwork was inspected. Source SHA-256 values:

| Usage | Original file | Dimensions | SHA-256 |
| --- | --- | --- | --- |
| Persistent complete emblem + wordmark in character field | Logo with word mark.jpg | 2639×2640 | 13defcb9f9691089088657a0800d9cc4e153f12b525825c0adda5d2418b276e8 |
| Standalone icon where required | Logo.jpg | 1062×1062 | ad09e637464a834fc36bf4e088d1aa767841c89e9f5bb07b6d6dc07f0b2f4f53 |
| Museum frame 1 | ZIP assets/1.png | 1200×1200 | 80781aa42eaf8322149ab0e5f1b941a8a17777badccb53247542652a37cb062d |
| Museum frame 2 | ZIP assets/2.png | 1200×1200 | 476e00a9008e0801d91eba7b685a7c3f99bbd0fa8e0b1aa06e9a54276b0d1e24 |
| Museum frame 3 | ZIP assets/3.png | 1200×1200 | 231d538e8c6f3d6ed079b03b1fe785d92569debe522d5cef02882faffb9f6ec7 |
| Museum frame 4 | ZIP assets/4.png | 1200×1200 | a5097cc0a15e25c4f8952d320f1e581e99c7acc6973c087bd82cc2130b19839b |

The canonical supplied animation file is tetherplane-ascii-loop-pingpong-museum-website.zip, containing app.js, styles.css, index.html and those four frames. Its JavaScript index sequence is [0,1,2,3,2,1], hold is 0.7 seconds, fade is 1.3 seconds, and easing is the half-cosine curve. Preserve this **observable motion**, while avoiding the demo's inefficient per-frame src assignment.

The existing portal's asset provenance explicitly omitted Logo with word mark.jpg to avoid duplication. This choice must be **reversed** for the new persistent-background requirement. Keep original bytes or a visually faithful optimized derivative, record the exact original hash and any derivative hashes, and keep local asset loading. User-supplied artwork licensing for public distribution remains an independent gate.

## Permanent layered app shell

Every route, modal, empty/error/loading state, sign-in, Home, Devices, Access, Pairing and Settings mounts the same noninteractive complete-wordmark ASCII background. Use one non-tiled central instance, fixed to the viewport and aligned behind content. Preserve the emblem and wordmark shape; never crop or stretch them.

The source is a near-square image, so unqualified background-size: cover would crop the mark on wide/tall viewports. Solve this by centering the intact composition with contain-like sizing and extending **only the source's surrounding character field** to every viewport edge. No empty letterbox bars, visible pattern seams, duplicate logos or invented text. If optimized tiles are used, derive them solely from safe outer field regions and record their provenance.

Foreground legibility may use restrained opaque or translucent neutral surfaces **immediately behind text and controls**. Do not wash out the whole branded field into invisibility. The background has no click targets, focusable objects or screen-reader description (decorative only).

Color and text: ivory #F4F1E8 as the default background, ink #111111 for content, #FFFFFF where opaque text surfaces improve readability, calm neutral borders and gray secondary copy. Local/system fonts only. A black/white high-contrast variant can be designed later without introducing a required theme switch in this milestone. Buttons are clear ink/ivory rectangles; destructive intent is expressed explicitly in words and confirmation, not by color. Keyboard focus must remain visually prominent.

The shell uses a simple header and five small navigation destinations; no permanent 244px marketing sidebar. On mobile, use a keyboard-accessible compact menu. Breakpoint acceptance covers 1440×900, 1024×768, 390×844 and 320×640. The ASCII emblem and wordmark remain uncropped and the field reaches the viewport edge in all sizes.

## Loading and transition visual contract

The loader covers the full viewport, with the source composition held steady and the surrounding ASCII field filled edge-to-edge. It displays a single small, real state message such as Checking your session or Refreshing device records, not a fabricated progress percentage.

Loop behavior:
- Frames 1, 2, 3, 4, 3, 2, then 1 again.
- Hold current frame fully for 700ms.
- Overlay next frame over 1300ms using opacity = 0.5 - 0.5 * cos(pi * elapsed/fade).
- Segment duration exactly 2000ms, cycle duration 12000ms.
- No image-position or scale animation. Preload locally. Avoid changing image source on every animation-frame tick.
- Pause on document hidden. Respect prefers-reduced-motion by showing static frame 1 with real loading text. Provide pause/resume for sustained loading.

The loader appears only for real startup/bootstrap, authentication waiting, a meaningful directory refresh, an in-flight pairing approval, or a major asynchronous transition. It exits on actual completion or error without a forced theater delay. Ordinary navigation between already-loaded views does not trigger a splash. The persistent static background remains underneath and does not blink between pages.

## Information architecture and exact screen contracts

Primary navigation: Home, Devices, Access, Pairing, Settings. Sign-in is a gate state, not a navigable management page. Recovery belongs within Pairing, not an unimplemented remote command center. All idle screens have the **same complete static ASCII wordmark backdrop**.

### A. Splash / initial loading

Present the museum animation full-screen with one status line. If the session is already valid, land on Home; otherwise land on Sign-in. A timeout stops the animation and provides a clear action to retry. No perpetual splash, fake completed progress, or background widget activity.

### B. Sign-in

One big heading (for example Your devices. One place.) with one short description and one real authorization path. Current milestone only knows a manually supplied relay client access credential; retain that actual flow until an **independently approved OAuth/browser-login integration** exists. Do not label an inert UI control Sign in with Tetherplane, extract a ChatGPT token, request a device credential, or register replacement clients. When approved, the future path will use the existing issuer, authorization code + PKCE, exact callback, account binding and server-side token handling. Differentiate denied credentials, expired sessions and relay unavailability.

### C. Home

Answers What can I do next? Show Your devices. with one short account-scoped description and exactly three obvious destinations: View devices, Add a device, Review access. Source factual totals and last successful directory refresh only from authenticated directory data. Do not equate pairing with being online. If live connectivity is unavailable, say Connectivity not reported. Empty state: No devices are paired to this account. No example devices, decorative panels, status inventions or telemetry charts.

### D. Devices

Answers Which devices belong to this account? Show a single readable device list with exact device ID, paired/revoked registry state and actual timestamps. Provide one refresh action and last successful refresh time. Clear stale records on refresh failure. Connectivity is Not reported when the baseline relay lacks presence; never infer online from a pairing record. If future PR #20 is separately approved and deployed, call its value **relay transport** rather than agent health. Do not show unsupported remote start, stop, reboot, process control, auto-repair, last seen or OS/version values.

### E. Access

Answers Which relay access may I manage here? Show ownership-limited account/device relay access and the one supported destructive operation: Revoke access. Require the exact device ID to be typed, same-origin CSRF protection and a warning that re-pairing is required. Never auto-retry a failed/uncertain revoke; refresh first. Say On-device permissions are enforced by the device itself. Do not invent user roles, organization settings, per-capability toggles or device policy changes.

### F. Pairing and recovery

Answers How do I add or recover an authorized device? Show three short steps: Start pairing on your authorized device; Enter the displayed one-time code; Confirm that you initiated it and approve. Respect the real XXXX-XXXX format, expiration, current account/session authorization, rate limits and competing-code protections. Refresh the actual registry on success; do not imply the agent is online. Recovery is an honest **guide**, distinguishing ordinary live-agent reconnect retry from agent stopped, relay unreachable, revoked credential and fresh pairing. No action that bypasses local policy or automatically restarts a machine.

### G. Settings

Answers What can I change safely in this local portal? Show local portal status, frontend version, configured relay origin when available, session expiry, and Sign out. Do not show credentials, access tokens, full runtime command lines, environment dumps or private logs. Policy editing, account administration, sign-in provider changes, pairing secrets, remote execution and agent service management are not settings in this milestone.

## State handling, error copy and safety

Explicit application states include bootstrapping, signed_out, authenticating, authenticated_fresh, refreshing, expired, unauthorized, relay_unavailable, pairing_pending, mutation_uncertain, revoked and empty_directory. Loading state determines when motion is active; idle means static background. Use accessible status announcements, not animation-only information.

- Missing account authorization: Your session needs authorization. Clear directory contents immediately.
- Relay unreachable: The relay could not be reached. Try refreshing. This is not equivalent to a specific device being offline.
- Mutation may have completed: The request may have completed. Refresh before trying again.
- No records: No devices are paired to this account.
- Transport not in deployed schema: Connectivity not reported.

Validate existing account authority on every request. Preserve reauth/expiry and sign-out races, strict origin/host checking, CSRF, bounded payloads, sanitized errors and no secret logging. Device-local authorization remains final.

## Approved scope versus separate dependent work

The visual implementation is bounded to the existing adapters/control-center files: public/index.html, public/style.css, public/app.js (or small dedicated ASCII module), user artwork in public/assets with updated PROVENANCE.md, server.ts **static-file allowlist only**, and tests. No new hosted app, new library requirement, external fonts/scripts, relay/auth deployments or OAuth-client registration. Use a dedicated feature worktree; do not disturb existing device instances, credentials, dirty worktrees, PR #20, or the user's Surface preview.

A future **browser-based OAuth login** is a **separate architectural workstream**, not authorization to alter production identity in this visual work. The current user does not have a relay client access token. Consequently, visually completed sign-in cannot be represented as successful live account authentication until its own OAuth client/redirect/issuer/account-bound test and approvals are done.

## Verification and release gates

Visual proof:
1. Entire wordmark/emblem is visibly composed of characters against a surrounding ASCII field behind **every page**, including modal and sign-in.
2. The character field fills all viewport edges in desktop/mobile snapshots without visible seams, cropping, stretching or logo duplication.
3. Splash/loader deterministic sequence and 700ms hold + 1300ms eased crossfade match supplied HTML/JS, including loop wraparound. No forced delays.
4. Stable screens never have ASCII background motion. Prefers-reduced-motion static frame and keyboard pause work.
5. Real text, form controls, dialogs, focus, screen readers and mobile touch targets remain legible over art (WCAG AA contrast where applicable); fail-safe plain ivory canvas if artwork cannot load.
6. No green/red/other accent palette, synthetic device cards, faux metrics, decorative statistics, or unsupported buttons.

Functional proof:
1. Preserve synthetic authenticated directory, pairing approval, confirmed revoke, refresh and sign-out through isolated real relay fixtures, with account separation.
2. Preserve denial for unauthorized account, rejected scope, cross-account devices, bad CSRF, wrong Host/Origin, malformed upstream and timed-out mutations.
3. No bearer, cookie, client secret, device credential or raw request body may reach browser storage, URL, static page code, GitHub or logs.
4. New markup regression tests and screenshot reviews at four viewport sizes; portal build, typecheck, unit, headless browser and complete repository Windows/Ubuntu CI at exact head.
5. An independent read-only review verifies unchanged protected authorization code; any real-device acceptance requires explicit named-device authorization and is not implied by a browser fixture.

Release state remains **NO-GO** for clean signed install, upgrade/rollback, four-device authenticated acceptance, genuine unattended recovery and approved production identity/relay deployment. Source or test success does not satisfy those gates.

The next stage **after user review of this written spec** is an implementation plan, then an authorized isolated feature branch with test-driven frontend work. Do not present this spec commit as a UI implementation or release.

## User-superseding visual design approval — 2026-10-20

**This later user instruction supersedes the earlier image layering, animation, no-glass and no-static-loader requirements above.** Authorization, account isolation, device safety and NO-GO release boundaries remain binding.

- Use only the user-uploaded `ascii-art (16).txt`, exactly 400 columns by 460 lines, canonical SHA-256 `62a3ea8172093100422ea4543694441caf93e4368794d9f4104851c07b601e6f`, as the single page-wide backdrop. No separately tiled or centered second image.
- The ASCII text is preserved in `public/assets/ascii/approved-background.txt`; the background URL resolves to a deterministic glyph-faithful SVG. Use that same SVG as the backdrop for a brief delayed static loading state, without a museum loop, separate showcase, or animation controls.
- Text over the ASCII image must use translucent, background-blurred glass surfaces with readable ink rather than solid ivory/black slabs. Apply across headings, panels, buttons, dialogs, navigation and status.
- Preserve existing five screens, account-bound relay operations, sign-out, CSRF/Origin/Host and device-local boundaries. Verify mobile menu stays above content and remains clickable at 390 and 320px.
- The isolated Vercel visual-QA frontend uses synthetic data and disabled relay mutations and is protected by Vercel SSO; it is not the production portal or authorization to publicly redistribute artwork.

Original ZIP animation and earlier JPG/WebP composition remain historical-only. Updated acceptance requires source-glyph fidelity, desktop/mobile view checks, all exact-head CI and independent whole-branch review.
