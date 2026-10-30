# Microsoft Store privacy / personal-data source audit — 30 October 2026

**Status:** Review-only. Exact source under review: `417395769cd68ba6329bdf2f1ff11368486735fd` (draft PR #110). The absence of a published privacy policy is a Store-certification blocker independently of publisher-identity case `2610290010001747`.

## Evidence-backed data flows

| Data category | Observed code / document | Execution or persistence | Safe claim | Remaining check |
|---|---|---|---|---|
| Setup identifiers and paths | `packaging/msix-store-runtime/app/runtime-app.mjs` `createWizard`, `persistApprovedConfig` | Relay URL, device ID, chosen allowed root, device secret in local protected state after authenticated approval | The setup stores device identity/configuration locally | Verify deployed Windows ACL and uninstall/state behavior |
| File/process/browser/desktop payloads | `README.md`; `agent/tetherd/src/main.rs`; provider implementations | User-authorized operations can read/act on data | App **can** access personal information | Confirm exact final Store capability/UI claims |
| Hosted relay visibility | `docs/security/remote-plane.md` lines under “Hosted relay visibility”; `docs/security/threat-model.md` | Relay terminates MCP HTTP and sees requests/results in transit | **No generic client-to-device E2E secrecy** through the hosted relay | Identify operator, network path, TLS termination and proxy log policy |
| Durable relay device registry | `relay/src/devices/registry.ts` (`#persist`) | Device ID, account ID, credential hash, paired/revoked timestamps | Normal registry does not contain raw device secret | Confirm storage access, retention, backups and deletion procedure |
| Transient pair / routing state | `relay/src/auth/login-proof-registry.ts`, `relay/src/routing/device-router.ts` | Short-lived pairing/login proof and in-memory in-flight routes | Core router does not implement durable MCP payload persistence | Confirm every deployment’s reverse proxy & instrumentation |
| Local audit records | `agent/tetherd/src/audit.rs` | `audit/events.jsonl`, per-execution metadata/status; audit read interface | Audit history persists locally; intended to omit raw invocation arguments | Confirm identifiers cannot indirectly disclose sensitive facts; set retention policy |
| Local idempotency records | `agent/tetherd/src/idempotency.rs` | Completed `ResultEnvelope` persisted; may include sensitive outputs | **Some operation results persist on the local device** | Review redaction/encryption, rotation, deletion and replay lifetime |
| Browser diagnostics | `docs/security/threat-model.md`, browser bridge redaction tests | Sensitive diagnostic values intended to be redacted | Code has credential-shaped redaction tests | Verify installed browser extension, failure logging, external browser environment |
| External OAuth/MCP services | `docs/security/remote-plane.md`, `auth/` | May process auth identifiers, claims and authorized tool responses | External provider-specific privacy policies may apply | Confirm production identity provider and MCP client policies |
| Support/crash/network logs | Final deployed infrastructure / support process **not yet audited** | Unknown | **Do not** claim “no logs,” “no telemetry,” or fixed retention | Inventory logs, proxy, backups, monitoring, recipients |

## Store submission answer and minimum policy

Microsoft's MSIX support-info page states: if the app accesses, collects or transmits personal information, choose **Yes** and provide a privacy policy; capable packages may trigger this even if marked No. This app has six device/tool families with the ability to process personal information, so a truthful review candidate answers **Yes** rather than “none”.

Official references:
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/support-info
- https://learn.microsoft.com/en-us/windows/apps/publish/store-policies

**The policy text in `MSIX_STORE_PRIVACY_NOTICE_DRAFT_20261030.md` is NOT publication-ready.** It contains required verification placeholders. Microsoft allows the policy text directly in Partner Center or a valid hosted policy URL; a guessed or unverified URL is unnecessary and must not be entered.

## Independently unresolved

1. Current publisher legal display name and privacy-request contact, pending support case.
2. Actual deployed relay/proxy/third-party provider processing, opt-in logs, data backup/rotation and retention.
3. On-device audit/idempotency retention/redaction and safe deletion, especially for sensitive result payloads.
4. Operator review of privacy controls and jurisdiction-specific requirements.
5. Actual genuine unpaired Windows screenshot and selected-logo PNG owner hash approval.
6. Store-signed physical Smart App Control acceptance and four-device authorized verification.

**Decision:** `NO_GO` for policy publication and Store submission. This audit introduces no network calls, changes to OAuth, installed devices, telemetry, logging, user data or public privacy notices.
