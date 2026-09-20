# Recovery and Chaos Contract

Tetherplane recovery behavior is explicit rather than based on invisible continuation.

- **Browser rerender/restart:** semantic references are reacquired only when identity remains unambiguous; otherwise the action fails as `stale_reference`. Covered by `tests/e2e/browser-recovery.test.ts`.
- **Desktop rerender:** Windows UIA references use semantic reacquisition and fail safely if the target cannot be recovered. Covered by the desktop coexistence black-box test.
- **Relay loss:** in-flight calls fail as disconnected. A reconnect creates a new connection generation and does not replay the old invocation. Covered by relay and remote-plane E2E tests.
- **Client retry:** state-changing callers can use canonical idempotency keys. A repeated identical mutation returns the stored result; a conflicting mutation with the same key fails.
- **Controller replacement:** durable jobs/checkpoints and job execution leases live in local state and can be resumed by permitted principals.
- **Process handles:** process handles are runtime-scoped. A handle from a terminated/restarted agent cannot bind to an unrelated new process; it fails as an unknown/expired handle.
- **Foreground lease expiry/release:** expired or released leases cannot authorize physical action. Restoration state is tracked and tested.
- **Sleep/wake:** Tetherplane relies on operating-system/monotonic timing semantics used by the relevant runtime components. The repository does not currently claim hardware sleep/wake certification; that requires execution on a suitable interactive machine/runner.

No recovery path is allowed to expand principal authority or resource ownership.
