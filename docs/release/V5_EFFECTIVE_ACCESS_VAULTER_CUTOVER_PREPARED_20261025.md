# V5 Control Center effective-access cutover — production accepted
Date: 2026-10-25 (Asia/Dubai)

## Current disposition
**V5 was promoted and accepted on VAULTER.** See the decisive production acceptance receipt at the end of this record. Source at `09ea09b7ba5bbe66a23851ef6f3248c799050008` on `feature/device-permissions-truth-20261025` was prepared against the previously accepted V4 single-owner editor (`6bad88c`). The V4 status below describes the historical pre-promotion checkpoint, not current production.

## Precise source acceptance
- 62/62 full Control Center Node tests PASS, including simulated OAuth, owner approval, deny/rollback, non-owner denial and session boundaries.
- 60/60 private standalone candidate tests PASS. Exact HTML SHA-256 `4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8` and font SHA-256 `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` PASS.
- Headless Edge in isolated local server PASS, including authenticated mock access-check receipt, read-only local request download, simulated deny/revision rollback, stale-response protection, non-owner denial. **Real device-local policy changes = 0**.
- 6/6 independent Windows PowerShell policy-review tests PASS for script syntax, read-only inspect, expired/rejected requests, existing root boundaries, noninteractive write denial and invalid restore receipt.
- Follow-up server authorization fix: active access probes now require **exactly the previously enrolled portal editor** server-side. Non-editor probe fails without a remote agent call.

## Exact privately staged V5 candidate
- On LEN0 (Leno), local owner-controlled ZIP: `C:\Users\Sohaib\Desktop\Tetherplane-ControlCenter-EffectiveAccess-09ea09b-private.zip`.
- Source SHA: `09ea09b7ba5bbe66a23851ef6f3248c799050008`.
- ZIP bytes: **137620**.
- SHA-256: `d542dd0ed7108389ce77e17f0630c484851fb844beac8dce6bd1a514ae890460`.
- Manifest SHA-256: `387c062577ff4a51d5a22aaba6e0b6038c50b2a9ecde2d07eeb38f51d6cba3aa`.
- 30 manifest-verified files plus manifest. Original private HTML/font remain exact, and private assets are excluded from the Git repository. Do not upload this ZIP to GitHub or a public storage location.

## Protected operator tool
- Generated private operator ZIP: `Tetherplane-VAULTER-EffectiveAccess-Operator-Pack-v5.zip`.
- SHA-256 of pack: `eb99650f332b030d613b7bb59acd3abb86d6b8d6950d5fc30a6951cae14b89fd`.
- Inside: `Inspect-Promote-TetherplaneEffectiveAccess-v5.ps1`.
- SHA-256 of script: `bae49f3a18286270ffb0aabcf230bda2370fe3f537985aaca32bbd8a3466dd80`.
- Read-only `-Mode Inspect` validates exactly one accepted V4 managed task, live source and OAuth, existing single editor, manifest/package and protected empty audit/checkpoint. It refuses existing V5 staging/receipts, unknown task or identity drift.
- `-Mode Promote` is only for operator action **after successful live Inspect**. It stages a new versioned release without changing protected OAuth/authority files, runs packaged tests, saves original task action, switches the existing managed task, checks unauthenticated route denial and requires human OAuth browser acceptance. REJECT or a fault attempts rollback to V4; a failed rollback requires separate protected recovery. The operator pack has **not** run on VAULTER yet and its full task cutover remains an unverified release gate.

## Remaining acceptance before claiming this phase deployed
1. Owner securely transfers the exact private candidate ZIP from Leno Desktop to VAULTER Desktop; extracts the V5 operator ZIP locally; independently checks SHA-256 values.
2. Run only V5 `Inspect` first on elevated local VAULTER and review `V5_EFFECTIVE_ACCESS_INSPECT_READ_ONLY=PASS`.
3. After operator checks pass, the operator may execute `Promote` and independently verify real existing OAuth sign-in, four devices, accurate RTX advertised-vs-authorized status, owner-only probe and review-only local proposal. Do not apply portal restrictions or modify device permissions during cutover.
4. Accept only after browser checks and evidence confirms original trusted files and same OAuth identity/audit. Otherwise reject; verify rollback.

