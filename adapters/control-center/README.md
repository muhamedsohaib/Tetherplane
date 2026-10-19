# Tetherplane Control Center

A local web portal for the existing authenticated relay device directory. No
purchased domain, hosted frontend, subscription or new OAuth client is needed.
The portal runs separately from the relay and never starts or reconfigures agents.

## Start on Windows or Ubuntu

Prerequisites: Node.js 22.18+ (or Node.js 24), pnpm 10, and access to an existing
authorized Tetherplane relay. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @tetherplane/control-center build
pnpm --filter @tetherplane/control-center start --relay-url http://127.0.0.1:8788
```

That example expects an **already running development relay** on numeric
loopback. For your existing remote relay, replace the origin with its HTTPS
origin, without `/mcp` or other paths. Do not change its OAuth resource/audience,
scopes, client registrations or device credentials. Use `pnpm.cmd` on Windows
if your shell blocks the pnpm PowerShell wrapper.

Open `http://127.0.0.1:8790` manually. The optional `--port 8791` selects another
local port. The listener is always `127.0.0.1`; it cannot bind to the LAN.
Press Ctrl+C to stop the portal and erase its in-memory sessions. Restarting it
does not alter relay pairing or device state. Never expose this listener through
a tunnel, reverse proxy or port forwarding.

## Sign in using existing authorization

Enter an **existing relay client access credential** in the portal's password
field. For an OIDC relay this is an already-issued access token accepted for its
configured audience, scopes, subject and client binding. For a controlled local
static-auth relay, use the existing configured client token. An ID token, device
credential, browser cookie or MCP discovery result is not client authorization.
Obtain the credential through your established authorized workflow; do not
extract it from a human browser profile or paste it into chat, commands or files.

The first milestone deliberately has no automatic OAuth login or token refresh:
the current relay contracts do not provide a portal sign-in session. A denied or
expired credential requires a fresh authorized credential. The portal does not
decode a JWT to invent an identity or register a replacement OAuth client.

The relay validates every list/revoke request. The local service holds the bearer
in memory behind an opaque HttpOnly SameSite=Strict cookie for at most 15 minutes.
The browser field is cleared immediately on submission; credentials are never
saved to local/session storage, disk, URLs, or request logs. Local sign-out ends
the portal session; it does not revoke your upstream access token. This local
boundary does not protect against malware with the same OS privileges or a
compromised browser. Existing relay TLS and authentication remain authoritative.

If you need a new isolated development relay, follow the existing
[self-host guide](../../docs/remote/self-host.md). Do not create a replacement
production relay or change an installed device's pairing as part of portal setup.

## What the portal reports and permits

- Only device records returned by the authenticated account's `GET /devices`.
  The presence signal is attached to those scoped records; it does not enable
  enumeration or probing of devices belonging to another account.
- Exact paired/revoked timestamps plus the last successful directory refresh.
- Authenticated **relay transport** state is reported at each directory refresh
  when the relay supports `relayConnected`. A connected route does **not**
  establish device responsiveness, agent health, policy mode or successful tool
  execution. An absent route is only a transport observation. Older relays
  continue to show **not reported**; agent version remains **not reported**.
- Explicit refresh and local sign-out.
- Revocation through existing `POST /devices/:id/revoke`, after typing the device
  ID. Ownership is freshly checked and the relay enforces it again. Revocation
  disconnects relay access and invalidates the device credential; re-pairing is
  required to reconnect. The portal never automatically retries a mutation.

The four-device topology is neither hard-coded nor modified. An empty directory
shows no devices. No device is represented as online/offline based on pairing.
After failed refreshes, stale cards are cleared. If a mutation times out, its
outcome is uncertain: refresh before taking another action.

## Pair a device and recover access (Milestone 2)

