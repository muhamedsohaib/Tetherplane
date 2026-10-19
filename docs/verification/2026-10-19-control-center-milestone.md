# Control Center milestone verification — 2026-10-19

## Delivered scope

`@tetherplane/control-center` version `0.1.0` runs a web portal on numeric loopback,
using an existing relay client credential. It implements an authenticated device
directory, refresh, local sign-out and exact-ID-confirmed revocation through the
existing relay contracts. It needs no domain, hosted frontend or new OAuth client.

The portal displays pairing/revocation records only. Connectivity and agent
versions are **not reported**; no device status or four-device acceptance was
invented. No live device was queried or managed during this task.

The canonical architecture, roadmap, local-core plan, source-of-truth document,
remote OAuth documentation and current relay/auth/agent implementation were
inspected before implementation. The referenced conversation's user messages
and attachments were available; its assistant responses remained unresolved
content-reference markers. The explicit current implementation request governs
this milestone. User-supplied assets were recovered, inspected and copied
unchanged; their hashes and artwork-license uncertainty are documented in
`adapters/control-center/public/assets/PROVENANCE.md`.

## Git scope

Base: `5feee084eb24bfd4831ab42840bb5f10dafc8113` (`origin/main` at inspection).
Dedicated branch: `feature/control-center-milestone-20261019`.
Isolated worktree: canonical repository `.worktrees/control-center-milestone-20261019`.
The dirty primary checkout and unrelated worktrees were preserved.

| Commit | Change |
| --- | --- |
| `d2b037ebab6979d08872226d7b8357cc0edf961d` | Milestone design and implementation plan |
| `ce61de6668c3500da5b6206ea0d7cde21d65881a` | Functional local portal, supplied artwork, documentation and Windows/Ubuntu portal CI |
| `2d1bae39764f635c7e0e18faf95113746da78281` | Idle credential expiry and stale-response cookie-race fixes |
| `02368408992241054d0775c1d8f425adfb17b48c` | Three existing Rust test assertions made compatible with Clippy 1.99 |
| `9269edcd790a68ed1f4edb7137d93b3782334b4b` | Full supplied ping-pong loading sequence and browser regression |

This report's commit adds deadline-test evidence and documentation. Obtain the
final exact SHA with `git rev-parse HEAD`; the final task response records the
matching hosted CI run after this commit is pushed. No merge, release tag or
deployment is performed.

## Local verification

- Before implementation: protocol **4/4**, relay **72/72**.
- Initial complete non-E2E TypeScript workspace run: **360 tests, 0 failures,
  0 skipped** across ten packages. Desktop-sensitive Rust/E2E fixtures were
  intentionally left to disposable hosted CI instead of the human's computer.
- Final portal HTTP/CLI/security suite: **15 tests**. This includes real
  RelayServer account separation, revoked/expired credential denial, exact-ID
  confirmation, Origin/Host/CSRF checks, media/body/method bounds, malformed and
  oversized relay responses, redirect refusal, and a relay that stalls after
  headers. The latter is interrupted by the five-second deadline.
- Portal headless browser suite: **7 tests**. Real isolated relay sign-in,
  directory, revoke and logout; empty/denied states; failure/recovery; sign-out
  during a delayed refresh; mobile width; reduced motion; supplied loop order.
- Workspace `pnpm -r typecheck` and `pnpm -r build`: passed. Portal-specific
  typecheck/build passed again after the session fixes.
- `cargo fmt --all -- --check`, authored unsafe scan (`UNSAFE_SCAN_OK`), Git
  whitespace checks and supplied-asset hashes: passed.

Tests use only synthetic credentials, in-memory registries, random loopback
ports and new headless browser contexts. No token or credential from the
installed deployment was accessed. The browser tests require a development-only
Playwright download; the app itself has no new runtime dependency or bundled
browser. Playwright's first local installation automatically removed its older
unused cached test-browser versions; no running browser or production agent
was operated. Subsequent CI installs disable cache garbage collection.

## RED → GREEN and independent review

Backend tests first failed on absent server/client modules. Browser behavior
tests failed before the browser controller existed. A failed-revoke test caught
an error hidden behind a still-open dialog; the corrected controller closes the
dialog and exposes the error without replaying the mutation.

Independent whole-branch review identified two consequential session defects:

1. Request-time pruning could retain idle bearer credentials past the documented
   lifetime. A frozen-clock regression returned 200 before scheduled cleanup;
   after the fix it returns 401 without another pruning trigger.
2. A delayed request for a replaced session returned a clearing cookie and could
   erase a newer login. The held-response regression observed `Max-Age=0` before
   the fix; stale responses now invalidate only the old server-side session and
   leave replacement cookies intact. Opaque stale IDs carry no authority and
   expire naturally.

Both findings were re-reviewed as resolved at `0236840`; the reviewer independently
ran **14/14** portal Node tests and found no new consequential issues. The
subsequent loop correction was independently reviewed with no consequential
findings. Its regression failed with blank frames before the fix and passed
with `1 → 2 → 3 → 4 → 3 → 2` afterward. The deadline test adds coverage of existing
client behavior and changes no production logic.

## Hosted CI and baseline failure

Initial run [39243154493](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39243154493)
at `ce61de6`: portal Windows and Ubuntu jobs passed. Both general quality jobs
stopped on existing empty-collection assertion forms rejected by Rust/Clippy
1.99, before reaching the remaining gates. No lint was disabled.

The smallest correction changes three assertions in process/search/desktop
**tests only**, matching the semantics of the existing
`fix/rust-1-99-clippy-assertions-20261019` branch. Run
[39243578642](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39243578642)
at `0236840` subsequently passed the previously failing lint steps; its remaining
jobs were still running when this report was prepared.

The final exact-head run must complete all four jobs: `control-center` and
`quality`, each on Windows and Ubuntu. The existing quality jobs include Rust
tests, the full recursive TypeScript suite including E2E, builds, container-build
smokes on Ubuntu, unsafe scan, and the Windows package/install smoke. A container
build is not a production deployment. CI results must be reported at their exact
commit, without treating earlier portal-only success as a green whole repository.

## Remaining gates

- Authorized real-device portal acceptance across the required installation;
  current production connectivity, version and runtime state remain unobserved.
- Clean-machine install/onboarding, distribution/signing and witnessed recovery
  acceptance. Passing tests do not establish release readiness.
- An approved interactive sign-in/refresh contract to replace manual existing-token
  entry; no new OAuth client or scope was created for this increment.
- Separate organizations-first administration requirements and implementation.
  This portal uses existing account bindings and does not claim organization or
  role administration that the existing API does not support.
- Artwork redistribution rights before public release.

No production relay/auth configuration, installed agent runtime, protected
infrastructure, pairing topology, six-tool MCP interface or local Policy Broker
authority changed. No purchase was made, paid service provisioned, release
published, production deployment performed or branch merged.
