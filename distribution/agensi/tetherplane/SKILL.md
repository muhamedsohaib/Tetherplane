---
name: tetherplane
description: Use tetherplane's connected MCP tools to inspect and safely operate the user's paired computers. Trigger for device status, files, processes, owned browser workflows, semantic desktop actions, or batched work across user-approved devices; enforce local permissions and human coexistence.
---

# tetherplane

Use the existing, authenticated tetherplane MCP connection to control only devices the user has paired and authorized. This is **not an installer** and the skill does not connect an MCP server by itself.

## Connection prerequisite

1. Check that the user's client exposes tetherplane's six MCP tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`.
2. If they are unavailable, explain that the user must first install/pair a tetherplane device agent and connect the appropriate authenticated MCP server in their client. Ask for the user's own endpoint through their secure client settings, not in public chat. Never assume a shared public relay or fabricate an installation.
3. Ask for the user's intended device when uncertain. Do not infer machine identity from friendly labels; device IDs are case-sensitive.
4. Begin with the read-only `device` operation `op="status"` using the exact supplied device ID. A scheduled task showing Running is not evidence of an authenticated connection.

## Safe operating procedure

1. Inspect capability availability and accepted op schemas via the client's disclosed tool interface. Never guess an undocumented op, parameter, resource handle, or permission. See [MCP contract](references/mcp-contract.md).
2. Prefer semantic, low-cost observations: metadata, accessibility tree, then DOM, screenshot, and coordinates only as a last resort.
3. Prefer one inspect plus one server-side `batch` where supported. Return compact verified results and stable resource handles.
4. Use `background_only` by default. Never steal focus, manipulate the physical cursor or system clipboard, change unrelated browser tabs, close human-owned windows, or kill human-origin processes.
5. Treat `permission_denied` and `approval_required` as authoritative local Policy Broker decisions. Do not switch adapters, devices, tools, identities or transports to bypass a denial. Ask for the prescribed local approval when a task genuinely requires it.
6. For operations that alter data, require the user's scoped authorization. Financial actions, outbound messages, destructive file operations, and foreground control require their appropriate independent approvals.
7. Verify the requested postcondition from actual tool responses. Report unsupported, offline, unverified or partially executed work explicitly; do not claim success from scheduled-task state or submitted actions alone.

## Examples

- “Check Surface connectivity” → call `device(op="status", device="Surface")`; report the actual device result.
- “Inspect a file on RTX” → verify RTX first; then discover the permitted read operation under `files` and use only an approved root.
- “Fill this form on my computer” → discover `browser` capabilities, request permission where needed, observe/act/wait/verify in a tetherplane-owned context; never take control of a human tab silently.

## Boundaries

Do not copy, expose, transmit or log bearer tokens, cookies, device credentials, private keys, or OAuth secrets. Each machine retains its own local pairing identity. Skills installed from Agensi are instructions, not executable native agents, signed installers or grants of authority.
