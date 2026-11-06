# Combined browser action deadline contract

This review-only change addresses a real timeout mismatch on an authorized Edge tab; it is **not** deployed to the installed agent or combined router.

## Existing failure path

- The Windows native browser provider used a 2-second default loopback RPC deadline and extended only `browser.snapshot` to 8 seconds.
- The combined router used 3.5 seconds for `browser.act` and `browser.wait`.
- The verified semantic action engine may wait up to 5 seconds *after* a click for a changed page revision.
- Therefore an allowed, successfully dispatched action could be abandoned by the native provider or router before semantic verification completed. An upstream timeout does not prove the click failed to execute.

## Candidate

- Preserve 2-second fast handshake/status/page operations and existing snapshot budget.
- Use a bounded 12-second combined-router budget for `act` and `wait`, and a 14-second native RPC allowance for the same operations.
- On unconfirmed action execution, return `action_outcome_unknown` at the combined router; native maps it to `ActionUnverified`. The operator must inspect, not automatically retry.
- Preserve exact page identity routing, existing local token authentication, explicit tab sharing and owner policy. A failed owner operation must not retry on managed CDP.
- These are deadlines, **not** command cancellation. Other browser response-path resilience changes remain in a separate review branch and require compatibility testing with the installed popup/grants before any owner-approved cutover.

## Acceptance

Router tests confirm owner/managed isolation, denied human tabs, fast status/page reads, longer action budgets and typed uncertainty. Native Rust tests use a disposable loopback fixture to prove action RPC can finish after the old default, and a missing acknowledgement maps to action-unverified.

Before installing, pass the isolated Windows and Ubuntu runner jobs, review exact binary and task hashes, preserve owner-local backups, and independently verify a permitted synthetic browser action, a denied action, revocation, and rollback. **Do not test by repeating actions on a financial or wagering site.**
