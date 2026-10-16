---
name: tetherplane-starter
description: Use when a user asks to install or connect Tetherplane to an AI agent, inspect its six MCP tools, check device status, diagnose a permission-denied call, or set up safe local or self-hosted access.
---

# Tetherplane — Official Starter

Teach an AI agent to use the open-source Tetherplane control plane safely. The core works without Agensi or paid services.

## Workflow

1. **Confirm authorization and prerequisites.** Ask which machine the user owns or administers, which agent/host they use, and whether they want local or remote mode. Read [setup](references/setup.md). Never install, edit system tasks, or connect a remote host without the user's authorization.
2. **Discover before acting.** Check that the available MCP server is actually named Tetherplane and lists exactly the six default tools in [operations](references/operations.md). Do not substitute tools belonging to another server. Prefer `device` with `op: status` and `args: {}` for the first **read-only** call.
3. **Confirm observed results.** Report whether the status call succeeded, failed, or was unavailable. A process running or a TCP connection alone does not prove authenticated remote RPC.
4. **Discover only the needed schema.** For later operations, call `device` with `op: schema` and `args` identifying the namespace and operation. Respect the returned schema and local principal policy.
5. **Stop on access problems.** Read [troubleshooting](references/troubleshooting.md). On `permission_denied`, request human review; do not bypass policy, fabricate an approval, widen roots, or alter service identity. On `capability_unavailable`, describe the unsupported provider; do not pretend the action succeeded.
6. **Report compactly.** Give the verified device, transport mode (local vs authenticated remote), outcome, and one actionable next step. State unknowns explicitly.

Use [safe first-run](examples/safe-first-run.md) as the worked example; its corresponding machine-readable local MCP calls are in [first-run.json](examples/first-run.json).

## Security boundaries

- The local Tetherplane agent, not this skill or the model, decides permissions.
- **Never request credentials, API tokens, passwords, private keys, cookies, or authorization headers in chat.** Use the operator's existing protected credential manager, environment reference, or on-machine secured files without reading or printing secret values.
- Default to `background_only`. Do not steal focus, control a physical pointer or global clipboard, navigate human-owned tabs, or terminate human-origin processes.
- Do not perform financial actions, communications, destructive operations, or foreground control without the appropriate explicit human approval and local policy authorization.
- Never upload logs or machine data to Agensi. This skill requires no telemetry, paid entitlement, cloud account, or new network connection.

This skill does **not** install Tetherplane automatically or claim support for untested agents. Report actual capability and confirmation evidence rather than promises.
