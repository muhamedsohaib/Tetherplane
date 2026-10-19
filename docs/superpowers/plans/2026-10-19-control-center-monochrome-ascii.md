# Control Center Monochrome ASCII Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tetherplane's locally served Control Center UI with the user-approved minimal ivory/ink experience, a persistent complete ASCII emblem-plus-wordmark field behind every screen, and the exact supplied four-frame museum crossfade during genuine loading states, without changing authentication or device security.

**Architecture:** Modify only the existing `@tetherplane/control-center` static frontend, narrowly permit local asset routes, and retain its server/relay authorization logic. A reusable background component and separate pure timing function power a single fixed visual shell; existing client action handlers continue to call the same protected endpoints. No new frontend framework, service, remote listener, OAuth client, or production deployment.

**Tech Stack:** Existing Node.js 22.18+ or 24, pnpm 10.34.5, TypeScript 5.8, vanilla HTML/CSS/ES modules, Playwright 1.64.1, native Node tests, optional developer-side Pillow/libwebp for user-supplied asset conversion. No runtime dependency additions.

**Spec:** `docs/superpowers/specs/2026-10-19-control-center-monochrome-ascii-design.md` at `f73ed3b130b3a8fab1368321c06ffe9ed3a11a39`.

## Global Constraints

- Start from the spec's committed documentation branch on a **new isolated feature worktree**; baseline portal code: `feature/control-center-m2-20261019` at `61a36c7a41b4a0590d2d00aa71cb1f4d32ab45bd`. Verify ancestry and dirty-worktree state first. Preserve all other worktrees, PRs and Surface's running preview.
- Serve exclusively on `127.0.0.1`, default port `8790`; do not touch relay/auth endpoints, scopes, clients, credentials, registered devices, principal profiles, six MCP tools, or local agent.
- Use the **complete original** `Logo with word mark.jpg` as visual source; original SHA-256 `13defcb9f9691089088657a0800d9cc4e153f12b525825c0adda5d2418b276e8`, dimensions 2639×2640. The logo and wordmark must appear within the dense character field, never as a free-floating standalone mark. Preserve source artwork externally and record derivative hashes.
- Source animation is `tetherplane-ascii-loop-pingpong-museum-website.zip`, containing `assets/1.png` through `4.png` and `app.js`. Exact indices `[0,1,2,3,2,1]`, each segment 700ms hold + 1300ms half-cosine opacity crossfade (`0.5 - 0.5 * Math.cos(Math.PI * p)`), cycle 12000ms. No zoom/pan and no continuous motion on idle screens.
- Colors: default ivory `#F4F1E8`, ink `#111111`, white `#FFFFFF` when needed, neutrals only. No greens, red/destructive accent, gradients, faux metrics or decorative placeholder devices. Keep local/system fonts and readable contrast.
- One continuous static ASCII emblem/wordmark background on **every** route/dialog/empty/error/sign-in state; a separately extracted **source-character-field-only** pattern may extend viewport edges without repeating/cropping the central mark. No empty letterbox bands.
- Navigation headings: `Home`, `Devices`, `Access`, `Pairing`, `Settings`. Preserve current real endpoints `/api/session`, `/api/devices`, `/api/pair/approve`, `/api/devices/:id/revoke`, `/api/logout`. Manual authorized client credential UI remains until a **separately reviewed** OAuth integration; never substitute device or ChatGPT credentials.
- Every device field must be sourced from the authenticated account registry. Directory membership is not connectivity. When the existing deployed schema omits presence, show `Connectivity not reported` and `Agent version: Not reported`. Future relay-transport wording is not device-health evidence.
- Explicit action confirmation, same-origin/CSRF protections, sign-out races, token expiry and no mutation auto-replay must remain unchanged.
- Do not deploy, merge, publish Store assets, register OAuth clients or replace signed installers. Public artwork-license and four-device/clean-install release gates remain open.

## Review Focus