**Separate RTX policy gate:** This UI can observe access and export review requests. It cannot grant agent-local permissions by itself; explicit local approval, protected profile/launcher verification, owned restart, exact path acceptance and rollback are still required. Browser provider may be unavailable. Never bypass connector policy or expand drive roots in response to an access denial.

Do not merge a protected branch, publish a release tag, or alter production identity configuration without a separate explicit authorization.

## Final production acceptance — 2026-10-25

**Status: V5 VAULTER CONTROL CENTER ACCEPTED. This section supersedes only the earlier "staged, not promoted" / V4 production status statements, retained above as historical preparation records.**

Owner-provided VAULTER operator transcript independently reported:
```text
VERIFIED_PRIVATE_V5_PACKAGE=YES
PACKAGE_DIGESTS_VERIFIED=30
ACCEPTED_OWNER_EDITOR_LISTENER_PID=13440
EXISTING_OAUTH_IDENTITY_UNCHANGED=YES
EXISTING_AUDIT_AND_CHECKPOINT=PASS
EXISTING_AUDITED_RESTRICTIONS=0
EXISTING_EDITOR_ALLOWLIST_PRESERVED=1
V5_EFFECTIVE_ACCESS_INSPECT_READ_ONLY=PASS
V5_LIVE_UNAUTHENTICATED_GATES=PASS
V5_LIVE_PID=12516
V5_LIVE_UNAUTHENTICATED_GATES=PASS
V5_EFFECTIVE_ACCESS_CUTOVER_ACCEPTED=YES
```

The promotion revalidated the original 116,329-byte HTML hash `4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8`, private font hash `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e`, and reported **60/60 Node tests passed**, no failures. The new managed listener PID **12516** was reported at the accepted cutover (not guaranteed to remain the current PID indefinitely).

Operator-provided authenticated browser screenshots verified:
- All four named device tabs were present (Leno, RTX, Surface, VAULTER) in the Device Authority UI. This alone does not establish contemporaneous successful status operations on all four via the portal.
- RTX advertised providers were labeled **NOT VERIFIED**, browser **UNAVAILABLE** and desktop **NO OPERATIONS ADVERTISED**, instead of falsely showing blanket permissions.
- The same existing verified OAuth account remained a portal policy editor. Five deny-only restriction checkboxes were displayed; zero additional portal restrictions and empty audit history were observed.
- The **Request Device-local Permission Review** UI rendered and made clear that exporting a proposal does not grant a capability. No production proposal was applied.
- An active `device.status` portal probe against RTX returned **VERIFIED ALLOWED — exact tested operation only**, with a live timestamp; no claim of other capabilities being authorized.
- The operator typed `ACCEPT`; final unauthenticated access gates passed, then the script emitted **`V5_EFFECTIVE_ACCESS_CUTOVER_ACCEPTED=YES`**. This is the decisive protected deployment receipt. No rollback was requested.

Independent post-acceptance Tetherplane connector `device.status` calls returned Windows x86_64 agent `0.1.0` and `background_only` for all four agents. Leno and Surface additionally reported `authenticated` transport and `ready` state; VAULTER and RTX did not expose those detailed liveness fields in the response. These are **agent route checks**, not a direct observation of the protected VAULTER Control Center process or the private portal audit files.

**Phase disposition: V5 production effective-access visibility and review-only request workflow COMPLETE and ACCEPTED.** This is not permission-grant acceptance: no RTX principal, agent launch policy, allowed filesystem directory, browser capability, or protected relay scope was expanded. An exported proposal is not a privileged grant, and executing that proposal requires independent on-device approval and tested rollback. Do not redo this V5 cutover, reset its audit or change the four device identities to solve RTX policy denials.

**Unfinished, separate gate:** RTX local-authorized permission transaction (exact principal policy root, protected ACL, local ownership, restart behavior, operation success, out-of-root denial and receipt-backed rollback), with no blanket permission grant or bypass. Further public signing/clean-install distribution and protected merge/release likewise remain unapproved.
