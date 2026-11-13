# What is Tetherplane? An open-source MCP server for authorized AI computer use

**Tetherplane** is an open-source, self-hostable control plane that allows AI agents and MCP-compatible clients to operate **computers explicitly authorized by their owners**. It is designed for developers who want practical local or remote computer workflows while retaining local device policy and human control.

- **Source code:** https://github.com/muhamedsohaib/Tetherplane
- **Primary interface:** Model Context Protocol (MCP), with six compact tools
- **Main implementation:** Rust device agent and TypeScript MCP/relay adapters
- **Primary desktop target:** Windows
- **License:** MIT OR Apache-2.0 (see repository license files)
- **Release readiness:** The newest three-step Windows onboarding package is an unsigned review candidate; no independent clean-device acceptance is asserted

## What can an AI agent do with Tetherplane?

Tetherplane's default Compact MCP interface exposes six tool names rather than a large list of one-off commands:

| MCP tool | Purpose |
| --- | --- |
| `device` | Identify explicitly authorized devices, status, and available capabilities |
| `files` | Work inside allowed filesystem paths, including reads, searches, and guarded modifications |
| `process` | Run authorized terminal processes and read incremental results |
| `browser` | Observe or act through permitted browser sessions and authorized tabs |
| `desktop` | Use supported Windows UI Automation operations within local policy and grants |
| `batch` | Combine independent authorized operations with per-operation policy checks |

Each tool accepts operations selected by `op`. Capabilities and grants depend on the actual installed agent version, configured providers, and the specific device. Tetherplane does not grant broad computer access simply because a client supports MCP.

## Local vs. remote access

**Local:** The agent and an MCP client can run on the same machine without a hosted relay. Device policy restricts the paths, operations, and side effects allowed.

**Remote:** An authorized device can connect outbound to an authenticated relay. The relay routes requests; the local agent remains the final policy authority. Remote access requires explicit pairing and authenticated user/client authorization. See [self-hosting documentation](remote/self-host.md).

## How is Tetherplane different from ordinary remote desktop automation?

Tetherplane prioritizes **background-first, semantic computer automation**. Where possible, browser and desktop providers operate on app elements or owned resources rather than moving the human user's cursor or changing the active window. An existing human-owned browser tab is not automatically available for automation. Foreground-disruptive operations require additional scoped authorization.

It also aims to distinguish an operation being sent from its intended effect being **verified**. An action can execute without the application's final state being verified; clients should report that uncertainty instead of claiming completion.

These are architectural behavior and policy constraints, not a guarantee that every possible UI workflow succeeds or that every operating system has equal support.

## Can Tetherplane control my browser without my permission?

**No general browser grant is implied by device pairing.** Existing human tabs need separate, explicit ownership-sharing authorization. A policy denial is not a request to bypass controls with another tool.

See the [security policy](../SECURITY.md) and [threat model](security/threat-model.md).

## Is Tetherplane ready for an unattended public Windows installation?

**Not on the evidence currently published for the newest onboarding candidate.** The [three-step Windows beta proposal, PR #135](https://github.com/muhamedsohaib/Tetherplane/pull/135) includes automated package and integrity checks. It remains unsigned and requires independently observed first-use pairing, permitted and denied operations, revocation, restart/reconnection, and recovery tests. Do **not** disable SmartScreen, Smart App Control, or antivirus protections to install it.

The repository includes a historical `v0.1.0` release. Its existence must not be confused with acceptance of the more recent developer-beta package.

## Does a Tetherplane Skill install or authorize the MCP server?

No. An agent Skill can describe how to use Tetherplane when a compatible MCP connection has already been configured and authenticated. A Skill listing, plugin descriptor, directory submission or a successfully downloaded ZIP is **not** evidence of a connected device.

For current setup instructions, see the [README](../README.md), and for release acceptance methodology, see [live acceptance](live-acceptance.md).

## Who maintains Tetherplane?

Tetherplane is developed in public in [muhamedsohaib/Tetherplane](https://github.com/muhamedsohaib/Tetherplane). Check the actual source branches, review PRs, release artifacts and verification evidence before adopting it. Report security issues privately as described in [SECURITY.md](../SECURITY.md).
