# Owner pairing review and device-ID rebind safety — 2026-11-04

## Context and scope

- Source base: clean branch commit 1ae6321edd97dd948a15529e2fa85ea1e47ec4bf.
- Existing public developer beta: devbeta-20261104.1, unchanged.
- Existing candidate: the owner-approved new-device workflow; synthetic owner approval and native remote MCP acceptance passed on isolated Windows GitHub Actions.
- Existing four-device topology, production OAuth/DCR, protected installed agents and public release have NOT been modified by this change.

## Reproduced security issue

Before this fix, relay/src/devices/registry.ts allowed two unexpired pairing codes for the same device ID. The second owner's approval could replace the first account/device binding, because approval did not recheck that the target device was already paired.

The regression was written and run against the prior source before intervention:
"simultaneous pending device codes cannot overwrite a different owner account" -> FAIL ("Missing expected rejection").

The issue concerns account-binding integrity, not a hypothetical 30-second performance target. Do not publish the old pairing UX as broadly safe without a fixed relay.

## Smallest intervention

- Enforce a single active pending pairing request per device ID.
- Recheck existing active binding at approval, independent of start-time checks.
- Purge expired pending pairing requests on new starts; deny allocation when 512 pending codes are active to bound unauthenticated storage.
- Ensure newly generated codes are unique within the pending set.
- Add authenticated POST /pair/preview with body {"userCode":"ABCD-1234"}. Response includes *only* deviceId and expiresAt; no secret, credential hash or automatic approval.
- Preview and approval share a maximum 12 attempts per 60-second window per verified account, returning HTTP 429 / rate_limited after exhaustion. This protects the short-code review path against repeated guessing without creating new authentication privileges. Account attempt state is bounded and expired budgets are pruned.
- Require existing authenticated identity on preview, as on approve. No new auth method, OAuth client registration, scope, or permission grant.
- Set no-store on management JSON responses.

The preview supports the next human-facing approval UI. **It is not that UI.** Callers still need a valid existing authenticated account session for /pair/approve and an explicit human authorization decision. A ChatGPT tool invocation by itself must not be treated as proof of independent human consent.

## Verification requirements

1. New duplicate-code regression passes, and a second code cannot silently rebind an account.
2. Preview requires bearer authentication; returns only device ID and expiry; does not bind credentials or mutate pending state.
3. Consumed and expired pairing codes fail closed.
4. Unique-device pending requests are bounded and expired requests can be replaced. Authenticated short-code probing is rate limited across both preview and approval.
5. Static and signed OIDC end-to-end tests verify owner preview, missing bearer denial, and missing required OAuth scope denial.
6. Existing control, identity, relay OAuth and remote E2E tests remain green on Windows and Linux CI.
7. No real-device OAuth enrollment claim until an independently authorized new Windows machine completes a genuine HTTPS/WSS connection under its own identity with explicit owner approval, status-only permission denial, reconnect and revoke.
8. Do not merge, deploy auth changes, replace any protected agent, or publish a new beta without separate explicit approval.

## Product opportunity and next acceptance

The next product step is an **owner-reviewed approval screen** within an independently authenticated first-party owner session. It should show the device ID and expiration retrieved from /pair/preview and require the owner to approve the pairing. Never ask the owner to export the ChatGPT OAuth token into a beta CLI. Human authorization needs a trustworthy owner-operated channel rather than relying on a model to declare consent.

The public ZIP's local Windows acceptance and 1.115-second local status response remain separate from live remote onboarding. The under-30-second goal remains unverified.
