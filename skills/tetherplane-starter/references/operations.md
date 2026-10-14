# Compact MCP operations

Tetherplane's default MCP surface contains exactly these six tools:

- `device`
- `files`
- `process`
- `browser`
- `desktop`
- `batch`

Every tool accepts an `op`, usually an `args` object, and optional response settings. These are **tool names**, not permission grants. Never invent extra model-facing tools or rely on old Remote Desktop Commander names.

## First call — local, read-only

Call tool `device`:

```json
{"op":"status","args":{}}
```

This maps to the provider-neutral `device.status` capability. Report the actual returned status and any policy denial; do not infer success from a successful TCP handshake.

## On-demand schema

Call tool `device`:

```json
{"op":"schema","args":{"namespace":"device","operation":"status"}}
```

The Compact MCP adapter handles this locally and returns the input schema. Request the schema for another namespace/operation before submitting new arguments; unsupported operations yield an explicit error.

## Optional permitted read

Only after the operator confirms a directory is within the agent's **already authorized** roots, use tool `files`:

```json
{"op":"list","args":{"path":"USER_APPROVED_DIRECTORY","depth":1}}
```

If the root is denied, stop and explain the local policy boundary. Do **not** expand `--allow`, edit principal grants, impersonate users, or run a shell command to bypass it.

Use actual results; this reference intentionally provides no write, delete, shell, desktop-input or remote-control examples.
