# Directory publication gate — Tetherplane

**Checked:** 2026-11-15. This is a preparation/eligibility checklist, **not proof of any listing**. Distribution requires a usable installation path or supported remote endpoint and specific owner approval to submit.

## Single canonical source, downstream discovery

The [official MCP Registry](https://modelcontextprotocol.io/registry/about) stores standardized server metadata consumed by downstream directory ecosystems. It is **not a binary host or a guarantee of installation, security approval, user adoption or client compatibility**.

Do **not** submit a fake npm package, a marketing website as an MCP endpoint, private-only device address or an unsigned beta release mislabeled as generally available.

| Channel | Use | Preflight | Current decision |
| --- | --- | --- | --- |
| [GitHub](https://github.com/muhamedsohaib/Tetherplane) | Real source, provenance, docs and issues | Public repository, honest description and safe first-use instructions | Live; enhance evaluation, don't inflate adoption |
| [MCP Registry](https://modelcontextprotocol.io/registry/quickstart) | Canonical `server.json` metadata syndication | Verified GitHub namespace + verifiable **public** install package or qualifying reachable remote MCP endpoint; correct version and ownership | **Hold** pending validated install/endpoint |
| [Glama directory](https://glama.ai/mcp/servers) | GitHub-source MCP listing and optional independent quality checks | Public real source repository, candid release status, correct metadata; distinguish listing from deployability | **Potentially eligible for source listing now**; owner must approve submission and any quality-test access |
| [Smithery](https://smithery.ai/) | Discovery where current supported listing exists | Recheck live intake, service scope and actual install path; historic service behavior may differ | **Research only** |
| Community MCP catalogs | Human discovery | Check each maintainer's current guidelines, categories and anti-spam policy | **Hold** pending meaningful first-use evidence |
| [Show HN](https://news.ycombinator.com/showhn.html) | Developer scrutiny and potential trials | A non-trivial **runnable**, demonstrable release, owner present to answer; author writes their own submission | **Not launch-ready** |
| ChatGPT/Claude/Cursor plugin marketplaces | Application-specific acquisition | Exact current host/plugin packaging, OAuth, server reachability and review requirements | **No eligibility claim** |

An agent **Skill** or listing is not a working authenticated MCP installation. Avoid duplicating the already-published Agent C Skill.

**Verified 2026-11-15:** [Glama's own FAQ](https://glama.ai/mcp/faq) says open-source MCP servers can be submitted using a GitHub repository URL, display name and short description. It may run license/security/health checks. This **does not require claiming the newest Windows binary is signed or accepted**; it also does not guarantee Glama will accept or successfully run Tetherplane's Windows-dependent providers. Check for an existing automatic listing before creating a duplicate. Source listing is a distinct approval from hosting, runtime access, or registry publication.

## Official Registry prerequisites to verify

- [ ] Identify the **exact current release/build** that passed owner-observed acceptance on a clean permitted host, including actual integrity evidence.
- [ ] Choose a publishable **package supported by the registry**, or a genuine reachable public HTTPS/WSS-compatible MCP remote endpoint; confirm its transport and auth.
- [ ] Ensure package publisher ownership metadata and version correspond to the exact releasable artifact. See [official package requirements](https://modelcontextprotocol.io/registry/package-types) and [server.json specification](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md).
- [ ] Select a namespace legitimately controlled by this GitHub publisher, e.g., a valid `io.github.muhamedsohaib/...` name after checking the registry's current format. The [official registry](https://github.com/modelcontextprotocol/registry) supports GitHub OAuth/OIDC and namespace verification.
- [ ] Validate exact `server.json` against [official CLI](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md) and server-side validation **without publishing**.
- [ ] Verify license, security links, owner policy, install instructions, client configuration and availability from **an independent test host**, not just CI.
- [ ] Owner explicitly approves the final metadata and external publication.
- [ ] Publish once through the canonical mechanism; capture listing URL, version, submission confirmation and date.
- [ ] After publication, monitor whether downstream sites actually ingest the entry; don't infer syndication from an upstream success.
- [ ] Retest current listing after each release update, and correct stale, misleading or broken entries.

## Required factual launch packet

The minimum external fact packet should contain:

1. **Problem solved:** Computer-use tasks on explicitly owner-approved devices with local capability enforcement, not broad arbitrary remote access.
2. **Differentiator to test:** Background-first semantics and user coexistence with explicit local policy, *not* claims of universal or bulletproof computer control.
3. **Six MCP tools:** `device`, `files`, `process`, `browser`, `desktop`, `batch` — operations depend on grants, providers and actual installed version.
4. **Trust model:** Self-hostable source, MIT/Apache-2.0, real tests, disclosed limitations and disclosure path.
5. **First action:** A verified, copyable and bounded safe evaluation; until release gates pass, [review source and evaluation path](../evaluate-tetherplane.md).
6. **Canonical links:** [Repository](https://github.com/muhamedsohaib/Tetherplane), [website](https://tetherplane.netlify.app/), [security](../../SECURITY.md), [acceptance](../live-acceptance.md).

## Submission verification log

| Directory | Date | Action | Evidence | Status |
| --- | --- | --- | --- | --- |
| Official MCP Registry | 2026-11-15 | Requirements reviewed; submission intentionally not performed | This checklist | Not submitted |
| Glama | 2026-11-15 | Intake considered; no verified record or acceptance | This checklist | Unverified / not submitted |
| Smithery | 2026-11-15 | Current intake and terms require reconfirmation | This checklist | Unverified / not submitted |
| Show HN | 2026-11-15 | Official rules checked; no posting performed | [Official guidelines](https://news.ycombinator.com/showhn.html) | Not posted |

Preserve precise states. A URL in a directory, GitHub star or request to index a page is not an activated user.
