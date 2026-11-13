# Marketplace queue — evidence and approval boundaries (2026-11-13)

Status conventions: **REQUIRES REVIEW** = prepared instructions/descriptors, not compatibility certification; **BLOCKED BY RELEASE GATE** = cannot responsibly claim a deployable supported package; **READY TO SUBMIT** would mean official schema + complete live install proof + owner authorization.

| Priority | Destination | Format | Queue status | Why / official entry point |
|---|---|---|---|---|
| 1 | Skills.sh | GitHub Skill folder | REQUIRES REVIEW | Source-folder discovery can avoid a domain and hosted relay. Confirm installer detects skill path and then seek owner permission. https://skills.sh/ |
| 2 | Glama | MCP directory | BLOCKED BY RELEASE GATE | Registry listing is not independently proven deployment; review install steps and endpoint. https://glama.ai/mcp/servers |
| 3 | Official MCP Registry | MCP server.json | BLOCKED BY RELEASE GATE | Requires verifiable package/remote deployment and registry namespace ownership. GitHub identity namespace option avoids a paid domain. https://registry.modelcontextprotocol.io/ |
| 4 | Cursor | Plugin / MCP directory | REQUIRES REVIEW | Package schema and MCP install must be independently verified before listing. https://cursor.com/marketplace |
| 5 | Claude | Plugin marketplace | REQUIRES REVIEW | Skill-only plugin identity is staged; no automatically installed MCP server is represented. https://claude.com/plugins |
| 6 | Gemini CLI | Context extension | REQUIRES REVIEW | Extension manifest provides instructions only; separately configure MCP. https://geminicli.com/docs/extensions/ |
| 7 | Docker MCP Catalog | Catalog listing | BLOCKED BY RELEASE GATE | No verified immutable distributable MCP server container or docker-hardened install yet. https://github.com/docker/mcp-registry |
| 8 | Cline MCP Marketplace | Marketplace MCP | BLOCKED BY RELEASE GATE | Needs tested MCP installation and security/consent. https://github.com/cline/mcp-marketplace |
| 9 | VS Code / GitHub Copilot | MCP server registry discovery | BLOCKED BY RELEASE GATE | Reuse official MCP registry after real packaging. https://code.visualstudio.com/docs/copilot/customization/mcp-servers |
| 10 | LobeHub | MCP marketplace | BLOCKED BY RELEASE GATE | Confirm public config compatibility and review expectations. https://lobehub.com/mcp |
| 11 | OpenAI ChatGPT / Codex | App / plugin directory | BLOCKED BY RELEASE GATE | Public HTTPS/auth, review and publisher verification may be applicable. Do not conflate local Skill with remotely installed app. https://developers.openai.com/ |
| 12 | Product Hunt / Show HN | Technical launch posts | REQUIRES REVIEW | No incorporation presumed for ordinary community posting; publish only an accurate working demo, with owner approval. https://www.producthunt.com/ and https://news.ycombinator.com/showhn.html |
| 13 | Awesome MCP Servers | Community repository PR | REQUIRES REVIEW | Check each maintainer's listing rules and acceptability of review-only documentation before seeking owner approval. https://github.com/punkpeye/awesome-mcp-servers |
| - | Agent C | Existing Skill listing | NOT SUITABLE | Already published; explicitly exclude duplicate listing. |

**Verification limit:** marketplace policies, ranking algorithms, incorporation/identity rules, reviews, fees, and traffic change. A generic personal GitHub account does not prove the account is eligible to publish in every directory. Reconfirm from official platform submission forms immediately before owner-approved submission; never guarantee zero legal requirements without that verification.

## First installation experiment

Recruit ten consenting new Windows x64 owners using an identical exact-head artifact. Record attempted installation, Windows trust outcome, owner code approval, authenticated device.status, scoped harmless operation, intentionally denied operation, revocation, restart, uninstall/rollback, and whether the user repeated an operation within seven days. Require **10 fully verified successful first-device installations**, not 10 downloads or tests. Diagnose failures before broad launch.

## Commercial hypothesis

Keep the self-hosted core open-source. Test willingness to pay for managed setup, trustworthy remote routing, fleet policy/audit, support and enterprise management only after successful repeatable beta. No current paid customers or willingness-to-pay evidence are asserted.
