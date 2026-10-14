# First-use proof — read-only

1. Confirm the user controls the local target machine and that the MCP host is connected to the Tetherplane Compact MCP server.
2. List available tools. Verify the six names `device`, `files`, `process`, `browser`, `desktop`, `batch`.
3. Make the following **read-only** tool call to request `device.status`:

Tool: `device`

```json
{"op": "status", "args": {}}
```

4. Observe whether the returned structured result reports success. If it reports `permission_denied`, stop rather than changing the user's grants.
5. Learn the accepted input for later use with the local schema-discovery call:

```json
{"op": "schema", "args": {"namespace": "device", "operation": "status"}}
```

6. Report what was actually returned. A successful local status result does not prove remote pairing, and a TCP connection does not prove authenticated remote execution. No additional privileges are required for this example.