These five realistic failure modes have owning tests in the tasks below:

1. **Disconnected/revoked/expired session during a refresh:** clearing directory and credential/CSRF-dependent buttons must prevail over any late response (Task 4).
2. **Malformed or absent image assets:** the page remains legible on a plain ivory fallback; an asset error must not block sign-in or revoke confirmation (Tasks 1 and 3).
3. **Tall/narrow/short screen and dialog overlap:** original wordmark remains uncropped, outer character field fills screen, controls/dialog fit viewport and keyboard focus is visible (Task 3).
4. **Interrupted loading or reduced-motion state:** visibility pause, pause/resume and transition end neither leak motion into idle screens nor leave an invisible persistent overlay (Task 2).
5. **Pairing/revoke mutation timeout or cross-account response:** no invented successful state, no retry, stale records removed, and confirmation/fresh authorized refresh required (Task 4).

---

## File and module map

- `adapters/control-center/public/assets/wordmark-field.webp` **Create**: faithful optimized complete original field-and-wordmark image from user-supplied original.
- `adapters/control-center/public/assets/ascii/outer-field.webp` **Create**: seam-minimized repeating extension sourced **only from original outer character field**, no central emblem or wordmark.
- `adapters/control-center/public/assets/PROVENANCE.md` **Modify**: include source+derivative SHA-256, license hold and exact ZIP motion contract.
- `adapters/control-center/src/server.ts` **Modify** only `staticFiles` at ~320 to allow exactly two new image paths and `/ascii-cycle.js`; never change session/auth/routing logic.
- `adapters/control-center/public/ascii-cycle.js` **Create**: one ES module for pure `sampleAsciiCycle(elapsedMs)` and `mountAsciiLoader({root,base,overlay,pauseButton,reduceMotion})`. DOM effects confined to the mount function; no network APIs.
- `adapters/control-center/public/index.html` **Modify**: persistent decorative background, global header/mobile navigation, five semantic views and two-layer full-screen loader; preserve existing form/control IDs where feasible.
- `adapters/control-center/public/style.css` **Modify**: monochrome design tokens, responsive shell, source-field edge extension, accessibly legible content, modal, visual loading layers and fallback.
- `adapters/control-center/public/app.js` **Modify**: reuse current `api`, `run`, `showDirectory`, `deviceCard`, `signedOut`, `refresh` and protected form handlers; add `renderView(view)` navigation and loader lifecycle.
- `adapters/control-center/test/browser.spec.ts` **Modify**: update existing branding tests/selectors (not remove them), exact animation sampling, UI/aria/route states and four-viewport screenshots.
- `adapters/control-center/test/server.test.ts` **Modify**: new exact asset and CSP/host/Origin/static-directory tests; leave all existing security assertions.
- `adapters/control-center/README.md` **Modify**: new navigation and honest no-token live-sign-in limit; no false OAuth claim.
- `docs/verification/2026-10-19-control-center-monochrome-ascii.md` **Create**: exact commit, assets, test runs, screenshots, independent review, remaining real-device gates.

## Task 1: Source artwork delivery with strict local asset allowlist

**Files:** Create the two `public/assets` images; modify `public/assets/PROVENANCE.md`, `src/server.ts:320-331` and `test/server.test.ts`.

**Interfaces:** New fixed paths `/assets/wordmark-field.webp` and `/assets/ascii/outer-field.webp`; existing server `ControlCenterServer.listen({port})` remains unchanged. No arbitrary path resolution.