On a device you are authorized to manage, use the established
[device-side pairing workflow](../../docs/remote/self-host.md#pair-a-device)
for the same relay configured when you started Control Center. The raw device
credential stays on that device. Sign into Control Center with your existing
relay client credential, enter the short code under **Add a device**, and confirm
that you requested it on your authorized device. Approval uses the existing
authenticated `POST /pair/approve`; the refreshed account directory shows the
actual pairing record. Codes are single-use and expire at the relay (normally
ten minutes). The portal permits ten well-formed approval attempts per minute
across its local sessions. It does not generate credentials or begin pairing.

If transport drops, the already running agent retries its existing outbound
connection. There is no remote restart/reconnect endpoint in this contract.
Directory refresh reports pairing state only. After confirmed revocation, use
a **fresh credential and new code** through the device-side workflow, then approve
that code here. When you pair with a fresh credential, the revoked credential
remains invalid. The existing relay does not track credential-reuse history;
explicitly approving a reused credential hash can authorize that credential again.
Always generate a fresh device secret when recovering access. Preserve the existing
device-local principal, allowed paths and `background_only` policy.

Never approve a code supplied by someone else. A pairing code authorizes account
access to the device associated with that code; the current backend has no
pre-approval device preview. Verify it directly on your authorized device.
Competing pending codes for an approved device are invalidated, so they cannot
replace an active account binding or restore an old credential after revocation.

Approval inputs clear immediately. Failed or uncertain approvals are never
automatically retried; the directory clears and another approval is disabled
until a successful refresh. Sign-out/expiry prevents a later local submission,
but cannot cancel a mutation already delivered to the relay. Refresh after an
uncertain result and revoke an unwanted returned binding through the normal
confirmed workflow. Pairing changes relay access, never device-local policy.

Remote commands, reboot, service control, policy editing,
organization administration and device installation are outside this increment.
Exactly six AI-facing MCP tools remain unchanged; the device-local Policy Broker
remains final authority.

## Troubleshooting

| Result                | Next step                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Cannot start          | Check `--help`, a free local port, and an HTTPS relay origin (numeric loopback HTTP only for development).            |
| Authorization denied  | Check your existing credential's expiry, audience, scopes and subject/client binding. Do not weaken relay validation. |
| Empty directory       | Check the account used by the credential; do not assume unlisted devices are offline.                                 |
| Relay unavailable     | Check the configured relay address, reachability and TLS trust. Redirects and unsafe responses are rejected.          |
| Local session expired | Sign in again. Portal restart also clears all sessions.                                                               |
| Device access revoked | Use the established pairing workflow only when separately authorized.                                                 |

## Verification

```sh
pnpm --filter @tetherplane/control-center typecheck
pnpm --filter @tetherplane/control-center test
pnpm --filter @tetherplane/control-center exec playwright install chromium --only-shell
pnpm --filter @tetherplane/control-center test:browser
```

Linux browser tests also need Playwright's host dependencies; CI installs them
with `playwright install --with-deps chromium --only-shell`. Playwright is a
development dependency. Its test browser is not a product/browser-provider
dependency or distributed application payload.

Tests use ephemeral local relays, in-memory registries and synthetic credentials.
They never target Leno or the existing four-device deployment. Browser tests run
headlessly in new isolated contexts, covering real sign-in/directory/revoke/logout,
errors, empty state, reduced motion, mobile layout and sign-out/refresh races.
Milestone 2 additionally covers real HTTP pairing, authenticated credential
acceptance, confirmed revocation and fresh re-pairing, competing-code rejection,
pairing confirmation/CSRF/rate limits, uncertain outcomes and sign-out races.
Server tests cover account isolation, authentication expiry/denial, CSRF and
Host/Origin checks, method/body limits, redirects, safe response projection and
static security headers. Hosted Windows and Ubuntu jobs run these in addition to
the existing repository gates. No live real-device acceptance is implied.
The [milestone verification report](../../docs/verification/2026-10-19-control-center-milestone.md)
records commits, independent review, test evidence and release gates.

## Artwork

The supplied logo and loading-loop frames are served locally and unchanged.
See [asset provenance](public/assets/PROVENANCE.md). Loading media never implies
device connectivity. Reduced-motion users see a static frame, animation runs
only during loading, and a pause control is available.

Remaining release gates include independently witnessed authorized-device use,
clean-install/onboarding acceptance, an approved interactive sign-in contract,
and applicable organization-administration requirements. This milestone does
not fulfill the separate organizations-first specification or authorize release.
