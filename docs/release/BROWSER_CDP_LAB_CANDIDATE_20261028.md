# Extension-Free CDP Browser Lab Candidate (28 October 2026)

Status: **REVIEW-ONLY / NO DEPLOYMENT / NOT A CONSUMER BROWSER RELEASE**

## Product decision

Browser automation is the principal Tetherplane use case. An absent browser backend
must not disconnect the authenticated core. Core resilience is separately
implemented in draft PR #76. This candidate tests an extension-free way of
reconnecting the browser capability without bypassing device authorization.

## Reused components

- `CdpBrowserBackend` and `launchCdpOwnedBrowser`, with an isolated Chromium
  data directory and ownership limited to Tetherplane-created tabs.
- `BrowserBridgeService` and the existing token-authenticated loopback RPC.
- A new `CdpLabOnlyBridgeService` which restricts model-facing browser RPC
  to one explicitly configured local Browser Lab origin.
- An opt-in `scripts/browser-cdp-lab-host.ts` entrypoint. The environment
  must explicitly enable lab mode and identify a **separate test-only**
  local token file; the host never creates or exports a device credential.
  The browser profile is disposable and deleted by the existing CDP lifecycle.

No Chrome extension is needed. No production OAuth, DCR, TLS, relay, or
Windows security settings change.

## Intentionally hard restrictions

1. Origin must be an exact HTTP loopback origin with a port; arbitrary
   internet destinations, other ports, credentials-in-URL, and local file
   URLs are rejected.
2. No human-owned tab or normal user Chromium profile is attached.
3. The only allowed browser RPC operations are `status`, `pages`,
   `create_tab`, `snapshot`, `navigate`, `close`, `act` and `wait`.
   File upload, global downloads, and diagnostics are not available in
   this proof.
4. Unauthorized website navigation is rejected *before* the browser call;
   a disallowed post-navigation destination is rejected and the owned tab
   is closed. This is **not a production network/redirect security
   boundary**: a request may occur before a post-navigation check.
5. The browser RPC listens on loopback with an ephemeral port and requires
   a locally supplied test token for every handshake and operation.
6. Test-only stdin shutdown lets a Windows runner verify process cleanup
   without forcibly killing the browser and leaving orphan processes.

## Independent acceptance

- Repository: `muhamedsohaib/Tetherplane`
- Draft PR: #77; base `main`.
- CI: `.github/workflows/browser-cdp-lab.yml`, Linux and Windows, plus normal
  repository CI. Check exact commit and all job conclusions before claiming
  acceptance.
- Test: `browser/bridge/test/cdp-lab-host.smoke.ts`. Starts a real
  isolated browser and authenticated RPC, exercises browser actions in a
  local deterministic fixture, denies a wrong token and unrelated website,
  and verifies clean shutdown. The standard unit suite also tests
  authorization/ownership denial with a fake backend.

## Explicit gates for real user websites

Before any persistent signed-in browser profile is created or exposed:

- An owner-initiated (not AI-generated) scoped permission: exact website,
  account, allowed operations, expiration, revocation and sensitive-action
  approval. Default deny.
- A last-boundary enforcement point for redirects, cross-origin frames,
  request destinations, uploads/downloads and every action. A URL-only
  preflight check is insufficient.
- Browser debugging isolation (prefer a process-private CDP pipe or equally
  strong local OS separation), avoiding an unauthenticated DevTools TCP
  endpoint to a credentialed persistent profile. Do not reuse the default
  personal Chrome/Edge profile.
- Agent principal restrictions that deny general process/filesystem access
  to the browser profile for browser-only AI accounts; test bypass attempts
  through every enabled provider.
- User-visible, auditable approval/revocation and negative tests of
  account/credential extraction. No passwords or cookies in model output.
- Real Leno, Surface, VAULTER and RTX acceptance where explicitly authorized;
  correct denial, reconnect, rollback and reboot evidence. Passing CI is
  insufficient.
- Browser-first launch video only after these real-device gates pass.

Microsoft/Google Chrome 136+ requires a non-default Chrome user-data directory
for remote debugging, and security guidance warns that exposing DevTools
to a credentialed browser gives broad session access. The disposable lab
profile is intentional, not a credential-session solution.

## Rollback

The candidate is entirely in a new source branch with no installed binaries.
Do not merge PR #77 or alter existing scheduled tasks. Closing the opt-in
lab host stops its own Chromium process and removes only its disposable lab
profile. Existing production identity and four-device architecture remain
unchanged.
