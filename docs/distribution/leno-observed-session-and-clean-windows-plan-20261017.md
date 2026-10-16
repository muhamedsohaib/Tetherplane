# Leno operator session and clean Windows test plan — October 17, 2026

## Scope and current state
Planning and read-only feasibility assessment only. No VM provisioning, feature enablement, restart, spending, foreground automation or unattended coexistence test is authorized by this document.

Execution computer: **Leno only**. Surface, Vaulter, RTX and other computers are excluded. Existing pairing, remote connections, scheduled tasks and human applications remain unchanged.

The existing Native Web Test connection returned authenticated Leno device status: Windows x86_64, agent 0.1.0, background_only. Its capability inventory reports browser unavailable. File/process access works. This is authenticated device evidence, not a browser/desktop coexistence pass.

## Operator-observed session
- Operator confirmed availability on Saturday October 17, 2026 from **00:05 Asia/Dubai (UTC+4)**.
- Planned 30-minute window: **00:20–00:50 Asia/Dubai**. Confirm the operator is physically at Leno immediately before execution; if preparation is incomplete, agree a new explicit time.
- Primary calendar showed no recorded busy windows for October 17–20 when checked. This does not prove human presence.
- No calendar event, invitation, reminder, automation or unattended runner was created.

| Minutes | Activity and required evidence |
| --- | --- |
| 0–5 | Confirm physical presence, Leno identity, stop signal, exact candidate, background_only and owned resources. Observe baseline indicators without recording clipboard contents or secrets. |
| 5–15 | Operator continues ordinary human work. Exercise only an authorized owned fixture; compare active window/tab, cursor, clipboard-change indicator, human tab URL/window geometry and process ownership. |
| 15–22 | Dedicated fixture: conflicting human activity suspends foreground work; concurrent modification returns resource_conflict and preserves the competing change. |
| 22–25 | Review policy outcomes, case results and any unavailable capability. Physical fallback requires separate explicit permission plus a scoped expiring ForegroundLease. |
| 25–30 | Evidence review and buffer. Disposition of verified automation-owned resources only; no human-process cleanup. |

Stop on target mismatch, uncertain ownership, denial, unexpected approval, unexplained foreground/clipboard/cursor change, expired lease, human conflict or silent overwrite. Report each case passed/failed/denied/untested and preserve evidence; never infer a pass from a launched process.

### Execution prerequisites and blockers
The existing docs/live-acceptance.md runner requires clean local main exactly equal to origin/main. The canonical checkout is dirty on another branch, and the Agensi feature worktree is not main. Do not checkout, reset, stash, merge or change that requirement to force a run. Prepare an approved exact candidate through the existing release process before the observed gate.

Browser capability is currently unavailable through Native Web Test. Diagnose separately using non-disruptive read-only evidence; do not restart/reconfigure the production agent or switch browser modes during package completion.

The separate remote proof requires authenticated status and a harmless owned process while the operator observes no disruption. Today's authenticated status alone does not satisfy that full proof. No v0.1.0 tag is authorized.

## Clean Windows x64 environment
**Preferred design:** persistent Windows 11 x64 Generation 2 Hyper-V VM on Leno, restored to a clean checkpoint before each scenario. This is a conditional design, not a provisioned or ready environment.

Read-only Leno inventory at 2026-10-16T20:08:18Z:
- Windows 11 Pro Education x64, build 26300; Intel Core i5-1135G7, 4 cores/8 logical processors.
- 7.79 GiB usable RAM; **1.29 GiB free at observation**.
- NVMe C: 118.90 GiB free of 236.52 GiB.
- Hyper-V and Windows Sandbox optional features Disabled. Get-VM and Get-VMSwitch unavailable; existing VM/switch counts unknown.
- Hypervisor present; DEP available. WMI SLAT/firmware/VM-monitor flags false are unresolved while a hypervisor is detected, not proof of absent CPU support.
- CBS and Windows Update reboot markers absent; PendingFileRenameOperations property present. This does not identify a specific pending update.

**Capacity decision:** do not provision under current memory headroom. A Windows 11 guest requires at least 4 GB RAM, two virtual processors, 64 GB storage, Secure Boot and virtual TPM. A practical lab estimate is 8 GB guest RAM and 128 GB expandable disk plus checkpoint/update/log space; Leno currently lacks spare RAM for that allocation. Do not terminate human applications to make room.

Windows Sandbox is supplemental: it provides a fresh image per launch; internal restart retains state on Windows 11 22H2+, but closing discards the session. It does not replace a persistent upgrade/reboot baseline and is also disabled on Leno.

### Requirements before any provisioning
1. Confirm supported Windows guest release/edition and explain host build 26300/virtualization reporting.
2. Resolve safe spare RAM and storage/checkpoint budget without disrupting Leno.
3. Confirm administrator availability and separately approved feature-enable/host-restart window.
4. Confirm guest licensing or accepted time-limited evaluation rights; do not assume the host OEM entitlement covers a second instance.
5. Approve ISO source/hash, networking, checkpoint location and evidence export. No downloads or purchases during this assessment.
6. Disable unnecessary clipboard, drive, printer, microphone and enhanced-session sharing; stage inputs read-only. Permit only test-required network destinations; no production credentials/pairing.
7. Baseline has no existing Tetherplane runtime/config/tasks/developer checkout. Test install → first read-only MCP → restart/startup → approved upgrade → ordinary uninstall (state retained) → separately scoped state purge. Record package/hash/OS/build/results; restore baseline between cases.
8. VM evidence does not certify physical-host focus/cursor/coexistence, GPU or hardware behavior; retain the operator-observed Leno gate.

## Official references
- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/host-hardware-requirements
- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v
- https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements#virtual-machine-support
- https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/
- https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/checkpoints
- https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise
