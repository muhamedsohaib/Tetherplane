# Control Center monochrome ASCII — integration evidence

**Date:** 2026-10-19
**Status:** draft PR #22, feature branch `feature/control-center-monochrome-ascii-20261019`; **not merged, deployed, or release-approved**.
**Reference:** [PR #22](https://github.com/muhamedsohaib/Tetherplane/pull/22) into `feature/control-center-m2-20261019`.
**Approved design:** `docs/superpowers/specs/2026-10-19-control-center-monochrome-ascii-design.md`.
**Execution plan:** `docs/superpowers/plans/2026-10-19-control-center-monochrome-ascii.md`.

## Source integrity

- Preserved user-supplied full ASCII image `Logo with word mark.jpg` (source SHA-256 `13defcb9f9691089088657a0800d9cc4e153f12b525825c0adda5d2418b276e8`).
- Source-derived 2048×2049 wordmark WebP: SHA-256 `16ff3a5a2b5d71149039372afb7663830ec73aecf28928576514e033ae816a65`; Git blob `7b9fefb8db3680602f711466e8d94cc6644ddee6`, verified against the local original build.
- Outer character-only field, derived from a 512×512 source crop: SHA-256 `f122b6103bc8cb4e79026d568f78e7e83c2fa115d00c48c3a85196dfb7b909d7`; Git blob `50103e9189055e1abaf2727a2406c88fe14bad56`, verified.
- Original ZIP PNGs 1–4 retain their supplied source hashes (see `adapters/control-center/public/assets/PROVENANCE.md`). Loop is exactly [0,1,2,3,2,1], 700 ms hold + 1300 ms cosine fade, 12000 ms cycle.
- Earlier experimental 1024px low-quality derivatives were **not** published; the sharper 2048px image was retained.

## Interface and boundary changes

New Home, Devices, Access, Pairing and Settings navigation. Decorative central image persists on every screen with an outer ASCII letter field extension and monochrome legible surfaces. Loading overlay appears only for real asynchronous waits. No fabricated online/offline/OS/version claims.

Protected changes are limited to `adapters/control-center/src/server.ts`'s **three exact static allowlist entries**: `/ascii-cycle.js`, `/assets/wordmark-field.webp`, and `/assets/ascii/outer-field.webp`. No relay, auth, principal/device policy or agent code is changed. Session, pairing, directory and revocation contracts stay authoritative.

## Executed checks

- Isolated local visual/synthetic fixture suite: **22/22 passed** after test-first checks for CSS correctness and removing glass-blur effects.
- Isolated local Node animation sampler suite: **3/3 passed**.
- Chromium mock-based browser fixtures include sign-in, five-view navigation, user image rendering, four viewport sizes, stale-directory clearing, pairing owner confirmation, exact-ID revoke, late sign-out and reduced-motion behavior. They are *synthetic*, not production device evidence.
- GitHub Ubuntu `control-center` job on code commit `f15d336`: **passed** real local relay HTTP/security tests, TypeScript checks/build and headless Playwright acceptance.
- Windows `control-center` and overall quality matrix, plus CI at the final documentation commit, remain **pending verification** at the time of this report.
- An unrelated Ubuntu `quality` job on `f15d336` failed in `browser/bridge` test B6 CDP operational path after a test timeout: 62 passed, one canceled. No `browser/bridge` source was changed in this feature branch. Confirm independently rather than modifying unrelated functionality.

## Explicit limits and gates

- The user has **no authorized relay client access token** for this portal. Its manual-token sign-in remains unavailable to them until a separately reviewed existing-issuer OAuth code+PKCE integration is authorized and tested. Do not extract tokens from ChatGPT or bypass scopes.
- No Surface process or port changes. The running Surface M2 frontend and its `background_only` device agent are not replaced. Real multi-device authentication, supervisor-recovery and clean-install Windows signing remain unverified.
- A **fresh-context independent code reviewer is not available in this session**. Author self-review and CI checks are not equivalent. Record independent review as a remaining gate, not a pass.
- User artwork has no established third-party/public redistribution permission; public release blocked independently.
- Overall Tetherplane release verdict remains **NO-GO**. PR #22 must remain **DRAFT**, with no merge or deployment absent explicit approval.

## Checkpoint reconciliation — 2026-10-19, verified through connected GitHub API

**Code HEAD reviewed:** `0de64a9539ed0f48b89e2e644f73cb3bacdc2492`, unchanged from the prior accepted code checkpoint at the time of reconciliation. This evidence-document update creates a later documentation-only branch commit; CI for that later commit must be assessed separately and is **not** implied by the code-head checks below.

- [PR #22](https://github.com/muhamedsohaib/Tetherplane/pull/22): open, **DRAFT**, base `feature/control-center-m2-20261019`, 14 changed files, 21 commits at the verified code checkpoint; no merge, deployment or release.
- Exact-code-head pull-request workflow [39306858772](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39306858772): **completed / success**; all four jobs successful: Control Center Ubuntu and Windows, repository quality Ubuntu and Windows. The PR records **19/19 HTTP/security and 11/11 Playwright** on Ubuntu.
- Duplicate push workflow [39306852420](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39306852420): **in progress** when rechecked; Control Center Ubuntu and Windows and quality Windows successful; quality Ubuntu still running. Do not treat the push workflow as completed.
- GitHub workflow artifact lists for both exact-code-head runs: no retained artifacts returned. Consequently CI job success does not independently establish image screenshot quality or public redistribution rights.
- GitHub review submissions: **0**; inline review threads: **0**; top-level PR comments: **0**; requested reviewers (GitHub REST readback): **0** after submitting a Copilot bot review request using the connected API. **Independent whole-branch review is unverified and remains a hard PR approval gate.** An API request returning successfully is not a submitted review.
- Connected live-device probe for Leno returned `disconnected` / `requested device is offline`; no local working-tree or four-device acceptance was performed. Surface's older preview remains historical, not a verified new deployment.
- Execution environment lacked a local checkout, pnpm/cargo binaries and network access to GitHub from its shell. The repository source/diff and review metadata were inspected through the authenticated GitHub connector. **No fresh local test run, image-byte SHA-256 recomputation or screenshot visual acceptance** was performed during this reconciliation. CI outcomes are remote GitHub evidence, not independently rerun tests.

### Read-only source / scope inspection

Compared PR #22 changed-file inventory against its base: only Control Center source/frontend/test/docs and two binary derivatives were changed. `adapters/control-center/src/server.ts` has exactly the three approved static allowlist additions; no existing session handler, relay or agent changes in the PR diff. The delivered `ascii-cycle.js` samples `[0,1,2,3,2,1]` with 700ms hold, 1300ms cosine fade and 12000ms wrap, confirmed by source inspection and supported by the recorded Playwright test. The persistent central background has `object-fit:contain`; fidelity to the supplied original and edge tiling is documented but **not newly visually independently reverified**.

**Self-inspection only (not independent review):** No confirmed Critical or Important defect was established in the examined changes; this does **not** assert the full twelve-category security/UX independent-review gate passed. One **Minor** styling observation is deferred: `public/style.css` has `margin:0 0:52px` in `.view-intro`, an invalid CSS declaration; there is no verified functional failure or red-green reproduction, so no untested production change was applied. Any additional findings from an actual independent reviewer must be triaged Critical/Important/Minor and fixed with RED→GREEN regression evidence before authorization.

### Decisions and remaining gates

**No implementation/runtime changes during reconciliation.** The previously resolved pairing/logout afterEach timeout was not reopened. No production OAuth configuration, scopes, client identity or device policy was touched. The branch stays DRAFT with independent review outstanding, and no merge/deploy/release authorization. A browser authorization-code + PKCE flow using the existing issuer/resource/scope is the smallest separate next architectural task; first confirm an already-approved registered client's redirect URI and browser-flow eligibility **read-only**, then propose the bounded integration without creating a client or changing production identity settings.

**Frontend PR verdict:** source implementation and exact-code-head PR CI are in place; **not ready for final human approval** until independently submitted whole-branch review, any resulting Important/Critical fixes with passing exact-HEAD CI, and visual/artwork evidence checks are completed. Overall Tetherplane release stays **NO-GO**.
