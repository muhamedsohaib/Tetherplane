# RTX — authenticated Tetherplane real-device acceptance probe

Date: 2026-10-25 (Asia/Dubai)
Environment: authorized existing RTX Windows workstation, **read-only and harmless-output probes only**
Disposition: **CORE CONNECTIVITY PASS; FULL RTX WORKFLOW ACCEPTANCE PARTIAL**.

## Runtime observed directly through Tetherplane

| Item | Verified observation |
| --- | --- |
| Device | RTX |
| OS/architecture | Windows 11 Pro / x86_64 |
| Agent | `tetherd.exe` 0.1.0; `background_only` |
| Live agent process | Exactly one at inspection, PID 20972; UTC start `2026-10-25T01:05:12.5271019Z` |
| Agent binary SHA-256 | `f412926e5205ad7be98cb62f16158ca7435017c99b1c66cfcf054a4dc5607b91` |
| Authenticode | `NotSigned` (not itself evidence of an operational failure) |
| Working set | 16.1 MiB at one sample |
| TCP | One established socket owned by agent PID at inspection |
| Task | `Tetherplane RTX Agent`; Running; `MultipleInstances=IgnoreNew`, `RestartCount=3` |
| Task action / ownership | **POWERSHELL** task action; `powershell.exe` parent PID 8964 of `tetherd.exe` PID 20972 |
| Task last result | 267009 / 0x41301 (running); does not prove recovery |
| Version provenance | Runtime version and binary fingerprint obtained. Matching exact source commit/build attestation **not** independently established. |

## Authenticated functional tests

| Capability | Test | Observation |
| --- | --- | --- |
| `device.status` | Direct call, repeated four times | PASS. Four consecutive calls took 4,674, 4,098, 4,709 and 4,139 ms at the client connector, version 0.1.0, monotonic agent uptime, no failures. These are end-to-end tool latencies, NOT intrinsic agent processing times. |
| `device.capabilities` | Direct call | PASS. Nine provider namespaces enumerated. Advertised capabilities do not imply authorization of every operation. |
| `process.run` | Harmless `cmd.exe` echo | PASS, exit code 0 and expected token returned through Tetherplane. |
| `process.run` | Sanitized read-only agent/service inspection | PASS. Singleton agent, task parentage and TCP connection observed; no command lines, bearer secrets or agent credentials printed. |
| `batch.execute` | Two parallel read-only agent/device calls | PASS, 2/2 results successful. |
| `batch.execute` | Mixed parallel batch: two allowed device queries + one denied filesystem query | PASS. Two requests succeeded; one `permission_denied` stayed isolated as a per-item error; no unexpected early cancellation. |
| Filesystem policy | Read-only file metadata on standard Windows system file | Correct `permission_denied` for path outside allowed roots. |
| Filesystem policy | Read-only metadata of owner's previously documented private RTX workload report and parent directory | `permission_denied`. **No positive `filesystem.read` within an approved directory is evidenced**. Exact proprietary workspace path intentionally excluded from this source-controlled report. |
| Filesystem policy | `filesystem.list` on relative `.` | `permission_denied`; no directory traversal or bypass attempted. |
| Browser | `browser.status` | `permission_denied` for current `operator:sohaib` principal. Provider advertises `available=false` and no operations. |
| Desktop | `desktop.snapshot` | `permission_denied` for current `operator:sohaib` principal. Provider reports `available=true` but **zero authorized operations**. No screenshot captured and no human window disturbed. |
| GPU | Remote `nvidia-smi` query through authorized `process.run` | PASS. NVIDIA GeForce RTX 3080; 10,240 MiB total, 9,455 MiB free, 0% busy, 37 C at inspection. **Driver query only**; CUDA compute/inference not exercised. |
| Search/job/audit mutating workflow | Not run | NOT VERIFIED; this was a non-disruptive acceptance. |

An initial set of three concurrent requests completed after ~22 s at the connector boundary. Subsequent batches returned in ~4.8–5.4 s and repeated direct device-status checks in ~4.1–4.7 s. With no correlated relay timings, the initial delay cannot be attributed to RTX itself.

## Boundary classification and release significance

1. **CORE CONNECTIVITY PASS:** Authenticated route, actual command execution, batch fan-out, correct denial, stable short-term status and GPU driver visibility. The RTX is **not offline** and should not be called completely nonfunctional.
2. **POLICY/LIMITATION:** Under the current principal, browser and desktop access are denied and the known private RTX workload directory is outside filesystem allowlist. This prevents a claim of full files/desktop/browser workflow acceptance. Do not infer a broken local provider or auto-expand scopes. Tetherplane Control Center's five restriction toggles are deny-only and cannot grant missing device-local capabilities.
3. **LIFECYCLE GAP:** RTX runs a PowerShell-owned agent child. This differs from the reviewed PR #44/#46 direct native task design that avoids orphaned agent processes on task stop. Although exactly one PID is currently alive, stopping/restarting, dead-process recovery and rollback were not tested. Do **not** change the production task in response to this diagnostic.
4. **CUDA COMPUTE GAP:** The NVIDIA driver reports healthy/idle but an actual GPU kernel/model inference through an authorized reproducible task has not been independently executed.
5. **SHORT-SAMPLE ONLY:** Four consecutive status successes are not a sustained soak, Wi-Fi loss test, task restart or installation validation. No user-facing browser session or Control Center policy mutation was attempted here.

## Smallest safe next acceptance

- Confirm the **intended RTX workload** (remote compute only versus filesystem or interactive UI). If private workload files must be available to the AI principal, authorize an exact **least-privilege allowed-root** change through existing device-local policy (not the Control Center deny-only overlay), preferably an isolated named project/test directory rather than the whole data drive. Prove allowed read and out-of-root denial as two distinct tests.
- If browser/desktop is explicitly required on RTX, review its separate provider status and principal scope; do not silently grant blanket screen control. This may be unnecessary for an RTX compute workstation.
- Preserve the exact current executable fingerprint, task/export, identity, agent argument references, and state before proposing a controlled native-task migration from the reviewed reliable source. Require signed/source-provenant candidate, rollback, non-orphan stop, authenticated reconnect and independent review. Do not just restart the existing PowerShell task.
- For a GPU-workload acceptance, use a tiny approved synthetic GPU task or an existing owner-approved model harness, record CUDA outcome, latency, GPU memory and no unexpected state change. A successful driver query alone is insufficient.

**No production process was stopped, restarted or killed; no agent or OAuth identity, credential, relay, local policy, desktop state, private data, protected task, user worktree or permission was changed in this test.**
