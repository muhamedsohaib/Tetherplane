# VAULTER device-assisted sign-in recovery (isolated, unshipped)

## Purpose and boundaries

The existing TetherAuth login interaction emits a short, expiring code. Its browser **Continue after approving** button only consumes an approval already issued by a paired device. The existing relay endpoint `POST /auth/device-login/approve` accepts a Device-authenticated VAULTER identity and the exact `interactionUid` + `userCode`. It does not create a new client, replace credentials or change the OAuth issuer.

This proposal adds `scripts/approve-vaulter-signin.mjs`, a one-shot interactive local operator utility. It is not an unattended agent, a browser authentication shortcut, or an OAuth setting change. Approval grants a browser session for the existing account and must be treated as consequential.

## Prerequisites (read-only)

- On VAULTER itself: existing paired VAULTER `tetherd` and credential file must be intact and readable by the current authorized user. Never paste the credential's contents anywhere.
- Local relay `http://127.0.0.1:8788` must be the existing process owned by Tetherplane; its `/healthz` and `/readyz` must respond. Do not launch a replacement process or stop the current relay.
- Node.js 22+ locally; no new npm packages or elevated token access are necessary.
- User must initiate exactly **one** fresh connector sign-in and visually verify the Vaulter browser code and challenge URL. Codes usually expire after five minutes.

## Operator procedure (requires physical consent)

1. Start a fresh ChatGPT Tetherplane connector sign-in **once**, retaining the original browser challenge tab. Do not create multiple simultaneous codes.
2. In an interactive PowerShell terminal **on VAULTER**, from a local checkout of the reviewed branch or after independently verifying the downloaded artifact and SHA, execute:

   ```powershell
   node .\scripts\approve-vaulter-signin.mjs
   ```

3. At the prompts, paste the **exact** `https://vaulter.tailf65eba.ts.net/interaction/...` challenge URL and that same challenge's `XXXX-XXXX` code. Do not enter real access tokens or device credential values.
4. The utility tries to identify the **path only** to the VAULTER credential file from the existing `tetherd.exe` process flags. If unavailable, enter the pre-existing credential **file path** (not its contents). Missing permission is a stop condition.
5. Confirm you initiated this login and are on the expected authenticated-client screen. Type `APPROVE` to approve exactly once. Otherwise, cancel.
6. Only when the relay confirms `{"status":"approved"}`, return to the **same** original browser tab and choose **Continue after approving**. If consent is requested separately, inspect it before proceeding.
7. Recheck ChatGPT connector status and query one device with read-only `device(status)`; only then can other device sessions be assessed. This utility does **not** connect offline agents or resolve an unrelated relay outage.

## Safety properties and failure handling

- Challenge URL is pinned to the exact Vaulter HTTPS origin and interaction route; arbitrary URLs, query strings, redirects, malformed/expired codes and missing confirmation fail closed.
- Approval request target is hard-coded to **127.0.0.1:8788**, using the existing paired VAULTER device identity; no credential is sent to a public web origin, clipboard, terminal argument or log.
- No remote host, OAuth client registration, scope modification, re-pairing, service restart, credential reset or automatic retry.
- HTTP 401: stop; the relay does not accept this VAULTER identity. Preserve it for diagnosis.
- HTTP 400/404: the challenge is invalid, expired or already consumed. Verify the code and start one new challenge only after the cause is known.
- HTTP redirect, 5xx, network error, malformed or non-approved JSON: do not claim approval; stop and investigate.
- The registered device account must be the intended account. The browser must still finish its own interaction flow.

## Verification and remaining gates

RED: Nine focused tests failed against the unimplemented interface.
GREEN: Nine focused tests passed on Node 22 locally; one test executes a real HTTP exchange with a loopback test server while preventing any production request. Full Windows/Ubuntu CI, independent security review, and an authorized one-time VAULTER execution are still required before claiming operational recovery.

**Release policy:** This branch remains Draft. Do not merge, deploy, change identity settings, or make the utility unattended without explicit approval. Preserve all four Tetherplane device identities and existing worktrees.
