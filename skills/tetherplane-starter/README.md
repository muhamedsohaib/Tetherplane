# Tetherplane Official Starter (free)

This Agent Skills-format bundle helps a compatible AI agent connect to an already authorized Tetherplane Compact MCP endpoint and safely verify its first read-only operation. It is freely available with the open-source Tetherplane core; payment and Agensi registration are **not** required.

## Install

Clone or download the official Tetherplane repository. Copy the `skills/tetherplane-starter` folder into the skills location documented by your particular agent client, or select it from a future approved marketplace listing. Check your client accepts the Agent Skills format; a generic MCP client alone does not necessarily auto-load SKILL.md.

The skill does not install binaries or configure host MCP settings. Read `references/setup.md` and configure the official Compact MCP endpoint separately, with an approved local directory. Activate by asking your agent to **"check Tetherplane device status"** or **"help me safely connect Tetherplane"**.

## Scope

- Local, read-only status first; optional schema discovery.
- Six default MCP tools, without impersonation or privilege escalation.
- Error recovery guidance and manual remote pairing references.
- No automatic downloads, credentials collection, analytics or marketplace dependency.

## Verification and limitations

Only devices, hosts and platforms explicitly tested for a release are claimed as verified. Existing local E2E tests for Tetherplane are not evidence that every third-party agent automatically loads this skill, or that a separate four-device authenticated remote mesh works.

Tetherplane core license: **MIT OR Apache-2.0** (see the repository or complete copies of the license texts in a distributed ZIP). This skill is distributed for free.
