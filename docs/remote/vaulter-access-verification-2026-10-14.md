# Vaulter access verification — 14 October 2026

This report distinguishes historical observations, fresh Leno probes and source
verification. It does not certify production release readiness or authenticated
remote filesystem/browser access.

## Access history

The retrieved chats expose only their latest five turns and omit some assistant
content. This is a bounded evidence review, not a complete transcript audit.
Times below are Asia/Dubai (+04:00).

| Path | Observed evidence | Limit |
| --- | --- | --- |
| Surface to Vaulter SSH, LAN | 12 Oct 09:17: noninteractive SSH through Surface's configured host alias ran a hostname-guarded remote command successfully. | Historical; not retested and no Surface access authorized in this execution. |
| Surface to Vaulter SSH, Tailscale | 12 Oct 23:39: remote Tailscale ping ran through SSH. | Historical; from a separate project conversation. |
| Surface and Vaulter Tailscale | Reciprocal pings and unattended service state observed on 12 Oct. | Does not establish Leno SSH authorization. |
| Apparent Leno to Vaulter network | 14 Oct 00:40: Tailscale ping, TCP reachability and an established agent connection observed. | Source hostname was not printed in that older output. |
| Apparent Leno to Vaulter HTTPS | 14 Oct 00:41: health/readiness returned 200 with certificate validation; an alternate service port timed out. | Health is separate from authenticated capability execution. |
| Leno to Vaulter SSH | 14 Oct 01:59–02:00: existing explicit Leno key rejected. | Changing destination address cannot grant that key authority. |
| MCP endpoint | Unauthenticated GET returned 401. | Expected authentication boundary; not a general discovery failure. |

Evidence chats: Email invitation strategy
(`6ace6a56-f214-83ed-a7c7-cc98fa2d7c4a`), Check Leno Device Status
(`6ace9822-e178-83ed-af48-6d49c9072f5b`), Mesh Connectivity Status
(`6acb8144-5d3c-83eb-af7d-f0ff3b9fecd9`), Connect Surface Devices
(`6acd335a-b304-83eb-9c25-0588c25557da`), Assess Tetherplane Invitation
(`6acd6e88-2984-83ed-82ac-7bf5993eaa05`).

## Fresh execution evidence

- Local execution hostname is LENO; canonical checkout is present. Main on GitHub
  and local base HEAD both resolve to `5feee084eb24bfd4831ab42840bb5f10dafc8113`.
- Fetched recovery branch `fix/vaulter-guarded-orphan-recovery-20261013` at
  `5ac2bfa7fd43a4db86e5e14ebfb0890b790e9970`; its recovery document claims live
  supervision restoration. This session has no authorized authenticated Vaulter
  executor to independently recheck that claim.
- Leno, Vaulter and Surface appear online in the Tailscale directory. A fresh
  Leno-to-Vaulter ping succeeds. SSH rejects the existing Leno identity over both
  LAN and tailnet addresses with permission denied.
- Health/readiness return HTTP 200 with TLS certificate verification result zero.
- Both saved user Tetherplane connections in Composio are marked active, but
  actual `device(op=list)` calls return Authentication required. A later
  `device(op=status, device=Leno)` check returned the same error after the user
  reported reconnecting through Composio.
- User screenshots show both ChatGPT plugins completing authentication and then
  reporting Authentication succeeded, action discovery failed.
- Protected-resource metadata matches the exact MCP resource, configured Auth0
  issuer and required `tetherplane:access` scope. No credential values were read
  or returned.

## MCP discovery proof and remaining authentication boundary

Fresh local HTTP probes used normal MCP headers and session continuation:

| Request | initialize | initialized notification | tools/list |
| --- | --- | --- | --- |
| Anonymous, protocol 2025-06-18 | 200, same protocol | 202 | 200, exactly six tools |
| Anonymous, protocol 2024-11-05 | 200, same protocol | 202 | 200, exactly six tools |
| Synthetic invalid bearer, requested 2026-07-28 | 200, negotiated 2025-11-25 | 202 | 200, exactly six tools |

Tool names are exactly device, files, process, browser, desktop and batch. OAuth
security descriptors were present in both descriptor locations. These probes
establish local discovery, not authenticated tool execution or cloud reachability.
An external web-fetch attempt could not access the endpoint; that tool failure
alone cannot establish whether public Funnel routing is working.

The source verifier independently checks token format/signature, issuer,
audience, expiry, required scope, and exact subject/client binding. Later
requests must retain the bearer identity of an authenticated MCP session. The
current generic error cannot identify which check rejects the real client.

One configuration hypothesis is Auth0 resource/audience handling. ChatGPT sends
the resource URL; Auth0's tenant resource parameter profile affects whether it
is treated as the API audience. Public discovery does not reveal that setting.
Do not change audience, bindings or authorization policy based only on this
hypothesis.

References: [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth),
[Auth0 tenant settings](https://auth0.com/docs/api/management/v2/tenants/patch-settings).

## Browser source repair

`browser.status` previously returned available=true from cached capabilities even
after the real browser disconnected. The service now awaits its backend's
read-only page observation before returning the existing compact status. It
discards page contents and does not synchronize the bridge ownership registry.
Extension grant expiry may still narrow authority locally, as in ordinary page
observation.

RED: coded provider failure incorrectly returned success; closed real CDP browser
incorrectly reported success. GREEN: six RPC tests and bridge typecheck passed,
including empty/populated page privacy and real disconnect. Independent review
found no Critical/Important issue. Minor deferred test gap: happy-path tests do
not independently assert that bridge ownership registration was never called.
Production Rust RPC deadlines bound the call; the direct TypeScript service
inherits the existing backend command timeout behavior.

## Verification and continuation

Fresh TypeScript typecheck/build, Rust format/Clippy, unsafe scan and tracked-tree
public hygiene passed. Initial concurrent browser runs timed out in the two CDP
integration cases and B6 operational integration. An isolated traced B6 run
passed unchanged, and the later serial workspace run passed all 67 browser tests.
Startup contention is plausible; an exact operating-system root cause was not
established, and no timeout or product code was changed to hide these failures.

Final source verification: `cargo fmt --all -- --check`,
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`,
`pnpm -r typecheck`, `pnpm -r build`, authored unsafe scan, dependency tree and
diff/public hygiene all exited zero. Rust tests: 137 passed, zero failed/ignored
across 33 summaries. TypeScript workspace tests: 281 selected tests passed, zero
failed/cancelled, including 29 E2E tests. The full test invocation was
`pnpm -r --workspace-concurrency=1 --no-bail test --test-concurrency=1` with a
process-local Node test skip pattern for the two explicitly excluded tests.

The desktop test that activates fixture windows and B8 test that reads global
clipboard state are explicitly excluded from unattended background verification.
They remain operator-authorized acceptance work. Release/package, Linux container
and authenticated remote acceptance are separate gates.

Primary continuation: restore actual authenticated execution through the existing
OAuth Tetherplane connection, prove a device identity, then perform a bounded
allowed-root file read and read-only browser probe followed by an owned verified
browser action. Preserve the local Policy Broker and ownership boundaries.

Surface's historically authorized SSH identity is a recovery option only after
the user authorizes Surface targeting. This execution neither accesses Surface
nor copies its keys, changes Vaulter authorized keys, restarts services or uses
RDC against Vaulter.
