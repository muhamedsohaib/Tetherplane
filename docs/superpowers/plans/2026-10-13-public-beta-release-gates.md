# Tetherplane public-beta release gate: evidence and execution order

**Audit date:** 2026-10-13 (Asia/Dubai)  
**Status:** SOURCE/CI GATES VERIFIED; LIVE RELEASE GATES NOT VERIFIED  
**Scope:** Release-readiness evidence and an execution checklist. No live-device changes, relay cutover, branch integration, code-signing request, or public tag are authorized by this document.

## Source of truth

Read before making implementation or release decisions:

1. [Canonical design](../specs/2026-09-17-tetherplane-design.md) (resolve via `docs/superpowers/specs/`).
2. [Implementation roadmap](./2026-09-17-tetherplane-implementation-roadmap.md).
3. [Local core plan](./2026-09-17-tetherplane-local-core-plan.md).
4. [Four-device mesh rollout](./2026-10-11-four-device-mesh-rollout.md).
5. `docs/live-acceptance.md`, `docs/security/threat-model.md`, and `docs/security/windows-smart-app-control.md`.

These paths are canonical repository files. GitHub and `C:\Users\Sohaib\source\Tetherplane` on **Leno** are the persistent project sources; temporary sandbox state is not a substitute.

## Pinned source/CI evidence

