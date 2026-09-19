# Remote Desktop Commander Compatibility

Tetherplane provides an optional RDC-shaped MCP compatibility endpoint under `adapters/rdc-compat`. It exists only to ease migration of existing RDC-oriented workflows.

The default Tetherplane MCP interface is unchanged and still exposes exactly six tools: `device`, `files`, `process`, `browser`, `desktop`, and `batch`.

The compatibility adapter translates legacy tool names into canonical Tetherplane invocations. It does not add RDC semantics or naming to the Capability Kernel, providers, transport, or Policy Broker.

## Supported core mappings

| RDC-shaped tool | Canonical operation |
| --- | --- |
| `list_devices` | `device.status` compatibility view |
| `ping` | `device.status` compatibility view |
| `get_config` | read-only `device.capabilities` compatibility view |
| `read_file` | `filesystem.read` |
| `read_multiple_files` | `filesystem.read_many` |
| `write_file` | `filesystem.write` / `filesystem.append` |
| `create_directory` | `filesystem.mkdir` |
| `list_directory` | `filesystem.list` |
| `move_file` | `filesystem.move` |
| `get_file_info` | `filesystem.info` |
| `edit_block` | `filesystem.patch` |
| `start_search` | `search.start` |
| `get_more_search_results` | `search.read` plus adapter-local result history |
| `stop_search` | `search.stop` |
| `list_searches` | `search.list` |
| `start_process` | `process.run` through the platform shell |
| `read_process_output` | `process.read` |
| `interact_with_process` | `process.input` followed by `process.read` |
| `force_terminate` | `process.terminate` for an owned compatibility session |
| `list_sessions` | `process.list_sessions` |
| `list_processes` | `process.list_system` |
| `kill_process` | `process.terminate`, still subject to local policy |

## Compatibility state

Progressive search keeps adapter-local history so legacy positive and tail-style offsets can be served without changing the canonical unseen-result search contract.

Process compatibility IDs are synthetic numeric session IDs. They map only to opaque Tetherplane-owned `proc_*` handles. A compatibility ID is never an operating-system PID and never grants authority over a human or external process.

On Windows, interactive input is normalized to CRLF before it reaches the canonical PTY provider. On POSIX systems, input is normalized to LF.

## Stricter safety behavior

The local Tetherplane Policy Broker remains final authority. The compatibility layer cannot bypass or weaken local policy.
An arbitrary `kill_process(pid)` request may therefore fail as `approval_required` or `permission_denied`, depending on where canonical policy stops the request. It is never treated as owned process authority merely because a legacy caller supplied a PID.

Filesystem operations remain restricted to the roots configured when `tetherd` starts. The compatibility endpoint cannot expand those roots.

`get_config` is intentionally read-only. It reports effective capability state and the background-only policy mode, but it does not reveal secrets or mutate launch policy.

## Intentionally unsupported RDC behavior

The following remain explicit `capability_unavailable` compatibility errors until Tetherplane has canonical providers or approval-gated capabilities for them:

- PDF creation or mutation through `write_pdf`;
- URL fetching through `read_file`;
- spreadsheet sheet/range reads;
- DOCX/XML-specialized editing;
- runtime `set_config_value` policy mutation;
- machine `shutdown`;
- RDC account/service metadata such as `who_am_i`, usage history, feedback, and onboarding prompts.

These are not emulated by shell commands or hidden side channels.

## Running the compatibility endpoint

Build the required packages, then launch the RDC compatibility stdio server with a local `tetherd` path and one or more explicitly allowed roots.

The executable entry point is `adapters/rdc-compat/dist/stdio-server.js`. It accepts the same local-agent launch arguments used by the Compact MCP adapter for allowed roots, principal profile, state directory, and browser bridge configuration.

## Verification

The black-box Plan C test starts an MCP client against the RDC-shaped stdio adapter, which starts real `tetherd`. It proves device/config views, file workflows, progressive search, interactive processes, allowed-root denial, fail-closed arbitrary PID termination, and explicit unsupported PDF behavior.
