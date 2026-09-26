# ChatGPT and other orchestrators

## Implemented path and current limit

The implemented remote path is an MCP Streamable HTTP client to `tether-relay`
at `/mcp`, then an account-scoped device router, an outbound authenticated
device WebSocket, and the local `tetherd` policy broker and providers. The
local path is Compact MCP stdio to `tetherd`. The canonical invocation/result
protocol does not depend on ChatGPT. A generic OpenAI-compatible model client
also exists, but it submits a model's proposed *action* to the local agent;
it is not a remote model-inference service.

The relay currently authenticates client bearer tokens from environment
variables named in its auth config. It does **not** implement an OAuth/OIDC
authorization server, OAuth protected-resource discovery, a ChatGPT account
connection, or a durable hosted deployment. Do not put a static token in a
plugin manifest or send one to ChatGPT as a substitute for OAuth. The private
Tetherplane plugin previously used an ephemeral `trycloudflare.com` MCP URL;
such a tunnel address is not a stable account integration.

## ChatGPT installation path

For a private ChatGPT connection, use OpenAI Secure MCP Tunnel with the
existing local Compact MCP stdio adapter on the target device. The tunnel
client runs beside that adapter and makes an outbound connection; it does not
require a public Tetherplane listener or the experimental relay. Create a
ChatGPT developer-mode MCP app using the tunnel ID, then connect that app to
the account. This route is for private/developer-mode use and still requires
the target device, local agent, and tunnel client to be running. The tunnel
authenticates transport to OpenAI; local principal grants and the local
policy broker remain the execution boundary.

For a hosted multi-device deployment, use a stable HTTPS remote MCP endpoint
with a reviewed OAuth/OIDC identity provider and configure a custom MCP app
through the ChatGPT workspace developer flow. The identity provider must bind
each client request to an account, client, and principal. The relay must
continue to enforce account/device routing, and `tetherd` must continue to
replace any caller-supplied principal with its launch-bound local principal.
Keep the local agent's grants narrow; an OAuth login does not widen them.

After the endpoint, OAuth registration, and custom app are verified, an
eligible user must complete the account connection in ChatGPT. In a new
ordinary chat, select or @mention Tetherplane for each message that needs a
new tool call. Current ChatGPT app selection is message scoped; an installed
plugin or app does not guarantee automatic tool access in every message.
Do not report normal-chat access as passing until a fresh chat invokes the
live `device` tool and receives a real device result.

The existing private plugin packages a skill and a direct MCP declaration.
It can be useful on a supported desktop surface, but a remote MCP declaration
alone does not establish ChatGPT web availability or account authorization.
Avoid creating a second Tetherplane integration until the custom app path is
verified and the old plugin's role is settled.

Do not expose the whole six-tool interface through a tunnel with an unscoped
local principal just to reach Ollama. `process.run` is an existing way to make
a bounded temporary Ollama proof on a device where local policy grants it,
but `models.invoke` is not implemented and process grants are broader than a
model-only permission. A persistent model-facing connection needs a narrow
local principal and a dedicated model capability before general use.

## Tool and device contract

The remote MCP surface currently exposes exactly six tools: `device`,
`files`, `process`, `browser`, `desktop`, and `batch`. Use `device` status or
capabilities for a known device. Compact MCP translates these tools to the
canonical capability envelope. File and process operations route to local
providers under device policy. Browser and desktop availability depends on
the device's installed providers and grants. Batch operations do not bypass
policy checks on child operations.

The relay rejects unknown, revoked, offline, and cross-account devices. If a
request omits a device while multiple devices are online, routing fails
closed. A device record in the pairing registry proves pairing history, not
current connection or capability availability. Resolve device, capability,
worker/model, and task in that order once worker discovery exists.

## Model workers

There is no implemented `models.list`, `models.status`, `models.invoke`, or
`workers.*` remote capability in this release. The generic model client is
model-neutral and can call an OpenAI-compatible inference endpoint, but it
does not discover or invoke Mistral on an RTX device on behalf of an MCP
caller. Do not advertise Mistral availability or invocation on that basis.

A future worker implementation should register a model against a device and
bounded capability grant, verify availability, invoke through the local
policy authority, and return output plus request ID, model ID, device ID,
timestamps, exit state, usage when available, and artifact references. It
must not return hidden reasoning or permit model output to grant authority.
Another authenticated MCP/API client should be able to use the same canonical
contract without a ChatGPT-specific branch.

## Security and approval

Public discovery is acceptable only where the chosen OAuth profile requires
it. Tool execution requires authenticated identity and a permitted device.
The effective authority is the intersection of relay account routing,
transport-bound principal, local principal grants, resource roots, ownership
rules, side-effect policy, and any foreground lease. The local policy broker
is final. Mutations use idempotency where supported and produce audit lineage.
External communications, purchases, contracts, destructive deletion,
regulated actions, privilege elevation, and other irreversible operations
require an explicit human gate in the executing device policy. Never rely on
prompt text as that gate.

The relay's static bearer mode is suitable only for controlled self-host or
development use. A production OAuth proxy must not trust identity headers
from the public network and must protect the relay-facing hop. See
`docs/remote/self-host.md` and `docs/security/remote-plane.md`.

## Acceptance and troubleshooting

Before claiming end-to-end success, verify in order:

1. Stable HTTPS `/mcp` discovery reaches the relay; unauthenticated tool
   execution is rejected.
2. OAuth login binds the intended account and can initialize an MCP session;
   another authenticated client cannot reuse that session ID.
3. The intended device is online and `device.status` and granted file/process
   operations return real device results.
4. The model registry reports Mistral on the RTX device, and a bounded invoke
   returns an actual result with audit/provenance identifiers.
5. A fresh ordinary ChatGPT chat can select or @mention the connected app,
   perform both calls, and a second new chat can do so without reinstalling.
6. A separate authenticated MCP client can initialize, list the same compact
   tool surface, and execute within its own grants.

If tools are absent, check the installed plugin/app's supported surface,
connection state, MCP URL, OAuth configuration, and server health. If a device
is absent, check the relay pairing record and live WebSocket separately. If a
model is absent, check the device's runtime and model registration; a model
installed on a machine does not imply a Tetherplane worker is registered.

Official tunnel setup and product limits:
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels and
https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt.
