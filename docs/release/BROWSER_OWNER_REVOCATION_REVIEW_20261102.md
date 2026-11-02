# Owner-controlled live browser revocation — review evidence

Date: 2026-11-02. Base: PR #126 / `84549e6c0a00bc21db825b358785afe6705ea48d`. **Draft source only. No release or live agent changes.**

## Defect and exact trust boundary

The original browser host read owner-approved RPC and extension pairing tokens into process memory. The windowless Windows launcher checked local enrollment at startup and after a browser-host restart, but a running host could continue to accept operations after a user tried to withdraw enrollment. Deleting token files or stopping only a wizard-owned host was insufficient for separately supervised instances.

## Designed revocation path

1. Owner opens the existing nonce-authenticated local Store wizard, explicitly clicks **Revoke browser access**, confirms a separate dialog, and posts to the same-origin, authenticated `/api/browser/revoke` endpoint. The device identity is not removed.
2. The endpoint creates `browser-enrollment.revoked` **exclusively** within the already owner/SYSTEM-protected state directory. It must pass an independent Windows DACL check. The denial marker is never rolled back on a subsequent cleanup error.
3. The endpoint removes only the three exact existing owner-browser files, after regular-file and private-ACL checks. It never removes the paired device credential or touches arbitrary files, symlinks or foreign paths. If anything is irregular, access remains marked revoked and manual owner recovery is required.
4. A packaged extension host checks for the revocation marker **before opening network listeners**, checks the marker and its originally loaded token files **on every browser RPC handshake and invoke**, and has a 150-ms watcher to stop the pairing broker and extension transport. A cached bearer token cannot authorize a new operation after the durable marker appears. Existing already-issued operations might finish; no automatic replay is added.
5. The Windows browser GUI launcher checks the marker before every child spawn or crash recovery, preventing an independently supervised process from silently resurrecting the browser. The Store logon supervisor validates browser enrollment before passing browser-bridge flags; the authenticated device agent remains online without the optional browser.
6. A previously revoked enrollment cannot silently re-enroll in the wizard. Restoration requires a distinct, future, owner-reviewed recovery path rather than deletion/replacement of the tombstone by an agent.

## Verification (do not exaggerate)

- Real loopback browser RPC tests exercise the *same cached authentication token* before/after a synthetic owner marker and verify new handshake and mutation denial without reaching the backend.
- Windows Store wizard tests exercise wrong-origin and missing-owner-confirmation denial, durable marker, deletion of only browser credentials, unchanged device identity, wizard-owned host stop, core-agent survival/restart with no browser flag, and persistence across wizard restart.
- Existing browser owner enrollment, page privacy, exact-origin and private Chromium tests must continue to pass.
- Rust Windows CI must compile and test the marker guard in `tetherplane-browserw`, and exact-head Windows/Ubuntu CI must pass before review is considered complete.

## Important limitations and remaining gates

- The actual Store-signed MSIX has **not** been installed. No live host/extension has been physically revoked on an installed Windows 11 device.
- A pending browser operation that was already authorized before revocation could complete; a new operation begun after the marker cannot be admitted by the patched host. User-facing language must not imply transaction rollback.
- The GUI launcher and Node host rely on cooperative shutdown. Physical tests must confirm the host processes close, open sessions are terminated promptly and the native supervisor does not respawn.
- Browser recovery and re-enrollment after a deliberate revoke are **not** implemented. No automatic token rotation or regrant is allowed.
- Store publisher eligibility, code-integrity/SAC, no-Tailscale public ingress, authenticated pairing, signed private-audience delivery, rollback and four-device acceptance remain release gates.
- The GitHub OAuth credential cannot modify workflow definitions. This review branch does not change workflow files or release/Store permissions. A normal `tests/release/package.json` workspace test entry now runs all nine owner tests through the existing `pnpm -r test` CI step; exact-head Windows and Ubuntu job results must be checked before declaring it enforced and passing.

**Release disposition: NO-GO. Preserve the existing auth boundaries and all live devices.**

## Local test record — physical Surface, 2026-11-02

- Browser-bridge typecheck: **PASS**.
- Real loopback RPC suite: **6 passed, 0 failed**; cached bearer token denied for both handshake and mutation after revocation.
- Store owner-enrollment suite: **9 passed, 0 failed** on Surface via `pnpm --filter @tetherplane/store-release-checks test` (220 seconds). This includes the final idempotent/no-op refinement, revoked core restart, and safe no-op for never-enrolled devices. GitHub CI runs the same package under the existing `pnpm -r test` command.
- Packaged browser-host esbuild bundle: **PASS**, output 55,599 bytes in an isolated temporary location; Node syntax check passed.
- Windows-native browser supervisor test was added; its Rust compilation/execution remains for Windows CI.
- A separate attempt to rerun the existing Store core suite in this worktree was blocked by the remote tool's safety check and was not circumvented. Prior PR #126 and its baseline CI had passed; that is **not** proof of this new commit.
- Explicit owner revocation is irreversible at the enrollment level until a separately reviewed recovery flow is implemented. Attempting revoke on an unenrolled device is a no-op, not permanent lockout.
