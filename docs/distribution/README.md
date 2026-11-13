# Reusable distribution package (review-only)

Source baseline: PR #135 head `13609814029aad7f6db4889cab019ae18ccf535d`. This directory represents **discovery metadata and client instructions**, not a public-release declaration. No marketplace has accepted this package and the Windows candidate remains unsigned and unverified on an independent clean machine.

## Canonical source and small adapters

- `distribution/catalog.json`: common factual description, six tool names, links, status.
- `skills/tetherplane/SKILL.md`: portable skills.sh/agent Skill; instructions only, requires the user to have configured MCP separately.
- `.claude-plugin/plugin.json`: Claude plugin identity and skill discovery; deliberately does **not** advertise a nonexistent MCP server.
- `gemini-extension.json` and `GEMINI.md`: Gemini CLI context-only extension; no silent device installation, authentication or MCP configuration.
- `docs/distribution/MARKETPLACES.md`: submission queue and gating evidence.
- `scripts/distribution/validate.mjs`: deterministic consistency and guardrail tests.

The official MCP Registry requires an actual supported package or remote server deployment and namespace validation; a registry `server.json` must be generated only after package/endpoint and installation claims are real. Do not publish a manifest with fabricated npm identifiers or unauthenticated relay URLs. Cursor or other platform adapters should be added only after current schema and installation behavior can be tested. Avoid duplicating Agent C's existing listing.

## Owner-supervised onboarding acceptance

1. Obtain exact reviewed ZIP via owner approval, verify hash, extract to a fresh folder. Do not bypass Windows protections.
2. Start the extracted launcher and enter an owner-approved WSS relay address; do not embed tokens. Device generates credentials and displays a code.
3. Authenticated account owner matches exact code and approves the device, separately grants requested capability scope and browser tabs when needed.
4. Independently check device.status by exact device ID, execute a harmless scoped read and an intentionally denied operation; capture results and elapsed setup time.
5. Validate revocation, restart/reconnection, stop, uninstall and rollback. Confirm no additional human-interfering UI operation.

Clean-install completion is currently UNKNOWN. See `docs/developer-beta-add-device.md` for canonical implementation-specific details.

## No analytics surprises

Collect only consenting, opt-in non-sensitive counters: source campaign, download, pairing result, first verified operation, retries/failure codes, and return after 7 days. Do not collect filenames, contents, commands, tokens, tabs, device identifiers, or IP addresses as growth analytics. Aggregate counts suffice for the first ten pilot installations.