- [ ] **Step 1: Write failing Node HTTP tests** in `test/server.test.ts`: both new paths respond `200` with `image/webp`, `nosniff`, `no-store` and nonempty bytes; unsupported asset paths, query strings, traversal and modified Host are rejected; existing `/assets/logo.jpg` remains available.
- [ ] **Step 2: Verify RED**: `pnpm --filter @tetherplane/control-center test` fails only the new asset-route assertions (404 before implementation).
- [ ] **Step 3: Verify user art provenance before creating derivatives**: compare original and ZIP frame SHA-256 with the spec table; inspect `Logo with word mark.jpg` to confirm logo + wordmark + populated outer characters. If original not accessible, **stop**: do not fabricate or replace. Convert the intact image to a visually faithful full-resolution WebP; extract outer text-only field, avoiding logo regions. Record actual derivative hashes, dimensions and method in PROVENANCE; inspect legibility of characters at real viewport scale, not just file size. Keep originals unchanged outside built artifact; never embed data URIs/secrets.
- [ ] **Step 4: Add only the two explicit `staticFiles` allowlist keys**, pointing to corresponding `public/assets` paths. Do not change CSP, auth/session handlers, relay client, or listener.
- [ ] **Step 5: Verify GREEN**: portal Node tests pass; `curl` or Node `fetch` checks both exact MIME types, correct sample bytes and rejects unsupported routes. Verify images' actual SHA-256 matches PROVENANCE, then commit only these asset/static-delivery files as `feat(control-center): serve supplied ASCII wordmark field safely`.

## Task 2: Exact full-screen museum crossfade with safe lifetime

**Files:** Create `public/ascii-cycle.js`; modify `public/index.html`, `public/style.css`, `public/app.js` and the fixed `src/server.ts` static allowlist; test in `test/browser.spec.ts` and `test/server.test.ts`.

**Interfaces:**
- `sampleAsciiCycle(elapsedMs: number): { baseIndex: number, overlayIndex: number, overlayOpacity: number }` uses **zero-based indices**, returns base and next indices from `[0,1,2,3,2,1]`; time wraps at 12000ms.
- `mountAsciiLoader({ root, base, overlay, pauseButton, reduceMotion }): { show(message: string): void; hide(): void; destroy(): void }` controls its own RAF, media/visibility listeners and pause button; it does **not** own session state, make API calls or invent loading.
- Public script URL `/ascii-cycle.js` serves only the new local ES module; app.js imports and owns whether to call `show`/`hide`.

- [ ] **Step 1: Add browser RED tests** dynamically importing `/ascii-cycle.js` and verifying at 0, 699, 700, 1350, 1999, 2000, 4000, 6000, 8000, 10000, 11999 and 12000ms: exact frames, overlay 0 during hold, half-opacity at middle fade and seamless wrap. Add tests for static `prefers-reduced-motion`, visibility pause, manual pause/resume, no animation on idle, and overlay hide on fetch reject/resolve. Avoid wall-clock-flaky waits by injected/manual sample time.
- [ ] **Step 2: Verify RED** with `pnpm --filter @tetherplane/control-center test:browser` (new module/overlay assertions fail before the implementation).
- [ ] **Step 3: Implement the pure sampler plus two-image RAF controller**. Preload the 4 local frames once, update image `src` only when segment changes, animate only overlay opacity with `0.5 - 0.5*Math.cos(Math.PI*p)`, respect reduced motion and tab visibility, and make `hide` cancel RAF/reset `aria-busy`. No zoom, movement, fake delay or background idle loop.
- [ ] **Step 4: Integrate a fixed full-viewport loading overlay** in `index.html`, using the existing four source frames and Task 1's field extension. Retain a real `role="status"` message and pause/resume. Change `app.js:setBusy` to request the loader only while the existing `run` operation or initial bootstrap genuinely waits; never trigger a full-screen splash merely by changing a loaded tab. Keep existing action-cancellation and stale-response guards.
- [ ] **Step 5: Verify GREEN** with browser and portal Node tests; replay the original ZIP's exact 0.7s hold/1.3s half-cosine sample in tests, compare overlays at 700/1350/2000ms. Check accessibility when `prefers-reduced-motion: reduce`, tab hidden, and loader failure. Commit `feat(control-center): honor full-screen museum ASCII crossfade`.

## Task 3: Persistent ASCII shell, Home and five accessible routes

