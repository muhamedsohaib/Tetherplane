# Windows native agent task and authenticated WebSocket liveness

**Change type:** source/test-only reliability repair on a draft branch. **Not installed** on Surface, Leno, VAULTER or RTX. Source passing and Windows smoke are not signed release readiness.

## Incident and minimum boundaries

On 2026-10-22, Surface and Leno both had a running tetherd.exe with ESTABLISHED outbound TCP to relay port 10000, yet authenticated ChatGPT device.status timed out. Replacing only the old agent process restored actual status and capability RPC on both devices. Leno additionally proved that stopping its PowerShell Scheduled Task left its tetherd.exe child (PID 7660) alive. Surface PID 7588 and Leno PID 7660 were replaced with PIDs 12624 and 26140 respectively; old executable provenance and exact stalled invocation remain unverified. VAULTER remained responsive. This is recovery evidence, not causal proof that a particular work invocation blocked the reader.

The Phase 3/4 reliability agent on the parent draft branch moves invocation execution out of the WebSocket receive loop and reserves 16 work + 4 control permits. That existing code is retained.

## Permanent source changes

1. **Task owns the agent.** For new Windows scheduled installations, action Execute is the installed native bin/tetherd.exe, not powershell.exe. Stop-ScheduledTask therefore owns the process it stops; a launcher cannot leave a detached child. Task settings use IgnoreNew for single instance, bounded Windows task restarts after process exit (99 restarts at one-minute intervals), unlimited task execution time, and battery-safe settings. A running-but-stuck process is *not* automatically killed just because its PID stays alive.
2. **Local arguments file.** The scheduler passes only --arguments-file "<install>\config\agent-args.json" in the task command line. tetherd expands one local JSON string array of at most 16 KiB and runs its *existing* CLI policy/transport parser. Missing, invalid, nested, extra or oversized argument-file requests fail closed. The device credential itself remains referenced by a credential-file path; neither secrets nor full arguments are copied into the scheduled task action.
3. **No silent task migration.** The installer refuses to overwrite any existing named scheduled task, even under -Force. In particular, legacy "Tetherplane Surface Agent" and "Tetherplane Leno Agent" must not be silently replaced while existing processes or uncertain mutations could persist. Installation still preserves state by default and still allows isolated per-user installation. -AgentTaskName supports uniquely named disposable CI tasks.
4. **Relay heartbeat.** Every 15 seconds, the relay pings authenticated device WebSockets. If a connection has not answered its preceding ping by the next interval, it is removed from live-device registration and its route generation is disconnected; in-flight calls resolve as disconnected, not success. A subsequent authenticated agent registration creates a *new* generation. The relay never automatically retries/replays an uncertain mutation. The heartbeat is transport-liveness evidence only, **not** proof of successful AgentRuntime execution or local policy authorization. Failed or stale sockets are terminated after router fencing; unrelated devices stay online.

## Tests and separate acceptance

- Rust CLI unit tests: existing stdio compatibility, valid local relay args, malformed array, nested file, conflicting flags, empty file and 16-KiB limit.
- TypeScript real WebSocket test: deliberately unresponsive client misses Pong; existing in-flight mutation is fenced as disconnected; reconnect does not replay it; fresh authenticated status succeeds while the next healthy Pong responder remains registered.
- Windows release smoke: creates a **disposable**, nonproduction task with a test-only locally looping agent. Validates native executable action, single-instance/restart settings, starts exactly one installed agent, stops it and verifies that its owned PID exits. Task and fixtures are removed after the run. It does not connect to any production relay, register clients or use real credentials.
- Retain parent PR #43 Rust, relay static/OIDC, authorization and non-replay suites. Exact-head Windows/Ubuntu CI and independent review required.

## Before any real-machine rollout

1. Pin exact reviewed source and build commit. Obtain an approved real Authenticode signer; independently verify signature, signer thumbprint, package manifest and every executable/script hash. Ordinary CI does not sign; never downgrade Smart App Control or execution policy to compensate.
2. Test on a clean disposable Windows VM first. Record native task PID/parent, one agent, authenticated control responsiveness under work saturation, missed-pong reconnect, correct authorization denials and no replay. Reboot, stop/restart and rollback to the previous signed package. Fail closed if evidence is incomplete.
3. For each existing Surface/Leno installation: obtain a separately approved maintenance window. Reconcile uncertain mutations, retain the existing pairing/credential file and principal profile, snapshot task XML, old binary hash, source commit if verifiable, process/child identities and state/audit files. **Do not run -Force over an active task or unregister first without an ownership proof.**
4. After confirmed old tasks and orphaned children are stopped and backed up, install the pinned signed candidate in a separate versioned prefix. Create its own approved task name; verify exactly one live outbound registration and authenticated device.status/capabilities plus out-of-root permission_denied. Keep previous task disabled, with signed rollback bundle and state intact; only clean up after independent acceptance.
5. Continue the four-device architecture. VAULTER identity/relay and RTX remain out of this change until separately verified; no OAuth, DCR, scopes, pairing or Tailscale modifications.

**Unresolved:** a mutation that never returns can retain work capacity indefinitely; neither orphan prevention nor WebSocket Ping makes its external effect safely cancellable. A timed-out/disconnected mutation is *uncertain*, not safe to rerun. Source/CI fixes do not substitute for signed clean install, rollback proof and authenticated live four-device acceptance. **Public release remains NO-GO**.
