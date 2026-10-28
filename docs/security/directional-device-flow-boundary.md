# Device-to-device directional data policy — isolated laboratory contract

**Status:** source-only test framework, not installed, not wired to the relay or to device providers. No clipboard synchronization, file movement, remote shell or browser access is enabled by this change. This work is stacked on unmerged browser PR #85; protected authentication and the four-device topology remain unchanged.

## The user-facing option

An owner may define a separate **send** and **receive** policy for each device pair, principal, data class, exact logical resource, byte budget and expiry. This is **application-level data flow**, not a physically one-way TCP or WebSocket: a transport still exchanges connection handshakes, control acknowledgements and small status messages.

Example, with arbitrary device labels A and B:

| Content | A sends to B | B sends to A |
| --- | --- | --- |
| Private clipboard text | Permit with expiry | Deny |
| Files | Permit specific provider-approved report | Deny |
| Links | Permit only approved URLs | Permit only approved URLs |
| Command request | Permit only a fixed owner-approved command template | Deny |
| Command output | Deny full stdout/stderr | Deny |
| Browser data, screen pixels | Deny | Deny |

In this example A can deposit a report onto B but cannot **take** B's files, clipboard, command output, screen or browser data. File writes on B must separately use B-approved staging roots and atomic write/rollback. Per-stream and cumulative size limits must be checked at each chunk, not just at the first request.

## Two approvals, not one

For any actual movement B → A of a resource:

1. A must be an **authenticated receiving device** authorized to receive that exact data class and resource.
2. B must independently authorize **sending** that data to A, with a principal, scope and TTL.
3. Both decisions must remain valid at every transfer step; revocation stops future chunks and terminates work in flight.
4. B enforces the outbound decision **before material is read, returned or sent**, not solely in A's UI.
5. A enforces its inbound decision and destination constraints; the relay should enforce an additional compatible check without becoming the sole source of trust.

The current dormant `DirectionalFlowPolicy` implements the narrow intersection of two grants. Its `TrustedTransferIntent` is deliberately not a JSON deserializer: real source/destination IDs, principal and resource scope must be derived from authenticated connections and provider-resolved resources.

## What is already in Tetherplane (October 28, 2026)

- `agent/tether-core/src/policy.rs`: per-principal capability allowlist, target-device restrictions, and filesystem allowed-root validation.
- `relay/src/routing/device-router.ts`: authenticated principal and target-device routing. **No attested originating physical device in the invocation**, so an arbitrary client-supplied `source_device_id` is not safe to accept.
- `agent/providers/desktop/src/private_clipboard.rs`: bounded Tetherplane **private** clipboard, not the global Windows clipboard.
- The native WebView2 fixture in draft #85: separate short-lived local host capability and revocation, but **not an authenticated owner-issued website grant**.

The current base policy treats `filesystem.read` as locally read-only. **It is not read-only with respect to remote confidentiality**: sending returned content to another machine is an outbound transfer. Do not confuse side-effect classification with data egress.

## Threats not solved by the dormant evaluator

- Arbitrary PowerShell or shell execution can read prohibited files and exfiltrate over network, even if `filesystem.read` and stdout are blocked. Restrict remote commands to reviewed templates and apply independent process/network boundaries before claiming isolation.
- Other channels include `filesystem.list/read_many`, search results, clipboard references, browser snapshots, screenshots, process stdout/stderr, DNS, HTTP, logs and diagnostic fields.
- File-reference strings are not file bytes. Canonicalize/authorize the actual path and protect against reparse-point, symlink and time-of-check-to-time-of-use races.
- Links may contain access tokens or credentials in URL parameters; sanitize and approve schemes/hosts. A link is not harmless merely because it is short.
- Grant records must be issued, signed/stored and revoked by the owner of the relevant endpoint. Untrusted callers cannot choose their own trusted IDs, resource scopes, timestamps or byte counts.
- Control-plane acknowledgements (e.g. `allowed` or `denied`) still traverse a nominally one-way data path. Privacy-sensitive metadata must be bounded/redacted too.
- Egress controls must apply to streaming chunks and side channels, not only a response envelope.
- A malicious process with the same OS user privileges may bypass a library-only check; OS-enforced host isolation and adversarial acceptance are separate release gates.

## Release gates

1. Authenticate/attest device A as a source principal at the relay and B as the target, independently from client-supplied payloads.
2. Add owner UI/CLI to issue and revoke grants with explicit **direction**, operation, peer, resource, expiry and byte limits. Never enable both ways by default.
3. Enforce the source policy in the native provider and the sink policy in the receiving device, with denial before I/O, metadata and result serialization.
4. Independently test one-way clipboard, staged files, links, template commands and blocked reverse extraction on two physical authorized devices; include DNS/network and command-output bypass attempts.
5. Verify simultaneous revocation, disconnect/reconnect, process crash and four-device regression. Maintain existing authentication and protected branch policies.

**Verdict:** the two-direction policy can be modeled and unit tested today. Actual secure cross-device transfer/synchronization remains **NO-GO** until these trusted identity and enforcement gates pass.