**Files:** Modify `public/index.html`, `public/style.css`, `public/app.js`, `test/browser.spec.ts`.

**Interfaces:**
- `renderView(view: "home"|"devices"|"access"|"pairing"|"settings"): void` shows only the requested authorized view without fetching or changing session authority.
- Navigation elements set `data-view` and `aria-current="page"`; inactive regions are hidden or inert; unauthenticated users see only the sign-in view.
- `#brand-field` is a single fixed decorative background behind **all** views; central complete wordmark is one untiled image, outer source-character field repeats/extends under edge treatment without duplicating a logo.

- [ ] **Step 1: Add RED Playwright tests** for exactly five navigation headings in authorized mode; signed-out mode hides management routes. Assert `#brand-field` is present in signed-out, each view, empty/error and revoke dialog, image loads and naturalWidth > 0; source central image remains uncropped and not stretched. At 1440×900, 1024×768, 390×844, 320×640 verify background fills all viewport edges, `documentElement.scrollWidth <= innerWidth`, menu usable, foreground focus visible, modal operable, and readable fallback when image URLs fail.
- [ ] **Step 2: Verify RED** with filtered browser tests (new view and background assertions fail before new markup).
- [ ] **Step 3: Replace existing green/sidebar shell** with one fixed 3-layer background system: ivory foundation, source-derived ASCII outer-character field, contain-sized centered full emblem/wordmark image; content on top, loader above all. Only the **field** may tile; do not `cover`-crop the original logo or add a second free-standing logo in page center. Set ink/ivory tokens, visible focus, narrow max-width, readable neutral surfaces, semantic main/nav/button labels and small mobile menu. Remove nonfunctional marketing text and fake connection counters.
- [ ] **Step 4: Add `renderView` and honest Home view**, with exactly `View devices`, `Add a device`, `Review access` destinations and account-scoped count/last refresh only after successful authorization. Sign-in retains the existing credential input until separately approved OAuth work; do not introduce an inert `Sign in with Tetherplane` button. Keep `welcome`, `dashboard` or adapt the existing test selectors explicitly rather than silently deleting coverage.
- [ ] **Step 5: Verify GREEN** with Playwright screenshot fixtures and keyboard-only flows at four viewports; manual screenshot review for complete wordmark, no field seams/blank bars, contrast, touch sizes and genuine simplicity. Commit `feat(control-center): build minimal ivory-ink ASCII shell`.

## Task 4: Devices, Access, Pairing and Settings without changing capabilities

**Files:** Modify `public/index.html`, `public/app.js`, `public/style.css`, `test/browser.spec.ts`. **No relay/auth/agent code changes.**

**Interfaces:** Keep `api(path, signal, options)`, `run(task, text, success, quiet401)`, `showDirectory(data)`, `signedOut()`, `refresh()` and the exact current POST bodies `{userCode,confirmOwnership:true}` and `{confirmDeviceId:deviceId}`. New view renderers consume only `/api/session` or `/api/devices` response objects; they cannot create device records.

- [ ] **Step 1: Add RED integration/browser tests**: signed-in devices list has only account-bound paired/revoked records and literal `Connectivity not reported`; Access offers `Revoke access` only for active records, requires exact ID and never auto-retries; Pairing requires owner confirmation plus `XXXX-XXXX` and existing rate/expiry rules; Settings shows only local session/version/relay configured where actually available and Sign out (no token, device secrets or false remote actions). Test empty/403/401/502/timeout, pairing/revoke uncertain outcome, and sign-out during delayed refresh/approval.
- [ ] **Step 2: Verify RED** with `pnpm --filter @tetherplane/control-center test:browser` (new view assertions fail).
- [ ] **Step 3: Move existing real operations into the authorized views**: list/timestamps/refresh in Devices, exact-ID-confirmed revoke in Access, explicit three-step pairing + safe recovery instructions in Pairing, local session controls in Settings. Use existing authentication/CSRF/race logic unchanged. Preserve current confirmed-revocation warning and refresh-after-uncertain-outcome. Static metadata cannot claim deployed agent version/health; no remote start/reconnect/reboot buttons.
- [ ] **Step 4: Ensure state boundaries and a11y**: hide route content after invalidated session, clear stale directory and form values, do not resurrect content after in-flight sign-out, preserve form keyboard input and revoke-dialog focus. Expose readable error status without decorative animation-only feedback.
- [ ] **Step 5: Verify GREEN** by re-running all existing portal/browser tests against isolated RelayServer fixtures (adapt selectors, not test intent), including account separation, expired token, bad CSRF/Origin/Host, pairing, revoke, race/uncertainty and no browser-storage credentials. Commit `feat(control-center): clarify device access and pairing workflows`.

