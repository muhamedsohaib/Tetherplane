# MCP contract (operational guide)

A connected tetherplane server exposes exactly six model-visible tools:

| Tool | Purpose |
| --- | --- |
| `device` | Identify, inspect status and discover allowed capabilities; some management operations are account-scoped and may be denied |
| `files` | Read/search/write within the local policy's permitted roots |
| `process` | Inspect and manage owned processes and jobs within policy |
| `browser` | Operate authorized browser contexts using accessibility/DOM semantics and verified actions |
| `desktop` | Observe and act through approved semantic desktop capabilities; physical foreground control requires a scoped lease |
| `batch` | Perform supported actions in one policy-checked, ordered server-side batch |

Use the client's actual tool schema and capability-disclosure responses rather than treating these summaries as complete operation schemas. Operations are op-based and provider-neutral. Do not expose dozens of imagined tools or private transport internals.

## Observed read-only operation

When the connected schema supports it, request `device` with `op="status"` and the user's exact `device` ID. A valid result reports agent version, operating system, architecture, uptime and local policy mode. Offline, unknown-device and permission-denied responses must be presented distinctly.

## Approval, ownership and coexistence

The on-device Policy Broker is the final authority. Default to `background_only`. Do not touch the user's foreground session or unrelated owned resources without explicit scoped approval. Stop after denial; do not try alternate tools to achieve a forbidden effect. Keep native pairing and credentials entirely on the user's own devices. Never put a token or credential in a copied command or the model's output.

## Availability

The Agensi skill ZIP does not install a native Windows agent, configure an OAuth client, operate the user's relay, or add a device. The user must separately provision and authenticate their own tetherplane installation. Store distribution and public production onboarding may be at a different release stage from this reusable instruction bundle.
