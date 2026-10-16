# Tetherplane Starter — Agensi listing package

**Price:** Free
**State:** Not submitted. Local package prepared; exact-commit CI artifact selection is required before verification is complete. Leno's broader test limitations are recorded separately.
**Starter version:** 0.1.0
**Candidate source:** https://github.com/muhamedsohaib/Tetherplane/tree/feature/open-source-commercial-model-20261014/skills/tetherplane-starter
**Upload artifact:** tetherplane-starter-0.1.0.zip from the successful exact-commit push CI artifact. Its adjacent SHA-256 and manifest identify the bytes and source. No release tag or marketplace publication is authorized.

## Proposed listing text

**Name:** Tetherplane — Official Starter

**Short description:** Safely connect an AI agent to an existing authorized Tetherplane Compact MCP server, discover six tools, verify read-only device status and troubleshoot authentication or local-policy errors.

**Intended users:** Developers and operators with permission to manage their own computers.

**Value provided:** Local-first setup guidance, read-only status/schema examples, on-demand operation discovery, policy-denial and unavailable-provider guidance, and self-hosting references. The skill is instructions only; it does not install Tetherplane, enable system tasks or configure a relay automatically. Local operation requires no Agensi account, hosted relay or paid subscription.

**Supported MCP tools:** device, files, process, browser, desktop, batch. Each requires the existing installed core, relevant provider and local permission. Discovery does not imply every provider is available.

**License:** MIT OR Apache-2.0, at the recipient's choice, with full LICENSE, LICENSE-MIT and LICENSE-APACHE texts included. The free GitHub distribution remains available independently of Agensi.

**Security and privacy:** No executable payload, embedded credentials, telemetry or analytics is included in the ZIP. The skill does not collect or send machine data to Agensi. Opt-in setup may contact dependency registries; the chosen AI host/model provider has its own data policy. Local stdio involves no Tetherplane relay. A remote relay terminating MCP traffic can see requests and results. Agensi independently records platform searches, loads and usage metadata under its privacy policy; the bundle's lack of telemetry does not mean the platform collects no data. No generic end-to-end secrecy claim is made. The local Policy Broker remains authoritative; background_only and human-resource ownership remain default.

**Suggested category/tags:** Agents & Orchestration; MCP, computer automation, self-hosted, device management, security, developer tools. Confirm actual dashboard choices before submission.

## Evidence and claim restrictions

| Host / workflow | Evidence status | Permitted claim |
| --- | --- | --- |
| Local Tetherplane Compact MCP fixture | Baseline ad2542a: starter-integration passed on Windows and Ubuntu in run 38952769626; final candidate requires fresh checks | Verified CI fixture, not an independent consumer installation |
| OpenCode 2.0.30 discovery | Baseline ad2542a: real isolated HTTP host registered the skill from its exact built ZIP; final CI retains the exact successfully discovered bytes with provenance | Host discovery only; a model invoking/loading/executing the skill is not tested |
| Claude Code / Codex CLI / Cursor activation | Not tested | No tested activation claim |
| Independent clean Windows consumer installation | Not tested | Existing CI smoke is not a clean-machine acceptance pass |
| Leno authenticated remote status | Native Web Test device/status succeeded October 17 in background_only; browser provider reported unavailable | This connection and status result only; no four-device or coexistence claim |
| Four-device authenticated remote operation | Not tested | TCP ESTABLISHED does not establish authenticated remote RPC |
| Operator-observed coexistence | Planned separately; not executed by package preparation | No live coexistence pass or public core release readiness claim |

There is **no guaranteed** installation time, cross-client compatibility, marketplace promotion, uptime or income. No model execution, instant enrollment, macOS/Linux desktop parity, E2EE or security certification is claimed.

## Preserved historical candidate evidence (October 16)

These were existing uncommitted listing-evidence edits when work resumed; the old artifact was rehashed on Leno on October 17 and preserved.

- Source branch: feature/open-source-commercial-model-20261014.
- Candidate commit: ad2542abc84fcdb6f336919e86b561d588784bce.
- ZIP: tetherplane-starter.zip, 12,624 bytes, 11 allowlisted text files.
- SHA-256: f51215ce4a15fac576190248e61a6b8443b3f4baf7dc3c932705c0d148e0c011.
- Historical build record states two independent builds matched. This session reverified the retained bytes/hash.
- Leno location: %LOCALAPPDATA%/Tetherplane/release-candidates/agensi-starter-ad2542a/tetherplane-starter.zip.
- CI run 38952769626: 27 Python skill tests, hygiene, pinned OpenCode discovery, Windows/Ubuntu starter integration and quality jobs passed. Push run 38952762299 also passed all five jobs. Neither retained an artifact.
- These results prove the baseline candidate only; they are not fresh final-candidate test execution.

## Version 0.1.0 package preparation (October 17)

- README now identifies version/change scope. The packager refuses existing destinations, including source-file collisions.
- Two new Leno builds from identical inputs matched byte-for-byte: 12,928 bytes; 11 regular UTF-8 members; fixed ZIP metadata; valid CRCs; full license bytes matched.
- Leno-build SHA-256: 50b21a75cbb0482b9450b01576bb77350ab146d0e36f312f6798bee6763841c5.
- Leno builder: Python 3.10.11. Cross-environment byte identity is not claimed; the selected CI artifact may differ because checkout bytes and compression runtime differ.
- Final submission selection is the successful exact-commit **push CI** artifact and its checksum/manifest, retained after pinned OpenCode discovery. PR artifacts can identify a synthetic merge commit; do not substitute their source identity.
- Read agensi-starter-publication-checklist.md for security/privacy/license declarations and submission gates. Generated artifacts and verification logs are excluded from Git.

## Pre-publication approval gate

The older public creator guide still says Stripe is required even for free listings. Current Terms (updated October 12, checked October 17) explicitly gate paid publication on payout setup, leaving the free-listing requirement unresolved. Terms sections 5.2/8.2 also restrict saving/export/redistribution; their application to this free MIT/Apache package must be clarified before submission. No payout setup, submission or Agensi review has occurred.

Confirm current terms, open-source license compatibility, privacy/security declarations, account eligibility, actual categories and dashboard-only fields before submission. Direct creator-checklist/security-guide retrieval timed out; indexed public text was retrieved subsequently. Its real activation, two-agent testing and independent-tester quality guidance remains unmet; successful host discovery alone is not those checks.

Request separate explicit approval of the exact ZIP/hash and listing before submission or publication, and separate approval for Stripe/payout setup, external communications, merging or a public release tag. Submission is not an acceptance-test shortcut.

References:
- https://www.agensi.io/terms
- https://www.agensi.io/privacy
- https://www.agensi.io/learn/how-to-sell-skills-on-agensi
- https://www.agensi.io/learn/skill-md-format-reference
- https://github.com/muhamedsohaib/Tetherplane/actions/runs/38952769626
- https://github.com/muhamedsohaib/Tetherplane/actions/runs/38952762299
