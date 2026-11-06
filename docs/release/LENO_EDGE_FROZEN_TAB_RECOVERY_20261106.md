# Owner-authorized Edge tab reliability gate — 2026-11-06

## Confirmed live state
- Production Leno agent is authenticated/ready on managed CDP port 17655; the authenticated owner Edge extension host is available on ports 17657/17658.
- No current `https://app.lumalabs.ai` owner-shared grant was available at 16:06 Dubai. No unauthorised browsing or private page-content retrieval was attempted.
- Earlier owner-profile snapshot briefly passed at 95 nodes, 49ms and six repeated cycles, but later direct owner snapshots timed out at ~5 seconds while page listing remained responsive. Root cause in the actual Edge tab remains UNKNOWN.

## Verified browser platform behavior / credible mechanism
- Chromium tabs API (Chrome 132+) provides `frozen` and `discarded` flags. A frozen tab cannot execute tasks or timers, and a discarded tab is unloaded until activated.
- Microsoft Edge's Sleeping Tabs feature freezes inactive tabs. An extension API call targeting a sleeping/frozen tab can stay pending until the owner activates it.
- Sources:
  - https://developer.chrome.com/docs/extensions/reference/api/tabs
  - https://support.microsoft.com/en-us/edge/learn-about-performance-features-in-microsoft-edge
  - https://github.com/microsoft/MicrosoftEdge-Extensions/issues/134
  - https://github.com/w3c/webextensions/issues/527
- This mechanism is plausible, NOT proven to be what caused the earlier Luma AI renderer stall.

## Isolated source change
- Browser adapter preserves optional browser-reported `frozen` and `discarded` lifecycle flags.
- The controller re-reads current `chrome.tabs.get` before an owner-authorized operation and passes these flags to the page agent, without elevating ownership or storing them as durable permissions.
- Page observations and non-navigation DOM mutations reject with typed `tab_suspended` **before** `chrome.scripting.executeScript` when the tab is known frozen/discarded.
- No automatic activation, forced reload, change of Edge sleeping policy, browser grant, OAuth, host pin, relay, or user privileges.
- If Edge does not expose lifecycle flags, the existing bounded snapshot timeout remains as the fallback; it does not guarantee that an unfrozen page will respond.

## Local evidence
- Browser-extension TypeScript typecheck PASS.
- Browser-extension 86/86 tests PASS, including frozen/discarded read/action denial before injection.
- Pure stability + router 20/20 tests PASS; exported test shows no private content or URL path.
- An isolated real-Edge profile using the modified `background.js` and unchanged authenticated host passed: real local pairing, owner tab permission, eight overlapping snapshot/page-list cycles, semantic action, origin checks, revocation and cleanup. This is not equivalent to the owner's live profile.
- New **read-only** `scripts/browser-owner-stability.mjs` can test 5-60 authorized snapshots and report only counts, typed failures, and percentile latencies. It does not write page contents, page IDs, credentials or tokens.
- Private Windows no-console candidate from CI run 42216821697: SHA256 `405267279fbeaf9cdd9fcedee49916a6f2a0f964b871f99b9041f5f7c508104b`, source `ce7c7b16ed3f314a47e92357d0ab0a3058da4058`, PE GUI subsystem 2, 7,252,992 bytes, NOT signed, NOT installed. Read-only combined stdio canary PASS with owner backend online and unknown human tab denied. All temporary processes/ports cleaned.
- The first candidate workflow's Windows build job was successful; the Ubuntu setup job failed because of a typo in a pinned `actions/setup-node` SHA. A branch-only source fix was prepared. No release or automatic deployment workflow exists in this candidate.

## Remaining release blockers
1. CI for latest frozen-tab guard/source is pending. Recheck exact remote commit and workflow jobs; do not claim production readiness merely from source unit tests.
2. Owner must explicitly reauthorize a non-sensitive Edge tab. For the controlled Luma AI experiment, allow `https://app.lumalabs.ai` only, observe-only if possible, for at least 30 minutes.
3. Owner may optionally exclude that one origin from Edge Sleeping Tabs via `edge://settings/system/managePerformance` → **Always keep these sites active**; do not change all-site browser policy. Compare before/after to validate actual causality.
4. Run `node scripts/browser-owner-stability.mjs --expected-origin=https://app.lumalabs.ai --cycles=20 --interval-ms=1000` while tab is foreground, then repeat with Edge not foreground. Require 20/20 per run and no typed timeouts; a sleeping tab must be reported as `tab_suspended` rather than delayed indefinite execution wherever the browser exposes the flag.
5. Prepare a new owner-approved timed-rollback cutover to the separately validated candidate agent and combined router only after real user-profile acceptance. Require remote plugin browser.pages + browser.snapshot through production; accept only after true end-to-end verification.

## Deployment boundary
All latest frozen-state source edits and browser builds remain isolated from Leno's installed extension and production agent. Side-by-side tests cannot substitute for owner-granted production browser acceptance.
