# Tetherplane — review-only marketplace submission draft

**Do not submit, publish or claim current approvals without owner authorization.** Current foundation is an unsigned Windows developer-beta, pending real clean-device acceptance.

## Canonical title
Tetherplane — Authorized Computer Connectivity for AI Agents

## Short description
Open-source MCP control plane for owner-authorized computers: files, processes, browser and desktop operations with local policy enforcement and background-first execution.

## Full description
Tetherplane enables AI agents to operate computers they are explicitly authorized to access, locally or through a separately configured authenticated relay. Its Compact MCP interface exposes six tools — device, files, process, browser, desktop and batch — with discoverable operations. Local policy enforcement, browser ownership rules and scoped foreground permissions are designed to protect a person using the machine at the same time. The core is self-hostable and dual-licensed MIT OR Apache-2.0. Availability and installation requirements vary by platform; the latest Windows onboarding ZIP is an **unsigned private-beta review candidate**, not a signed production release. The portable Skill and client plugin descriptors contain guidance; they do not install, authenticate, or automatically approve a device.

## Search metadata
MCP, AI computer use, authorized device control, background automation, local-first, self-hosted, remote device, Windows, browser automation, desktop automation, scoped permissions, secure relay.

## Source and disclosures
- Source: https://github.com/muhamedsohaib/Tetherplane
- License: https://github.com/muhamedsohaib/Tetherplane/blob/main/LICENSE
- Security: https://github.com/muhamedsohaib/Tetherplane/blob/main/SECURITY.md
- Review candidate: https://github.com/muhamedsohaib/Tetherplane/pull/135
- Onboarding guide: https://github.com/muhamedsohaib/Tetherplane/blob/feature/developer-beta-single-zip-three-steps-20261109/docs/developer-beta-add-device.md

## Cursor Marketplace
- Submission: https://cursor.com/marketplace/publish
- Use `.cursor-plugin/plugin.json` + existing Skill. Describe as instructions-only, with separately configured MCP connection. Owner approval required before publication.

## Claude plugin directory
- Submission: https://claude.ai/directory/manage
- Use `.claude-plugin/plugin.json` + existing Skill. Confirm account verification and license fields during review. Do not submit to Anthropic's legacy official-plugin GitHub repo.

## Gemini CLI Gallery
- Discovery: https://geminicli.com/docs/extensions/releasing/
- After approval and review, add GitHub repository topic `gemini-cli-extension` to enable gallery indexing. This staged manifest provides context instructions, not MCP auto-configuration.

## Glama MCP
- Add MCP Server: https://glama.ai/mcp/servers
- GitHub URL and description are ready for form, but do not claim verified independent installation or production auth. Indexing may be rejected until functional health testing is possible.

## Cline MCP Marketplace
- Submission issue: https://github.com/cline/mcp-marketplace/issues/new/choose
- Attach a genuine 400x400 PNG logo and source URL; include honest installation evidence. Test Cline following this repository's `llms-install.md` before submission, as required by the marketplace.

## Official MCP Registry
- Official publishing guide: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/publishing.mdx
- Reserve `io.github.muhamedsohaib/tetherplane` only after actual namespace/login validation. Publish an official `server.json` only for an independently usable package or remote endpoint; current draft intentionally has neither.

## Developer launch post (draft, not sent)

**Show HN: Tetherplane — an open MCP control plane for authorized computers**

I built Tetherplane to let AI agents operate computers with a small six-tool MCP interface, without assuming they own the human's browser, cursor or workspace. It prioritizes local authorization, background operations and explicit browser grants. The source and security notes are public. The latest Windows first-use package is still in an unsigned, owner-supervised beta — I'm looking for technical feedback on the onboarding and policy boundaries, not claiming a finished consumer installer.

Repository: https://github.com/muhamedsohaib/Tetherplane

## Requested approver decisions

- Approve publishing a transparent guidance-only Skill/plugin listing before the signed production release, or hold all public marketplace submissions until live clean-device acceptance.
- Later separately approve any official registry publishing, marketplace submission, social launch, new hosted endpoint, signing expense, or public release.
