# Tetherplane Control Center: first functional milestone

Implementation requested on 2026-10-19. This increment is a human portal adapter,
not a replacement control plane or a release-readiness claim.

## Intent and canonical basis

Provide a useful local web portal without buying a domain or hosting. Preserve
the four-device installation, existing identity/OAuth scopes, relay routing,
six-tool MCP interface and device-local final policy authority. The canonical
2026-09-17 design, roadmap and local-core plan remain authoritative.

Inspection baseline: `origin/main` at `5feee084`. Existing contracts are
`relay/src/devices/control-http.ts` and `registry.ts`: authenticated `GET /devices`
returns account-bound pairing/revocation records; authenticated
`POST /devices/:deviceId/revoke` checks ownership and disconnects the device.
There is no presence, version, policy-administration or interactive portal login
contract in that directory API. Pairing is not connectivity evidence.

## Selected approach

Add `adapters/control-center`, a separate Node.js service and static browser UI.
Bind exclusively to `127.0.0.1`, default port 8790. An operator supplies a fixed
relay origin at startup; HTTPS is required except numeric loopback HTTP for
local development. Never accept proxy targets from browser requests, follow
upstream redirects, load third-party scripts/fonts, or open a browser on startup.
This adds no production relay/agent/auth changes and needs no domain or hosting.

A same-relay UI would require deploying protected infrastructure. A browser-only
client would retain bearer credentials in the browser and need relay CORS changes.
The local service avoids both changes and leaves existing contracts authoritative.

## Authentication and request boundaries

The user enters an already authorized relay client access credential into a
password field. No client registration, new scopes, embedded credentials,
unverified JWT identity parsing or production configuration changes are allowed.
Validate the credential through `GET /devices` before creating a session. Keep
the bearer only in local service memory; issue a random opaque HttpOnly,
SameSite=Strict cookie and a separate CSRF token. Clear the input immediately.
Sessions expire after at most 15 minutes and disappear on service restart.
Revalidate through the existing relay on every directory or revoke request.
An upstream authentication denial invalidates the local session.

Require exact local Host and same Origin for mutations, reject cross-site
requests and non-JSON mutation bodies, enforce CSRF for session mutations,
bound request/response sizes and upstream timeouts, refuse redirects, and return
sanitized errors. Use no-store, restrictive CSP, frame denial and nosniff. Do not
persist credentials, send them in URLs, log upstream bodies, or store them in
browser local/session storage. This protects against web-origin attacks, not
malware with the same local OS privileges or an already-compromised browser.

## Functional experience

Show only devices returned for the authenticated account, pairing/revocation
timestamps, last successful directory refresh and explicit connectivity/version
values of "Not reported". Do not insert four placeholder devices or infer
online/offline from directory membership. Empty, loading, denied, expired,
unreachable and malformed-response states must be distinct and actionable.

Allow refresh and local sign-out. Revocation requires choosing a returned,
non-revoked device and typing its exact ID, then a same-origin CSRF-protected
request. Recheck directory ownership before forwarding to the existing revoke
endpoint. Explain that revocation disconnects relay access and re-pairing is
needed to reconnect. Never replay a failed mutation automatically; refresh after
an uncertain result. Pairing, remote commands, policy editing and organization
administration remain outside this increment because adequate UI contracts are
absent or require separate architecture work.

Use the supplied logo and ASCII-loop media where available. Keep attribution and
hash provenance; load media locally, support reduced motion, and never delay
access with an artificial splash timer. Use semantic labels, keyboard-accessible
forms/dialogs, responsive layouts and text-safe rendering of all relay data.

## Proof and remaining gates

Test against the real RelayServer with isolated in-memory registry and synthetic
credentials; never connect tests to the installed four-device runtime. Cover
authentication/account separation, expired credentials, revocation and
confirmation, CSRF/Host/Origin denial, bounded malformed upstream responses,
redirect rejection, logout, static security headers and browser state handling.
Run typechecks, builds and applicable repository gates. Hosted Windows/Ubuntu CI
runs the complete existing suite plus portal tests. Obtain independent review.
Record exact commits and CI heads.

No merge, production deployment/runtime access, OAuth client creation, release,
domain registration, hosting purchase or paid service is authorized. Real-device
portal acceptance, clean-install distribution, richer auth onboarding and any
organization administration remain separately verified gates.
