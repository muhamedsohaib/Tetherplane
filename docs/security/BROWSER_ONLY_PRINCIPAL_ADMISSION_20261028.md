# Browser-only agent principal: opt-in security admission (2026-10-28)

Status: **DRAFT, REVIEW ONLY. Not installed or released. Do not use with Amazon or real logged-in websites.**

This checkpoint addresses one specific bypass of Tetherplane's browser grants: a remote agent may have both `browser.*` and unrestricted `process.run`/`filesystem.read`. The grant checked by the browser broker cannot constrain a different provider if the same remote principal can inspect browser profiles, run a shell, or connect directly to the Chromium debugger.

## Independently observed on the authorized Leno device

The existing authenticated Leno v0.1.0 core agent remains healthy and `background_only`. In safe, synthetic-only tests:

1. A disposable Chromium profile launched through the existing CDP code opened a loopback debugging endpoint. An unrelated local HTTP client received Chromium version metadata and a WebSocket debugging address **without the model-facing browser RPC token or site grant**. The profile was subsequently closed and cleaned.
2. A temporary file with **only a synthetic marker** was created in the user's existing Tetherplane acceptance scratch directory. Both authenticated Tetherplane `filesystem.read` and `process.run` could access it under the current engineering principal. The canary file was deleted.
3. A direct pipe launch probe using Node.js and `--remote-debugging-pipe` on Windows Edge exited before a CDP handshake. **A private Windows pipe is not yet verified**. Do not switch production to an untested pipe implementation.

These are proofs about a disposable test profile and a synthetic file, not about secrets read from a user's existing browser. No passwords, cookies, Amazon accounts, personal profiles, or production identity configuration were accessed or changed.

## Implementation in this draft

- Adds a **new opt-in `tetherd --browser-only` launch flag**. Existing invocations that omit it retain their previous behavior.
- Requires an explicit launch-bound `--principal-profile`; rejects a profile that allows:
  - `process`, `filesystem`, `search`, `batch`, `job`, `desktop`, `audit`, browser upload/download/diagnostics, or any unreviewed capability;
  - unrestricted `--allow` roots or `allowed_directories`;
  - missing device identity or multiple remote device bindings.
- Only an exact, reviewed set of device status and browser capabilities can be accepted; no wildcard expansion.
- Rejects a missing profile or unsafe scope **before** browser service startup; errors are locally classified without printing credentials.
- Uses the existing local `LocalPolicyBroker` for actual tool denials, rather than an AI prompt or a new bypass.
- Tests include rejection before startup; forged caller identity; denial of process/filesystem/search/batch/job/desktop/audit; allowed device status; and browser unavailable without disconnecting local core.

## Security claims explicitly NOT made

**This is not a sandbox.** A process running with the same Windows account outside Tetherplane's capabilities may still read the browser profile or connect to the raw CDP port. Browser-only principal enforcement protects against the *MCP capability composition* bypass, not malware, other local processes, or default browser sessions.

The `--browser-only` flag alone **does not authorize use of a persistent signed-in profile**. The existing extension-free lab candidate remains limited to an empty, temporary Chromium profile and loopback test origin. The fail-closed browser request proxy does not prove WebRTC, worker, popup, non-HTTP or OS-wide egress isolation.

## Release gate

1. CI Rust format, Clippy, unit and native launcher tests pass on Linux and Windows; a passing compile is not physical-device acceptance.
2. Browser-only principal is paired with independently reviewed **non-TCP CDP transport** or OS isolation. A debug endpoint accessible to other local processes is a blocker for a credentialed profile.
3. Human-owned, time-limited site/account/action grants are locally issued and revocable, with network, frame, worker, popup, process and filesystem denial tested.
4. Clean install and authenticated connection, real authorized browser automation, denied unauthorized action, recovery/rollback and observable device status across Leno, Surface, VAULTER, RTX (RTX only under explicit owner authorization).
5. Only after the above: user logs in **locally** to a dedicated profile and records the browser-first launch video with masked credentials, consent and denial evidence.

No merge, release, OAuth/DCR changes, scheduled-task edits, signing/Windows-security bypass, re-pairing or production device changes are authorized by this draft.

Stacked on draft #79; trace all security/acceptance work in issue #75.
