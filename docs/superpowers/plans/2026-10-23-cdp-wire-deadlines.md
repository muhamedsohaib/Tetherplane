# CDP wire deadlines implementation plan

**Goal:** Bound an unresponsive owned Chromium connection or command without replaying an operation or concealing a failure.

**Architecture:** Keep the existing CDP transport and owned-profile cleanup. Apply independent connection and command deadlines in `CdpWire`; preserve response correlation, events and typed errors. No live browser, device, grant, OAuth or deployment configuration changes.

**Spec:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`, sections 6, 13, 14 and 18.

**Constraints:** Exactly six MCP tools; local policy final authority; background_only; synthetic loopback peers and disposable owned browser profiles only. Preserve original 30-second B6 test and 5-second download observation deadline.

## Work

- [x] Reproduce a connected CDP peer withholding a reply and a TCP peer withholding its WebSocket upgrade; both must produce typed timeout errors within an explicit budget.
- [x] Add the smallest deadlines and release timers/listeners on success, disconnect, explicit close and send failure. Never resend a timed-out command; discard late replies without confusing later request IDs.
- [x] Verify out-of-order success, protocol error, disconnect and cleanup with actual loopback sockets.
- [x] Run browser (68), final portal (41) and relay (91) suites; workspace TypeScript typecheck/build and diff checks. Workspace test run reached native E2E pretest, which is blocked locally by unavailable `link.exe`; do not claim local native E2E passed.
- [x] Obtain independent review: 29 focused tests passed with no remaining actionable finding. Initial review findings and mutation/replacement-session follow-ups were reproduced RED before correction.
- [ ] Run the five-trial Windows CDP and full native tests on hosted CI at the pushed source SHA.
- [ ] Push a draft stacked on PR #50. Report exact SHA and distinguish the reproduced transport defect from the still unproven cause of earlier hosted hangs. Keep Vercel and live acceptance holds visible.

## Independent review follow-up

The reviewer reproduced malformed array access levels being persisted and treated as observe, and delayed authority metadata returning after sign-out. Both are reversible source defects within the requested checkpoint scope.

- [x] Reject every non-string grant level before persistence; preserve the current blocked policy and revision on malformed requests; reopen the unmodified policy successfully.
- [x] Fence authority load/save/enforcement results/errors/finalization by the local UI session epoch. Clear prior authority on explicit replacement login. Do not restore prior owner metadata, invalidate a replacement session or unlock its request after sign-out.
- [x] Describe grant edits as immediate while enforcement is active, and staged only while inactive. Preserve all existing owner identity, CSRF, revision and confirmation checks.
- [x] Independently review the final source changes and verify the relay/portal/workspace suites subject to the documented local native-linker blocker. Live owner grants and user sessions remain untouched.
