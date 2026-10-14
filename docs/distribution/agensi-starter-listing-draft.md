# Tetherplane Starter — Agensi listing draft

**Price:** Free
**State:** Not submitted
**Canonical source:** `https://github.com/muhamedsohaib/Tetherplane/tree/main/skills/tetherplane-starter` (link becomes available after the skill branch is merged)
**Upload artifact:** `tetherplane-starter.zip` (single top-level `tetherplane-starter/` directory, including `SKILL.md`)

## Proposed listing text

**Name:** Tetherplane — Official Starter

**Short description:** Safely connect an AI agent to an existing Tetherplane Compact MCP server, discover six tools, verify read-only device status and troubleshoot authentication or local-policy errors. No cloud account or paid subscription required.

**Intended users:** Developers and operators with permission to manage their own computers.

**Value provided:** Clear local-first installation steps, a verified read-only first-call example, on-demand schema discovery, denied/unavailable guidance and self-hosting references. No automatic installation or elevated system actions.

**Supported MCP tools:** `device`, `files`, `process`, `browser`, `desktop`, `batch` (all require the existing installed core and relevant local permission).

**Security:** No credentials, prompts or machine data sent to Agensi by the skill; no third-party network calls or hidden scripts; local Policy Broker remains authoritative. Remote control requires independent authenticated pairing and local permission.

## Evidence and claim restrictions

| Host / workflow | Evidence status | Publication claim |
| --- | --- | --- |
| Local Tetherplane Compact MCP fixture | Not tested on this branch | Do not claim live verified until E2E green |
| Claude Code skill activation | Not tested | Compatibility is a format-level expectation only |
| Codex CLI skill activation | Not tested | No tested activation claim yet |
| Cursor skill activation | Not tested | No tested activation claim yet |
| Four-device authenticated remote operation | Not tested | TCP `ESTABLISHED` does not establish authenticated remote RPC |

There is **no guaranteed** installation time, cross-client compatibility, marketplace promotion, uptime or income. Publish only results that were tested and recorded for the exact candidate commit.

## Pre-publication approval gate

- Confirm current Agensi creator terms, pricing (Free), license declarations, package size/structure, privacy and security scan requirements.
- Confirm real local MCP smoke and a supported agent activation test; keep unsupported platforms marked unverified.
- Request explicit user approval before submitting the ZIP, changing a listing, sending messages, linking payout details or publishing public marketing claims.
