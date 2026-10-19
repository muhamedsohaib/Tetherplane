# Surface existing-install recovery — live acceptance evidence (2026-10-19)

**Scope:** One operator-authorized *existing* Windows Surface installation and the already-connected Tetherplane MCP principal. This is **not** clean-device onboarding, signed-kit installation, a production relay rollout, or permission to release. The separate [controlled-acceptance gates](CONTROLLED-ACCEPTANCE.md) remain authoritative.

**Evidence provenance:** Windows PowerShell outputs were collected and pasted by the Surface operator in the Tetherplane ChatGPT conversation on 2026-10-19 (UTC+04:00). Authenticated MCP tool results were independently obtained by the assistant via the existing Tetherplane Native Web Test connection in the same conversation. Raw command transcripts are not committed to this public repository. No credentials, token values, machine addresses, full task arguments or identity hashes are included here.

## Initial observation and narrowly scoped intervention

- The operator reported that the existing scheduled task `Tetherplane Surface Agent` was `Ready`, with no running `tetherd.exe` and the prior Windows task result `0x8007042B`. This previous termination cause was **not** established.
- The existing agent executable, PowerShell launcher, locally stored credential and principal profile were present. A distinct `surface-acceptance` test identity was observed and deliberately preserved.
- The operator independently verified the established Tailscale path to the device WebSocket endpoint (TCP connection succeeded). This proves endpoint reachability, not authenticated routing.
- The existing launcher passed a non-executing PowerShell syntax parse (0 errors); it referenced the device ID, credential file, principal profile and relay URL. The agent binary was `NotSigned`. No matching Code Integrity event appeared in the checked start window; this does **not** establish broad code-signing compatibility.
- After the operator verified task owner, single PowerShell action and the expected existing launcher path, they issued a single `Start-ScheduledTask` request for the existing task. The resulting task state was `Running` with one agent process and result `0x00041301` (still running).
- No new installation, re-pairing, task replacement, credential rotation, Windows security policy modification, or change to relay/OAuth configuration was performed.

## Reboot and independent post-reboot acceptance

- The operator restarted Surface normally, signed in, and **did not manually launch the agent** afterward.
- Windows last boot: **2026-10-19 17:06:31 UTC+04:00**. Existing scheduled task last run: **2026-10-19 17:08:08 UTC+04:00**, approximately 97 seconds after boot. The task state was `Running`, with exactly one agent process and a new PID (not retained in this report).
- A fresh authenticated `device(op="status", device="Surface")` call succeeded after reboot: `os=windows`, `arch=x86_64`, `agent_version=0.1.0`, `policy_mode=background_only`. The live response supplied an agent uptime; it did not report a filesystem modification or an expanded principal.
- The post-reboot read-only negative test `files(op="list", device="Surface", args={path:"C:\\Windows\\System32", max_entries:1})` returned `permission_denied`: `path resolves outside configured allowed directories`. No restricted files were accessed or changed.
- Another authenticated `device.status` call during this continuation returned `agent_version=0.1.0`, `policy_mode=background_only`, `uptime_ms=557562`, showing the agent still responded later in the same post-reboot session.

**Observed acceptance:** Existing scheduled-task auto-start following a genuine reboot/sign-in; account-authenticated device status; and tested denial of an outside-root filesystem listing. Device identity was not rotated, and no additional privileges were granted. The live tests do not measure other policy capabilities.

## Not established — do not mark release-ready

| Gate | Result |
| --- | --- |
| Existing Surface startup after human-requested task start | **Observed pass** |
| Existing Surface auto-start after a normal reboot/sign-in | **Observed pass** |
| Authenticated status after reboot | **Observed pass** |
| Denial of one out-of-root filesystem request | **Observed pass** |
| Loss/recovery of an established device WebSocket connection | **Not tested**; no deliberate network disruption was performed |
| Signed clean Windows x64 machine: ZIP provenance, install, pair, approval and finalize | **Not tested** on this machine; existing installation is not a clean candidate |
| Preservation under signed-kit repair and upgrade; rollback and uninstall | **Not tested** |
| Universal Smart App Control/Defender trust of a signed candidate | **Not established**; installed binary was unsigned |
| Production relay upgrade and Control Center authenticated presence display | **Not deployed / not verified** |
| Multi-device acceptance across the required four-device architecture | **Open** |

## Smallest safe follow-up

1. Preserve the working Surface task, credential, original policy and existing relay connection; do not re-pair to manufacture a clean-install result.
2. For a future interrupted-transport acceptance, obtain an operator-approved maintenance window for **Surface only**, record pre-state, induce one bounded device-transport interruption, restore it, then independently confirm `device.status`, reconnect latency and the absence of unintended replay. Stop and restore connectivity if it does not recover promptly.
3. Run the private signed-kit acceptance and rollback sequence on a **separately approved clean Windows test environment**, with pinned commit/provenance and independently checked installation artifacts. Do not overwrite this recovered Surface installation.
4. Only after the applicable technical and physical gates and explicit authorization, consider the separately reviewed relay/presence deployment. Do not conflate CI simulations or this existing-install recovery with distribution readiness.

**Release decision:** **NO-GO unchanged.** This record adds one real-device reboot/reconnect observation to the evidence ledger; it is not approval for merge, publication, signing-service procurement, or production changes.
