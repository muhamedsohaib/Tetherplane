# Tetherplane RDC Compatibility Plan

**Goal:** Provide a legacy Remote Desktop Commander-shaped MCP edge over Tetherplane's canonical kernel without introducing RDC names or semantics into providers, policy, or transport.

**Architecture:** A TypeScript compatibility adapter owns legacy tool names, argument translation, result shaping, and adapter-local legacy session IDs. Every machine action is translated into a canonical invocation and executed by `tetherd`. The existing six-tool Compact MCP remains unchanged.

## Non-negotiable boundaries

- RDC naming exists only under `adapters/rdc-compat`.
- The Rust kernel and providers remain canonical and provider-neutral.
- Local policy is authoritative; compatibility never weakens a denial.
- The compatibility adapter does not make the default MCP surface larger than six tools.
- Unsupported RDC service/meta/document features fail explicitly instead of being emulated unsafely.
- Process compatibility IDs never grant authority over arbitrary system PIDs.
- File compatibility stays inside configured allowed roots.

## C1 — Contract and adapter package

Create `adapters/rdc-compat` with an injected canonical `AgentCaller`, legacy tool catalog, invocation builder, result translator, and tests proving legacy names translate only at the edge.
Initial core tool catalog:

- device/config: `list_devices`, `ping`, `get_config`;
- files: `read_file`, `read_multiple_files`, `write_file`, `create_directory`, `list_directory`, `move_file`, `get_file_info`, `edit_block`;
- search: `start_search`, `get_more_search_results`, `stop_search`, `list_searches`;
- process: `start_process`, `read_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process`.

## C2 — File and search compatibility

Map legacy file/search arguments to canonical `filesystem.*` and `search.*` operations. Preserve line offsets, read lengths, write/append behavior, list depth, exact patch replacement counts, progressive search handles, literal/regex mode, hidden-file behavior, case sensitivity, result caps, globs, and context lines where canonical support exists.

Binary/document-specialized `read_file`, spreadsheet ranges, DOCX mutation, URL fetching, and `write_pdf` remain explicitly unsupported in Plan C because they require document/network providers rather than filesystem compatibility shims.

## C3 — Process/session compatibility

Map a legacy command string to canonical `process.run` through the platform shell. Maintain adapter-local numeric compatibility session IDs mapped to opaque `proc_*` handles. Reads, input, session listing, and force termination use the mapped handle.

`list_processes` maps to `process.list_system`. `kill_process` remains intentionally safer: arbitrary human/external system PIDs are denied by the local kernel, while Tetherplane session termination requires an owned handle.

## C4 — Device/config safe subset
`list_devices` and `ping` are local-device compatibility views over `device.status` / `device.capabilities`. `get_config` returns a redacted, compatibility-shaped read-only view of effective launch policy/capability state.

`set_config_value`, `shutdown`, `who_am_i`, usage-history/meta tools, feedback/onboarding prompts, and other RDC service administration features are not silently mapped. They return explicit compatibility errors until canonical capabilities exist.

## C5 — Black-box compatibility proof

Start release/debug `tetherd` through the RDC compatibility MCP adapter and prove:

1. legacy file read/write/append/list/info/move/edit workflows execute through the kernel;
2. progressive legacy search starts, reads and stops/list sessions correctly;
3. a legacy process command can be started, read incrementally, interacted with when appropriate, listed, and terminated using compatibility session IDs;
4. arbitrary system-process termination still fails closed;
5. allowed-root denials survive the compatibility layer;
6. the normal Compact MCP still exposes exactly six tools.

## C6 — Documentation and final gate

Document supported mappings and intentionally unsupported/safer differences. Run the entire repository quality gate plus RDC compatibility E2E.

Plan C is complete only when existing RDC-shaped core workflows can move to the compatibility endpoint without changing their high-level file/search/process behavior, while all stricter Tetherplane safety invariants remain enforced.