| Item | Evidence as checked 2026-10-13 | Interpretation |
| --- | --- | --- |
| `main` | `5feee084eb24bfd4831ab42840bb5f10dafc8113` | Public default branch, not the four-device rollout. |
| Mesh feature head | `d0778b7d09de744de863ca61a43f6ddacdc39a69` | Pin this exact source when interpreting the checks below. |
| Git comparison | mesh feature 386 commits ahead of `main`, zero behind | Integration/review gate is still separate from tests. |
| Cross-platform CI | [workflow 38150227249](https://github.com/muhamedsohaib/Tetherplane/actions/runs/38150227249): Ubuntu and Windows quality jobs **success** | Source/test gate green on pinned mesh SHA. |
| Four-device mesh bootstrap | [workflow 38150227300](https://github.com/muhamedsohaib/Tetherplane/actions/runs/38150227300): bootstrap and bundle jobs **success** | Synthetic Windows installation/package contract green. |
| Vaulter supervisor contract | [workflow 38150227305](https://github.com/muhamedsohaib/Tetherplane/actions/runs/38150227305): Windows contract **success** | Synthetic supervisor policy/ownership test green; NOT live Vaulter ancestry proof. |
| Mesh package | Actions artifact `Tetherplane-FourDevice-Mesh-Windows-x64`, ID `11706558542`, 12,302,177 bytes, expires 2026-11-10 | Private pilot artifact, **unsigned**; not a trusted public Windows distribution. |

Historical failures on earlier SHAs included an overbroad check that rejected the literal legacy task argument `-ExecutionPolicy Bypass` even when used only as comparison data, a signing-provenance contract, and Windows browser integration timeouts. These do **not** override the green results for pinned feature HEAD. Root cause reports must always name their SHA and run ID.

## Stop conditions and machine boundaries

- Do not force-push `main`, create `v0.1.0`, publish a release, or infer live acceptance from a green CI badge.
- Leno is the only authorized execution target for remote desktop work; never fall back to Vaulter, Surface, or RTX without an explicit target change.
- On this audit, the Remote Desktop Commander record for Leno was **offline**, and the selected Tetherplane tool's attempted read-only invocation was blocked. This does not establish Tetherplane's own Leno availability.
- The October 11 rollout plan explicitly records Vaulter's original relay supervisor as **unverified**, with prior bridge handover rollback unverified. Until a fresh, authorized read-only ownership inventory proves the supervisor/process ancestry, do not stop or restart the relay, perform an `-Apply` or arbitrary `-Rollback`, terminate processes, replace the protected stage, or re-pair Vaulter.
- Keep `background_only`, human-owned resources, local policy denial, credential secrecy, and real device identity as hard safety invariants.
- No user-facing claim of always-on service based only on an `AtLogOn` scheduled task; cold-boot/pre-login and sign-out resilience require separate real-device proof.

## Execution gates (in order)

### Gate 0 — Resolve source lineage before candidate preparation

- [ ] On **Leno only**, run read-only `git status --short`, `git branch --show-current`, `git log --oneline --decorate -5`, and `git remote -v` in the canonical working copy.
- [ ] Preserve uncommitted human work. Record remote/local SHAs and confirm which candidate version is under test. Do not discard or overwrite a human change.
- [ ] Review the full 386-commit rollout delta in manageable subsystems (relay/auth, Windows bootstrap/signing, browser/desktop, policy/tests); identify accepted and deferred changes.
- [ ] Choose and review a normal integration path to `main`. The existing `scripts/live-acceptance.mjs --prepare` requires a clean `main` exactly equal to `origin/main`. Do not weaken this guard to test a moving feature branch.
- [ ] Freeze the candidate SHA and rerun all relevant Rust, TypeScript, Windows packaging and supervisor tests on that exact SHA.

**Exit:** one reviewed candidate commit and a clean, traceable integration state with no unresolved critical tests.

### Gate 1 — Prove Vaulter relay ownership without interruption

- [ ] Use only an explicitly authorized Vaulter inspection session, not this release audit or a different machine's access, to read the existing `scripts/vaulter-relay-supervision-preflight.ps1` output.
- [ ] Verify protected stage ACL/digests, scheduled-task action, exact listener PID/ancestry, original supervisor lifetime, auth process/issuer, local/public readiness and client continuity.
- [ ] Treat healthy `/healthz` alone as insufficient. Require `SUPERVISED_AUTH0_VERIFIED` and no ownership ambiguity.
- [ ] If not verified, stop before live cutover. Root-cause/recovery requires a separate, reviewed operator plan and approval for any service interruption.

**Exit:** fresh non-secret evidence of supervised relay ownership and stable Auth0 routing, or a documented no-go.

### Gate 2 — Operator-observed Leno live acceptance

- [ ] With Leno reachable and an operator present, begin with `node scripts/live-acceptance.mjs --describe`. Confirm the candidate is on clean, synchronized `main` before invoking `--prepare`.
- [ ] Run `node scripts/live-acceptance.mjs --prepare`; require `LIVE_ACCEPTANCE_PREPARED=True`.
- [ ] Run the observed `--live --user-present` phase only while the operator is physically at Leno. Require `LOCAL_LIVE_ACCEPTANCE=PASS`, unchanged cursor/clipboard/focus/human tabs/windows, and real owned filesystem/process/browser/desktop/batch operations.
- [ ] Separately verify authenticated remote MCP routing to Leno (`device.status` plus an owned-process no-op) using already approved authentication. Do not export or print credentials.
- [ ] Perform scoped cleanup only after evidence has been recorded; preserve production state.

**Exit:** observed local and separately authenticated remote acceptance evidence at the SAME candidate source identity.

### Gate 3 — Four-device mesh and resilience

- [ ] Pair Leno, Vaulter, RTX and Surface individually through authorized local enrollment, without copying raw secrets between machines. Validate logical identity on each device.
- [ ] For each device, verify exact six-tool discovery, stable `device.status`, a permitted file read/owned-process no-op, an outside-root denial, and local policy authority.
- [ ] Prove reconnect, relay loss, revocation, retry idempotency, agent restart, sign-out and reboot behavior; record unsupported cases explicitly. Keep human desktop ownership protected.
- [ ] Avoid touching existing GPU jobs, human windows or production relay processes during acceptance.

**Exit:** four independently authenticated identities and policy-preserving, observed resilience evidence. Do not call this gate passed based on synthetic mesh CI.

### Gate 4 — Windows publisher trust and public distribution

- [ ] Keep current CI artifact labelled `unsigned_pilot_artifact`.
- [ ] Independently secure an approved trusted publisher/signing provider and reviewed provenance before claiming signed installation support. Any paid service, enrollment or legal/compliance step requires explicit authorization.
- [ ] Verify trusted Authenticode signatures, source manifest pins, hashes and actual Windows Smart App Control behavior without disabling or bypassing security controls.
- [ ] Complete clean-machine install/upgrade/uninstall UX and developer onboarding checks; publish accurate supported-platform and privacy limitations.

**Exit:** a verified and accurately described public installation path, with signed-publisher claims only if the external signing and OS acceptance proofs exist.

## Release decision

Do not publish `v0.1.0` solely on the source CI results. Final **GO** requires Gates 0–2 and all security-critical portions of Gates 3–4 relevant to the advertised release scope; otherwise issue a **NO-GO** with exact evidence, remaining risks and a bounded next action. A narrowed private pilot may be considered separately; it must not be advertised as a full, signed, four-device public release.

## Opportunity / distribution follow-up

The Agensi inquiry is a separate distribution opportunity, not a release gate. After independent installation and user workflow validation, package a small official free Tetherplane skill that guides agents to the six operations and honors local policy. Do not initiate external outreach, paid marketplace arrangements, or claims about download volumes without separate approval and evidence.
