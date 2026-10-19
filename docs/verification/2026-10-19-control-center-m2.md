# Control Center Milestone 2 verification

## Scope and provenance

Base: `3fde005fac9ce3048da177faaa168589c016709f`, independently checked against
the remote feature branch and successful four-job CI run
[39244054158](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39244054158).
Dedicated branch: `feature/control-center-m2-20261019`; dedicated canonical-repo
worktree: `.worktrees/control-center-m2-20261019`. The dirty main checkout and
other worktrees were preserved. The project mirror's `sources/` was not edited.

The increment approves device-generated codes through existing authenticated
`POST /pair/approve`. It lists real account-bound registry records, retains
confirmed revocation, and documents transport retry versus fresh re-pairing.
It never generates device secrets, starts installed agents, changes their local
policy, or infers online state or agent versions from pairing.

## Commits

- `47bac46`: consume competing pending codes and prevent active-binding replacement.
- `ce58afa`: protected local approval, browser flow, reconnect guidance and lifecycle test.

## RED/GREEN evidence

- Registry regression: a second pending code returned HTTP 200 instead of 400 and
  could overwrite ownership. After the guard, competing codes fail and sibling
  codes cannot revive an old credential after revocation; fresh pairing succeeds.
- Portal tests: `/api/pair/approve` returned 404 before implementation, then
  authenticated approval/revocation/re-pair and denial tests passed.
- Logout race: initial implementation returned 200 instead of 401 after logout
  during directory authorization. Rechecking local authority immediately before
  forwarding the mutation made the race and expiry cases pass.
- Browser RED: real headless browser could not find the absent pairing-code
  field. After the form/flow was implemented, the full ten-test browser suite passed.

## Local verification

- Portal HTTP/CLI/security: 19/19 passed.
- Portal isolated headless browser: 10/10 passed.
- Relay suite before the additional lifecycle test: 73/73 passed.
- Focused HTTP/WebSocket/routing/lifecycle group including the new test: 11/11 passed.
- All recursive workspace TypeScript typechecks and builds passed.
- Original logo and all four ASCII frame SHA-256 hashes matched `PROVENANCE.md`.
- `git diff --check` and committed whitespace checks passed.
- Rust formatting and authored unsafe scan passed (`UNSAFE_SCAN_OK`).

The lifecycle test uses real loopback HTTP and WebSocket sockets with synthetic
credentials. It pairs through the portal, authenticates a device socket,
disconnects/reconnects using the same valid credential, revokes through the portal,
observes socket closure and HTTP 401 on reconnect, then approves a fresh credential
and proves only it authenticates. It does not execute an installed device agent.

Native desktop fixture suites are reserved for hosted CI because they may open
test windows. Portal browser tests create isolated headless contexts only.

## Independent review and hosted gates

Fresh-context, read-only independent review of base through `ce58afa` found no
new blocking security/correctness regression. Independently rerun: portal
HTTP/CLI/security 19/19, isolated browser 10/10, HTTP control plus WebSocket
lifecycle 5/5, portal build and portal/relay typechecks passed.

The reviewer independently confirmed expired pairing codes are rejected and
identified an inherited contract limitation: the relay does not retain retired
credential-hash history. Explicitly approving a newly requested code with a reused
hash can authorize that credential again. Documentation now qualifies recovery
claims to the required fresh-secret workflow. Credential-history storage and
backend contract expansion were deliberately left outside this increment.

All four existing Windows/Ubuntu hosted jobs must pass at the final branch head.
The final task response records the observed exact-head run and conclusion;
local/independent tests alone do not satisfy that hosted gate.

## Authorized non-disruptive device observations

On 2026-10-19, the existing Tetherplane Native Web Test connector returned:

- `device` without an ID: `invalid_arguments`, explicit device ID required when
  multiple devices are online. This reveals no device identities or versions.
- `device=Surface`, `op=info`: `disconnected`, requested device offline.
- `device=Vaulter`, `op=info`: `capability_unavailable`, requested device unknown.

These are exact connector routing outcomes for those names, not a census of the
physical machines. No provider operation or version/policy state was established.
No real device was paired, revoked, restarted or reconfigured; no human-owned
browser/desktop interaction occurred. Leno production runtime was untouched.

Ordinary Codex usage was allowed at preflight (29% five-hour, 41% weekly remaining).
A separate Work quota was not exposed by the available quota tool. No quota block
was observed during this local implementation.

## Remaining acceptance and release gates

- Authorized, independently witnessed portal use with actual Leno/Surface/Vaulter
  devices and existing account-bound credentials; correct denial and local policy.
- Clean Windows/Ubuntu install, persistence, onboarding, uninstall and rollback.
- Existing relay upgrade acceptance for the competing-code guard; no deployment
  was performed by this task. Portal operation alone does not upgrade a relay.
- Approved interactive OAuth login/refresh contract; no OAuth clients were added.
- Microsoft Store/distribution, signing and applicable organization-access gates.
- Four-device connectivity/recovery and human-active coexistence acceptance.

No merge, production deployment, release, money, external communication, OAuth
client registration or production auth/scope change was performed.
