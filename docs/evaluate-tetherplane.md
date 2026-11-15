# Evaluate Tetherplane safely — developer path

Tetherplane is an open-source Model Context Protocol (MCP) control plane for **computer use that the device owner explicitly authorizes**. It has six compact MCP tools: `device`, `files`, `process`, `browser`, `desktop`, and `batch`.

**Status (2026-11-15):** The latest proposed Windows three-step onboarding package remains an **unsigned, unaccepted private-beta candidate** ([PR #135](https://github.com/muhamedsohaib/Tetherplane/pull/135)). Automated checks and earlier releases are not a substitute for independent clean-host, consent, denial, revocation and recovery acceptance. **Do not weaken Windows security protections or deploy this candidate to an everyday workstation.**

## Choose your evaluation path

| Your goal | Appropriate starting point | What this does **not** prove |
| --- | --- | --- |
| Review the idea and security model | [What Tetherplane does](what-is-tetherplane.md), [threat model](security/threat-model.md), [policy](../SECURITY.md) | A working installation on your device |
| Examine the code and run tests | [Local developer build](#local-developer-build) | A supported end-user installer |
| Assess remote-device design | [Self-hosting architecture](remote/self-host.md) and [authenticated plane](security/remote-plane.md) | Automatic permission to access any device |
| Consider a private beta | [Operator-observed acceptance](live-acceptance.md) and [PR #135](https://github.com/muhamedsohaib/Tetherplane/pull/135) | Public release readiness |

## Local developer build

The repository's [README](../README.md#local-quick-start) is authoritative. Development requires the pinned Rust toolchain in `rust-toolchain.toml`, Node.js **22+**, and pnpm **10**. From a fresh checkout:

```sh
corepack enable
corepack prepare pnpm@10 --activate
pnpm install --frozen-lockfile
cargo test --workspace
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

On a Windows developer machine, the Compact MCP local example after building is:

```powershell
node adapters/compact-mcp/dist/stdio-server.js --tetherd target/debug/tetherd.exe --allow C:\path\you\explicitly\allow
```

Replace the example path with a **test-only directory you own**. Do not use broad roots, sensitive home directories, production machines or secrets for an initial evaluation. MCP host integration and additional provider grants remain separate configuration steps; starting this server is **not** proof that a client has initialized successfully.

## What to verify, not just what to demonstrate

The smallest useful evidence from an authorized test is:

1. The AI client can initialize the correct local MCP connection and see the six-tool interface.
2. An explicit, harmless `device.status` returns the expected authorized device.
3. A permitted read within the **test-only allowed root** works.
4. An out-of-policy path or operation is **denied**, with no bypass through another tool.
5. A harmless permitted process completes **if process access was explicitly granted**.
6. If you intentionally test remote or browser/desktop operations, separately verify pairing, ownership, revocation, recovery and lack of disruption to human-owned resources.

Check actual result state rather than treating successful tool dispatch as proof of the intended effect. Record only non-sensitive pass/fail evidence and the exact tested source revision.

## How to help without installing a beta

- Inspect and challenge the [threat model](security/threat-model.md), [recovery behavior](recovery.md), and [remote pairing](remote/self-host.md).
- Review open-source code and benchmark methodology, including documented misses: [release-candidate measurements](benchmarks/release-candidate-2026-09-21.md).
- Report reproducible issues or specific unclear documentation via [GitHub Issues](https://github.com/muhamedsohaib/Tetherplane/issues/new). **Do not post vulnerabilities, credentials, user data or device identifiers publicly**; use [SECURITY.md](../SECURITY.md) for security reporting.
- Specify the device, operating system, MCP host, expected result, observed result and exact commit **without sharing secrets**.

## Questions worth testing

- Can a new developer identify the *minimum* safe permission needed for one task?
- Can a device owner understand and revoke a grant?
- Can an AI client distinguish `operation accepted` from `intended application state verified`?
- Do failures leave the device reachable and the human's desktop undisturbed?

**If these are not reproducibly true for a specific version and device, call that outcome unverified.** No installation, security, speed or reliability guarantee is implied here.
