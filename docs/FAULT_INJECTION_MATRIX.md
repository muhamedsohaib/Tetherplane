# Fault Injection Matrix

Isolated Linux simulation only: real `tetherd` + relay in temp dirs behind a scriptable proxy, fake browser/desktop backends. No live device, no production relay/state. Each fault: N≥20 seeded runs; ground truth is mutation counters / file bytes / lease owner, never the API's own claim. Full harness: `tests/fault-lab/` (`npm run fault-lab`).

| # | Fault | Oracle (pass) | Target | Status on `main` |
|---|---|---|---|---|
| 1 | Relay SIGKILL + restart | pending → `disconnected`; restart replays nothing; new generation only | restore ≤30s after return | Pass (router/e2e proven) |
| 2 | Half-open blackhole (TCP open, frames dropped) | bounded detect, no hang | suspect ≤15s, dead ≤20s+delay; relay retire ≤60s | **Fail** — no agent heartbeat on `main` |
| 3 | Packet loss / partition, then heal | in-flight `disconnected`/`timeout`; zero duplicate mutations on heal | no dup | Pass with key; unkeyed dup risk (RC-4) |
| 4 | Agent SIGKILL mid-operation | handles invalid after restart; jobs resumable only by lease principal | no stale-handle success | Pass |
| 5 | Expired / revoked auth | reconnect `Fatal` 401/403; revoke closes socket (4001); no routing | denied throughout | Pass |
| 6 | Stale generation result replay | router drops old (generation, routeId) result | dropped, no double-resolve | Pass |
| 7 | Duplicate / ambiguous request | same key+payload → once; diff payload → conflict; dup request_id not cross-correlated | exactly-once with key | Conditional (key required) |
| 8 | Delayed ack > route timeout (30s) | caller gets `timeout`; late result dropped | no double-resolve | Pass |
| 9 | Browser/desktop provider killed mid-call | `provider_failure`/`capability_unavailable`; capability state → `disconnected`/`degraded`, not `available:true` | readiness truthful | **Fail** — readiness is a startup snapshot (RC-3) |
| 10 | Sleep/wake | Linux: clock-skew simulation only (wall-clock lease expiry, monotonic timers) | leases expire; reconnect on wake | Simulated only — **not** Windows proof |
| 11 | Resource pressure (CPU/mem/disk-full on temp state) | bounded errors; idle RSS within baseline envelope | no unbounded growth | Partially measured (local only) |
| 12 | Unauthorized recovery abuse (cross-principal handle/lease/job, approval-shaped args) | every probe `permission_denied`; no authority expansion | denied throughout | Pass |

Experimental proof (§10 of the assignment) maps to rows 1–9 + 12: authorized op succeeds → fault interrupts → degraded state reported truthfully → automatic recovery → fresh authorized op succeeds → unauthorized denied throughout → ambiguous mutation executes once → no `ready` before the capability is actually usable. Rows 2 and 9 are expected-fail on `main` and are the first Spark fixes.
