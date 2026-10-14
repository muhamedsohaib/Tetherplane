# Diagnose failures without expanding authority

Identify the failure layer (host configuration, MCP connection, local Policy Broker, relay authentication, target device). Report the observed error and the smallest safe next check.

| Result | Meaning and safe response |
| --- | --- |
| `permission_denied` | The local policy denied authority. **Do not** change `--allow`, identity, grants or approval metadata automatically. Ask the human operator to review the requested action and device policy; stop if authorization is not granted. |
| `capability_unavailable` | The provider or operation is unsupported/unavailable. Report this honestly; check installed versions and supported capabilities, not hidden fallbacks. |
| `invalid_arguments` | Check the tool name and call `device` / `schema` for the intended operation. Fix the input, not the policy. |
| No MCP tools listed | Check that the chosen host launches the actual local Compact MCP adapter and has the correct executable paths; show only non-secret diagnostics. |
| Authentication failure | Verify the selected endpoint/account/device binding and consult the operator's approved credential manager or secret-file references. Never ask for, print, transfer, log or paste credential material. |
| Device offline / relay unavailable | Check relay readiness and the agent's authenticated session; a TCP connection (even `ESTABLISHED`) does **not** establish authenticated remote RPC. Test an authorized read-only device operation end-to-end. |
| Timeout / interrupted request | Report uncertainty. Avoid replaying mutating actions without checking their idempotency state and the applicable local policy. |

Never bypass the local Policy Broker, weaken TLS, relax permission ACLs, overwrite the system clipboard or interfere with a human-owned browser tab to recover a connection. On an unknown result, say **unknown** rather than green/connected.
