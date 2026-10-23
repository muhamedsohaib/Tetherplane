# Chromium startup investigation — 23 October 2026

**Production NO-GO. Draft PR #53 is an isolated engineering change, not a release or proof that the historical Windows startup failure is cured.**

## Source and preserved boundaries

Canonical repository: `muhamedsohaib/Tetherplane`. Branch: `fix/chromium-startup-evidence-20261023`, stacked on unchanged draft #52 at `e35782baaa7cd0ec12c9e01bae96af2f44c55378`, #50 at `ac074f181a5555f461ad5d0e170b19f92ee5a052`, and #49 at `959ba8220581610fb8f184b8de9ecdf25eaedec3`.

Implementation commits: `894cff7c1f2450bb4289e6e923a2cb4e574eb733` (telemetry and first regressions), `3a78784be22a64ea34c10316d8f8562c912734dd` (deadline abort classification), `bd4184715e974ec47ebbd8a3a6c005377dcebc72` (event cap, non-browser probe avoidance and truthful liveness), and `ecef61ebe62565743749bfb55bd1a192fcfc5041` (busy-file categorization and positive fixture IO budget). The following evidence commit also makes file-classification fixtures end on the observed state instead of imposing a disk-speed assumption. Final exact-head Actions are visible on [draft #53](https://github.com/muhamedsohaib/Tetherplane/pull/53).

Existing checkouts/worktrees and dirty primary entries were preserved. The project mirror's synced `sources/` was not edited. Native worktree creation failed with `Not a git repository` in the mirror, so an ignored linked worktree was created from the canonical repository. No history was rewritten. No protected merge, release/signing, installation, production deployment/configuration change, authentication/credential work, OAuth/DCR registration/scope change, grant change, device identity change or human-session interruption was performed. The six tools, four-device architecture and device-local final authority remain intact.

## Original exact-head comparison

All three runs below report source `e35782baaa7cd0ec12c9e01bae96af2f44c55378`. Their Windows image was `windows-2025-vs2026`, version `20261021.278.1`.

| Run | Observed result |
|---|---|
| [39994004381](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39994004381), push | Windows and Ubuntu PASS; browser 69/69 |
| [39994011081](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39994011081), PR | Windows FAIL, Ubuntu PASS; browser 68 passed/1 failed; B6 launch endpoint timeout, about 12.47s including cleanup |
| [39994011449](https://github.com/muhamedsohaib/Tetherplane/actions/runs/39994011449), focused Windows | Trial 1 FAIL, endpoint timeout about 12.29s including cleanup; trials 2–5 never ran |

Both failures reached `cleanup-complete`. Their selected executable/version, child exit and stderr were **not reported**, because the old launch used `stdio: ignore`. Identical image versions exclude an image-version difference as a sufficient explanation; they do not establish equivalent transient runner conditions. Original failures were not rerun, canceled or overwritten. [Machine-readable comparison](evidence/chromium-startup-20261023/original-exact-head.json).

## Completed engineering

The launcher accepts an opt-in diagnostic callback. It emits fixed labels, numeric version/counters and booleans/nulls for executable family/selection, profile writability, spawn/exit/close, endpoint observations and cleanup. No executable/profile path, endpoint URL, browser command line, raw stderr or exception text is emitted. Unknown observations remain null. Callback exceptions cannot affect launching or cleanup.

Stderr is drained continuously, with only the first 16KiB classified and at most 256 characters retained transiently between chunks. Each endpoint state is emitted once, preventing file-state flapping from flooding logs. Endpoint reads consume at most 1025 bytes, reject oversized/invalid content, use the remaining deadline for abort, and recheck both deadline and failed-child state after IO. Busy-file and permission categories are distinct; unexpected error text is discarded. Windows executable version comes from a bounded 1.5s/1KiB PE metadata helper, not a second Chrome launch; non-browser failure fixtures skip that helper. Version remains null if that probe cannot report it.

Profile creation/write-probe/cleanup errors are sanitized. Allocated CDP wire and known owned browser PID are cleaned after later setup failure. Successful and failed launch cleanup separately report profile removal, launcher liveness and known browser liveness. Error paths destroy the diagnostic pipe even if profile removal fails.

The focused Windows harness measures five **separate** browser/profile/lab sessions, explicitly selects TAP, retains only sanitized JSONL receipts, and fails overall if any trial fails. It continues measurements after a failure; later success cannot erase it. A 65s outer guard terminates only the new disposable test process tree. No broad browser-process enumeration or human process termination is used.

**Unchanged acceptance limits:** B6 endpoint wait 12s; B6 test 30s; download observation 5s. No launch retry, command replay, skipped failure, timeout increase or replacement installation was used. New positive unit fixtures have a 1s IO budget; the missing-endpoint failure regression retains 120ms and the post-read deadline regression retains 40ms. Real file classification is ended by observing the state and terminating its own fixture, rather than treating 120ms disk performance as a product contract. No existing product/B6 limit changed.

## Verification and source artifacts

Thirteen focused startup regressions pass. Failing-first evidence covered missing diagnostics, error/path leakage, signal exit, post-read terminal/deadline races, deadline-abort misclassification, flapping output bounds and safe busy-file categorization. Real disposable Node children verify pipe draining and lifecycle behavior; controlled filesystem faults verify error redaction and races. No fixture credentials are live.

Independent read-only review found three actionable gaps (profile-cleanup redaction, post-read readiness checks, reporter selection); they were fixed, with regression evidence. Independent final verification passed 12 then-current startup tests, bridge typecheck and one real disposable B6: Edge `155.0.4283.62`, endpoint 666ms after spawn, B6 6.17s, process/profile cleanup confirmed. The author committed the same three reviewed working-tree files during that verification; the receipt records both the pre-commit and post-commit heads rather than inventing an unchanged HEAD. [Independent summary](evidence/chromium-startup-20261023/independent/summary.json), [sanitized lifecycle](evidence/chromium-startup-20261023/independent/startup-events.jsonl).

| Hosted source | Focused Windows result | Endpoint after spawn, trials 1–5 |
|---|---|---|
| `894cff7` | [40000482266](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40000482266), 5/5 PASS | 5166, 247, 262, 200, 245ms |
| `3a78784` | [40000841639](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40000841639), 5/5 PASS | 4860, 211, 171, 217, 276ms |
| `bd41847` | [40001611828](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40001611828), 5/5 PASS | 4174, 227, 271, 231, 241ms |

Hosted Node `22.23.4`, Windows x64, image `20261021.278.1`; selected Chrome `156.0.8078.48` when the bounded version probe reported it. Some first probes timed out and remain null. All 15 isolated trials confirmed browser-process termination and profile removal. Some child exit/close events arrived after the cleanup receipt; process liveness is reported separately from event receipt.

PR workflows test synthetic merge commits. For `3a78784`, tested merge `0e87c884dc43ce478799164e898a17908895e821` and source have tree `11f914be66e6a597ef787752d90d9f761efe6769`. For `bd41847`, tested merge `a285e3949e802da1076d271d77feaa749310651c` and source have tree `7c60049dceccef942795bdf5ac3a0c66c9d60dea`. These are source-tree comparisons, not protected merges.

Durable receipts: [3a78784 batch](evidence/chromium-startup-20261023/3a78784/), [bd41847 batch](evidence/chromium-startup-20261023/bd41847/). Uploaded ZIP SHA-256 values were `7e42e09e21f71580c6c3cea65685b704d38e09ef2f4809eb3b12f5e783fd352b` and `3085835cf0220c074baaab74bbafd367fcb02eed4e1e8a15bffef257c9d4c593`; artifact IDs `12522390961` and `12523120164` respectively. Stored JSONL files contain only the sanitized receipt payloads, not raw browser/TAP stderr.

[Full push quality 40000420471](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40000420471) passed on Windows and Ubuntu at `894cff7`. Later exact-head quality runs must be evaluated individually; an older green run is not substituted for them. Workspace TypeScript typecheck/build and the authored unsafe scan passed locally. The final local workspace command reached the native E2E pretest, which remains blocked by unavailable Microsoft `link.exe`; no old binary was substituted. Local package totals and the final candidate Actions results accompany the PR verification receipt.

Local failures remain visible: an intermediate isolated batch was 4/5, with trial 4 exceeding the unchanged 30s test limit during cleanup after reaching readiness; parallel suites also exposed Edge download completion still in-progress at the original 5s limit despite final file existence. Early diagnostic-fixture failures and short unit IO assumptions were corrected rather than counted as product success. [Intermediate local results](evidence/chromium-startup-20261023/local-intermediate-failures.json), [five-trial receipts](evidence/chromium-startup-20261023/local-intermediate-trials/). One abandoned early implementation incorrectly rejected Edge's zero-code launcher handoff; real-browser RED evidence caused that proposal to be removed. The final regression preserves the handoff while requiring endpoint/CDP readiness.

## Diagnosis and unresolved risk

An **instrumented recurrence** was subsequently found in [Windows push quality 40000834754](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40000834754), job `120576153739`, at `3a78784`: browser 79 passed/1 failed. Selected Chrome `156.0.8078.48`, profile writeability true, child spawned at 297ms, no child exit/close or stderr before the endpoint deadline, and endpoint remained missing at 12311ms. Cleanup removed the profile, then child termination/close were observed at 12906/12907ms. This rules out a premature exit or failed profile-write probe in that recurrence; it demonstrates a live Chromium startup stall before DevTools readiness. It does not identify the internal Chromium/runner cause. [Sanitized failure receipt](evidence/chromium-startup-20261023/instrumented-windows-failure-3a78784.json).

To distinguish startup contention from Browser Lab/upload/download behavior, the focused workflow also compares startup-only experiments with one versus two concurrent fresh profiles, on separate Windows runners. Each matrix leg measures five separate Node invocations with the same 12s endpoint deadline and 65s process-tree guard. All failures remain fatal. This experiment adds diagnostics and coverage; it does not serialize the real B6 suite or change product launch semantics. The probe's failure contract was verified with two real non-browser Node children: all five trials failed, all five receipts were retained, and the supervisor failed overall. One local two-browser Edge probe passed with both profiles and processes cleaned. Hosted results must determine whether concurrency is causal; a hypothesis alone does not justify serializing product behavior.

The [controlled startup comparison 40004565444](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40004565444) at `9b4d0c29766deedecec60f0bea598fbc39f32c9e` completed: startup-only one concurrent **5/5**, two concurrent **5/5** (ten browser sessions), and original B6 **5/5**. Every stored cleanup receipt confirmed profile removal and both processes stopped. [Durable receipts](evidence/chromium-startup-20261023/9b4d0c2/). Tested synthetic merge `bffd655433b7e580d870777dd9456f2f72f87672` has the source tree. Simple two-browser startup concurrency did **not** reproduce the stall, so no serialization change is justified by this experiment. A subsequent independent review reproduced a false-positive experiment result when best-effort close returned with failed cleanup; four durable probe regressions now reject false, unknown or missing cleanup, and both supervisors require verified cleanup receipts. Product teardown semantics and B6 deadlines remain unchanged.

The same missing-endpoint failure also occurred on [Ubuntu push quality 40001604404](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40001604404), job `120578817783`, at `bd41847`: browser 80 passed/1 failed, live Chrome child, writable profile, no endpoint by 12s. Sandbox/GPU stderr categories appeared during forced cleanup, not as proof of a pre-deadline cause. [Sanitized Ubuntu receipt](evidence/chromium-startup-20261023/instrumented-ubuntu-failure-bd41847.json). The stall therefore cannot be classified as exclusively Windows from current evidence.

Full quality [40003387561](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40003387561) at `90355e0` passed on Windows and Ubuntu. Separate [Windows PR quality 40004565449](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40004565449), job `120589059312`, at `9b4d0c2` failed in the existing native `lifecycle_tests` measurement command before Node/browser steps: the test process exited 1 after one retention test reported success, without a completed test summary. Rust source and the main CI workflow were not changed by this patch. That native failure is a separate acceptance gate; focused browser success does not clear it.

Current hosted receipts show a substantial first-launch versus later-launch difference. Profile write probes succeeded; selected Chrome remained alive until endpoint readiness, and bounded stderr reported `devtools_listening`. Brief unreadable endpoint observations cleared on subsequent polling. These observations support a cold-start/runner-timing hypothesis and argue against permanent profile permission failure or premature nonzero exit **in these successful trials**. They do not identify the cause of the historical failures. Diagnostics, metadata reads and logging can themselves perturb timing; five green trials are not a reliability SLA or proof of a causal repair.

If a zero-code launcher hands off but no endpoint ever arrives, the new browser PID can remain unknown. That cleanup receipt reports null instead of claiming all descendants stopped; no broad process search/kill was added. A controlled causal reproduction is still required before changing product launch behavior. The original 12s failures, instrumented recurrence and local cleanup/download failures remain unresolved reliability evidence.

## Read-only device and Vercel boundaries

Leno's Tetherplane status returns `disconnected`; running-agent exact version is **not reported**. The local execution host identifies as `LENO`. Its Tailscale reports `NoState` and `SelfOnline=false`; an observed `tetherd` socket is `SynSent` toward the known relay on port 10000, and route selection uses Wi-Fi's default route. Surface's authorized read-only Tailscale query reports its backend `Running`, Leno offline with last-seen `2026-10-23T14:21:05.1Z` (18:21 Dubai), and RTX host tailnet-online. RTX independently remains Tetherplane-disconnected. VAULTER responds as Windows x86_64 agent `0.1.0`, `background_only`; this does not verify its Control Center frontend.

The observable Leno boundary is tailnet/routing before relay authentication; the reason Tailscale entered NoState remains unknown. No sign-in, elevation, routing/service/task repair, agent restart, re-pairing or identity replacement was attempted. The shortest operational next action is an owner-scoped inspection of Leno's existing Tailscale session in an approved maintenance window.

Authenticated Vercel inspection confirms `tetherplane-pr22-source-preview` deployment `dpl_3dQEdADf6CU8niZvoQ6f9a7zPgjH` at original source `e35782ba`, failing `build-container-init` with `NOW_SANDBOX_WORKER_ROOTDIR_NOT_EXIST`: configured `adapters/control-center` is absent. No settings, protections, deployment target or preview status were changed. No placeholder or public substitute for the private loopback portal was created.

## Release hold and reusable onboarding improvement

Production remains NO-GO until independently verified real-device operation, four-device allow/deny acceptance, trusted public signing, clean installation/upgrade/uninstall, supervised pairing/revocation/reconnect, recovery and rollback, and VAULTER frontend/artwork/OAuth provenance are accepted. Green source or hosted synthetic tests cannot clear these gates.

For recurring setup failures, collect bounded executable/version, child lifecycle, profile writeability, endpoint observation and owned cleanup before changing a timeout. For device outages, distinguish tailnet availability, route selection, authenticated relay state, running-binary provenance and Control Center acceptance. Never repair an apparent authentication problem by replacing identities when the observed failure is earlier in the network path.