## Task 5: Whole-branch verification, artifact provenance and independent review

**Files:** Modify `adapters/control-center/README.md`; create `docs/verification/2026-10-19-control-center-monochrome-ascii.md`; amend focused test files only for gaps found by review.

**Interfaces:** No new runtime APIs. Report exact final branch SHA, source/hash provenance, failing or passing commands, independent findings and release blockers. Keep separate from OAuth browser-login architecture.

- [ ] **Step 1: Document** the real five-view navigation, 12s museum motion contract, original image hashes and derivative hashes, reduced-motion behavior, localhost startup instructions, manual-token sign-in limitation and security disclaimer. Preserve the rest of the README's operational guidance.
- [ ] **Step 2: Fresh local tests** on an isolated checkout: `pnpm install --frozen-lockfile`, `pnpm --filter @tetherplane/control-center build`, `pnpm --filter @tetherplane/control-center typecheck`, `pnpm --filter @tetherplane/control-center test`, `pnpm --filter @tetherplane/control-center test:browser`, `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test`, `cargo fmt --all -- --check`, `git diff --check`. Install Playwright Chromium test dependencies only in an isolated/authorized environment; never manipulate a human-owned browser profile.
- [ ] **Step 3: Screenshot + UX acceptance** at four viewports in signed-out, signed-in Home/Devices/Access/Pairing/Settings, modal, error and loader. Visually inspect center mark, outer field edge continuity, contrast and no animation during idle. Record exact screenshot names in verification report. If screenshot quality fails, revise the **smallest** source issue and repeat the specific test before the whole suite.
- [ ] **Step 4: Fresh independent, read-only whole-branch review**: compare the feature branch to base + committed design/plan. Confirm `src/server.ts` changes are static allowlist only, public no-credential assets are identical to audited user sources/derivatives, no auth/relay/agent modifications, full negative authorization/race test preservation, and no false pairing/health claims. Record issues/resolutions in the verification document.
- [ ] **Step 5: Hosted CI at exact head** after pushing only the new feature branch: verify all Ubuntu/Windows `control-center` and `quality` jobs finish **success** at the recorded SHA. An older green run does not prove a new commit. Document remaining acceptance: authenticated real-user portal login requires separate approved OAuth integration; four-device real trials, clean signed installation, recovery/rollback and artwork release permission remain **NO-GO**. No merge/deploy/release without fresh explicit approval.

## Worktree setup and stop conditions

After user approves this plan and selects execution method, start by verifying Git status, branch ancestry, and the image original's hash in an authorized local repository/mount. Then use a dedicated worktree branched from the exact plan commit, e.g. `feature/control-center-monochrome-ascii-20261019`; never reset, clean or delete another worktree. If a required external binary original is inaccessible, report the blocker rather than shipping an imitation. Keep Surface's current local Control Center preview running and unmodified until separately authorized deployment/replacement.

**Plan handoff gate:** This document and its commit are **planning artifacts**, not frontend code, executable installer, or verified UI. Wait for the user to review this plan and select either subagent-driven task/reviewer gates or native sequential execution with one final independent reviewer. Neither option authorizes production identity/configuration changes.
