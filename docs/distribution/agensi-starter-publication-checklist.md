# Agensi Starter 0.1.0 publication checklist

**State:** Package preparation only. Not submitted. Changed-component checks passed on Leno; full exact-commit CI and artifact selection are required. Local broader test limitations (Windows code-integrity denial and a stalled worker) remain explicit. Publication, merge/tag, external messages and Stripe setup require separate explicit authorization.
**Source:** feature/open-source-commercial-model-20261014, existing Leno Agensi worktree.
**Scope:** Free instructions-only Starter for an existing authorized Tetherplane installation; no bundled core binary or hosted service.

## Candidate contents and evidence
- Versioned artifact: tetherplane-starter-0.1.0.zip; one tetherplane-starter/ root.
- Exactly 11 regular UTF-8 text members: SKILL.md, README.md, agents/openai.yaml, three references, two examples, LICENSE, LICENSE-MIT, LICENSE-APACHE.
- No executables, symlinks, credentials, machine state or user-specific paths.
- Fixed member order, 1980 ZIP timestamps and regular-file permissions; same input bytes and builder required for deterministic byte identity.
- Build twice to distinct fresh paths, compare bytes and SHA-256, inspect members, sizes, license bytes and CRCs.
- Retain ZIP, .sha256, manifest.json and verification logs on Leno; generated artifacts stay outside Git.
- Manifest records exact committed source, package version, input SHA-256 values, ZIP SHA-256/size/member count, Python/zlib builder versions, and evidence scope.
- SHA-256 detects changed bytes; it is not a publisher signature or proof of marketplace approval.
- Verify full noninteractive repository gates and exact-commit CI. Keep operator-observed and clean consumer installation gates separate.

## Listing declarations
- Price: Free. Intended users: developers/operators authorized to manage their own machines.
- Tools: device, files, process, browser, desktop, batch. Available operations depend on installed providers and local policy.
- First workflow is read-only status/schema discovery. The skill does not automatically install core software, broaden permissions, enable tasks or configure a relay.
- Local agent is final policy authority; background_only and human ownership remain default.
- Full original package license: MIT OR Apache-2.0, at recipient choice; bundle complete license texts and preserve attribution.
- Link the inspected candidate source while the branch is unmerged; do not describe a future main URL as already available.
- Claim successful pinned OpenCode host discovery only. Model invocation, unsupported agent activation, independent consumer installation and four-device authenticated operation remain unverified.
- No guaranteed install time, performance, compatibility, uptime, placement, income or security certification.

## Security and privacy disclosure
The ZIP contains instructions and examples, not executable installers or telemetry. It requests no credentials in chat, adds no analytics and sends no machine data to Agensi. An AI host may send prompts, selected tool results and skill content to that host/model provider under its own policy. Local stdio uses no Tetherplane relay. A remote relay terminating MCP traffic can see requests/results; do not claim end-to-end secrecy. Operators choose infrastructure and least-privilege roots. Remote pairing/authentication remains separate.

Agensi separately collects uploaded package/listing/version data and records agent searches, loads and usage metadata; its platform privacy policy applies independently of the bundle. Do not describe marketplace use as having no platform data collection.

Repository hygiene and high-confidence secret scanning are local checks with limited detection coverage. They are not the Agensi security scan, manual review or a vulnerability-free guarantee. Report findings privately per SECURITY.md without secrets.

## Marketplace review and later approval
Public guide checked October 17, 2026:
- Confirm current creator terms, licensing rights, permitted open-source/free distribution, privacy declarations and account eligibility before submission.
- Public format requires name/description frontmatter and folder name matching name; supporting agents/openai.yaml is optional.
- Creator flow: upload ZIP, choose Free, tags/category and description, then automated security scan and manual review.
- The older creator guide says even free listings require Stripe. Current Terms (updated October 12) explicitly gate paid publication on an enabled payout method; the free-listing requirement is unresolved. Do not configure any payout method during package work.
- Terms section 8.1 retains creator ownership with a nonexclusive platform distribution grant. Sections 5.2/8.2 restrict saving/export/redistribution. Clarify applicability and precedence for this free MIT/Apache package before submission; do not assume compatibility or change the open-source license.
- Complete any dashboard-only fields and media requirements after inspecting the actual form with authorization. Do not invent required screenshots, package limits or approval turnaround promises.
- Obtain explicit approval for the exact ZIP/hash and listing before any submission. Upload only the designated skill ZIP; adjacent operator inventory and verification documents are not part of the marketplace payload. Submission can lead to publication after review; do not use it as a test.
- Keep free GitHub distribution available regardless of marketplace availability.

Sources:
- https://www.agensi.io/terms (updated October 12, 2026)
- https://www.agensi.io/privacy
- https://www.agensi.io/learn/how-to-sell-skills-on-agensi
- https://www.agensi.io/learn/skill-md-format-reference
- https://www.agensi.io/learn/skill-md-creator-checklist
- https://www.agensi.io/learn/how-agensi-security-scan-works

Direct retrieval of the creator checklist and security-scan guide timed out, but their indexed public text was retrieved on October 17 (checklist crawled five days earlier; security guide last month). Recheck the live dashboard before submission. The guidance calls for real skill activation in at least one agent, broader two-agent testing and an independent tester; these remain open quality checks. Structure, secret/network/command/injection screening and manual review are also described. No Agensi scan or review has been run.
