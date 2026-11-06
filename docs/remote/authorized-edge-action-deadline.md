# Owner-authorized Edge action response deadlines

This document describes a **review-only source correction**, not a deployed change to installed browser extensions or device grants.

## Observed boundary

A browser can be authenticated and have a `shared-authorized` Edge tab while an individual `browser.act` operation is still unable to return a reliable result. The agent's audit record can distinguish `policy_decision=allow` followed by `error_code=timeout` from a separate `browser.diagnostics` denial. Neither a timeout nor unchanged subsequent semantics establishes that a click never occurred.

## New fail-closed behavior

- The extension runtime bounds its acknowledgement for each `perform` request. An unreturned Chrome scripting call yields the machine-readable `action_outcome_unknown` error instead of blocking the message loop indefinitely.
- Affected **tab** mutations are fenced for the life of the runtime; read-only page inspection and explicit tab revocation remain possible. Independent authorized tabs remain usable. The timeout does **not** cancel an in-flight injected browser action.
- The authenticated host's extension command backend has bounded pending-command deadlines and discards late responses by request ID. A timed-out `perform` is reported as `action_outcome_unknown`; a timed-out read returns `timeout`. Timers are cleared when a response arrives.
- No automatic click retry occurs. After uncertainty, inspect the page, allow the owner to revoke/re-share the tab, and check outcomes before explicitly authorizing new mutations.
- All existing local grants, scopes and diagnostic permission boundaries remain in force. **Do not bypass a denied `browser.diagnostics` call**, attach to a personal Edge debugging profile or grant `create_tab` simply to test a click.

## Acceptance evidence required

Isolated tests must prove: timed-out click gets an explicit error; a second click is not sent; unrelated pages remain reachable; observations and revocation work; a stale late result is ignored; a missing read response is bounded; existing policy denials persist. Build/typecheck and signed-Edge isolated acceptance are separate from live-site behavior.

Public source review must precede any local owner-approved extension update. This source change **does not establish** that the original failed click on the protected website executed or that arbitrary site-specific clicks now work.
