# Tetherplane Open-Source Distribution and Commercial Services — Design

**Date:** 2026-10-14
**Status:** Written architecture for user review; the free-core / paid-convenience direction was approved in conversation.
**Architecture type:** Distribution and business-model decision, not a change to the capability kernel.
**Feature branch:** `feature/open-source-commercial-model-20261014`

## 1. Decision and desired outcome

**Keep Tetherplane genuinely open source and useful without payment. Earn revenue by saving customers time, providing tested workflows, managing complexity, and supporting production deployments.**

The project must optimize for the greatest responsible adoption, not deliberately weaken its free edition or rely on preventing capable developers from reproducing its source code. A technically competent developer must be able to self-host and run Tetherplane without buying any additional product.

Three distinct offerings share a common control plane:

1. **Tetherplane Core (free/open source):** Full self-hostable kernel, providers, adapters, browser/desktop functionality, local policy and security mechanisms, six-tool Compact MCP interface, authenticated relay and community documentation.
2. **Tetherplane Skills (free starter plus optional paid specialist packages):** A free, official, agent-neutral starter skill. Distinct optional paid skills supply validated outcome-oriented workflows and documentation that reduce setup, diagnosis and maintenance work; paid products are not mere wrappers around the free skill.
3. **Tetherplane Managed (future optional service):** Operator-assisted setup and support, and potentially hosted relay/service management, subscriptions, service commitments and enterprise integration when demand and safety evidence justify them.

No marketplace, payment wall, subscription enforcement or central account dependency is added to the self-hosted core. The commercial layers are optional and operate through existing authorized capabilities.

## 2. Non-negotiable canonical architecture

Preserve the design and plans in:
- `docs/superpowers/specs/2026-09-17-tetherplane-design.md`
- `docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md`
- `docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md`

The Capability Kernel, Providers, Adapters, Transport and Policy Broker remain separate. The model-visible default MCP surface remains exactly `device`, `files`, `process`, `browser`, `desktop`, `batch`. Agent-specific skills instruct a client how to use supported operations; they **do not** introduce provider-specific canonical capability names or bypass the local Policy Broker.

The human always has precedence. Default `background_only`; no focus stealing, physical cursor movement, clipboard override, control of human tabs or destructive side effects without the appropriate scoped approvals and ownership guarantees. Existing foreground lease and verified browser-action requirements apply equally to both free and paid workflows.

Local-only functionality, the self-hosted relay and secure basic connectivity must remain fully functional when Agensi, a payment provider or Tetherplane Managed is unavailable.

## 3. Licensing, rights and brand boundaries

**Continue `MIT OR Apache-2.0` for the existing and future open-source Tetherplane Core.** Neither the kernel nor existing open-source providers/adapters is switched to a non-commercial license by this design. This supersedes the previously contemplated restriction to free personal use only.

Clearly disclose that MIT/Apache recipients may use, modify, fork and commercialize the core under the applicable terms. Do not promise exclusivity, prohibit lawful forks of already released code, or suggest that paying for an official skill is required for commercial use of the core.

The public repository retains `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`, the `Cargo.toml` workspace SPDX expression and legally required attribution and dependency notices. Source and release artifacts must agree. Third-party source/dependencies and existing contributions must be audited before introducing or dual-licensing *separate paid materials*. Any future contributors receive ordinary open-source contribution treatment under documented policy; contributor code is not automatically relicensed into proprietary packages without the necessary rights.

Commercial skill contents, hosting services, support contracts and trademarks can use separate appropriate agreements. Their legal rights and attribution must be clearly documented and reviewed before marketplace publishing. An official Tetherplane trademark/branding policy may distinguish endorsed offerings from forks, but cannot rescind grants already conveyed under open-source licenses.

## 4. Free official starter skill

**Name:** `Tetherplane — Official Starter` (working title, subject to marketplace naming rules).

The free starter should:
- Explain supported machine/OS prerequisites, installation and local/remote deployment options.
- Discover Tetherplane's six default MCP tools and progressive disclosure help without assuming more tools exist.
- Guide credential-safe pairing, least-privilege roots, consent, and safe policy defaults; never request, echo or transmit a user's credentials to Agensi or a skill author.
- Demonstrate a small **read-only** `device.status` path and one approved local-file or process example without changing human-owned resources.
- Offer explicit troubleshooting for `permission_denied`, `capability_unavailable`, device offline, auth mismatch and absent relay, without unsafe permission escalation.
- State clearly when the integration has only passed simulated fixtures versus verified installs, and publish tested supported clients/platforms rather than claiming unverified 20+ integrations.
- Live in version control with source, tests and changelog, available independently of the marketplace, with installation instructions an ordinary developer can follow for free.

**Distribution:** GitHub (canonical) and, after verification and explicit user approval, a free official listing on Agensi. A listing does not imply a formal paid endorsement by Agensi. Use Agensi's real documented skill schema and publishing conditions only after inspection; do not guess a package format.

**Success gate:** An independent user can go from documentation to a running local six-tool MCP connection with minimal setup, and can safely perform the tested status operation. Real installer/connection time and failure rates must be measured before marketing specific speed claims.

## 5. Optional paid skill: a distinct product

**First candidate:** `Tetherplane Multi-Device Operations Pro` (working title).

The first paid package must provide outcomes beyond the free starter, for example:
- Versioned, tested workflows for coordinating several authenticated devices.
- Verified file transfer and state-aware cross-device jobs.
- Reconnect/checkpoint/idempotency orchestration and explicit failure recovery guidance.
- Ready-made reusable scenarios, test fixtures, focused documentation and ongoing compatibility updates.
- High-quality examples that avoid foreground disruption, require per-device permissions and respect ownership.

The proposed workflows must actually exist and pass acceptance tests before any paid listing. The package cannot promise remote features merely because an agent has an established TCP connection; authenticated read-only remote invocation must be proven.

**Commercial boundary:** Paid skill logic may be delivered as a standalone documented skill package. It does not replace missing core capability, hide indispensable security controls or require DRM in `tetherd`. A plaintext skill can be studied or imitated; value comes from support, rigor, speed, updates and usability, not an unbreakable secret.

**Pricing:** Validate a small one-time price first (a previously discussed illustrative price was USD 29, not an approved or committed listing price). A subscription must correspond to meaningful continuing delivery (updates, maintained integrations, support or managed operations), not an arbitrary access fee.

**Entitlement:** Marketplace payment and delivery are handled through the verified platform distribution mechanism for the paid package; Tetherplane Core must not phone home to check purchase state. No bundled API keys or machine credentials in paid downloads.

## 6. Agensi relationship and distribution boundaries

User-confirmed email exchange with Joeri Brons (October 12–13, 2026) describes an offer of:
- Non-exclusive skill listing at no upfront listing charge.
- Creator-selected prices with a stated 70% creator / 30% marketplace revenue split.
- Marketplace discovery and a creator dashboard.
- Performance/community-driven featured placement, not guaranteed promotion.

These are **statements in correspondence**, not guaranteed revenue, a signed partnership, exclusive distribution or independently audited traffic. A claimed approximately 65,000 monthly visitors does not establish likely Tetherplane purchases.

Before a listing is published or priced, confirm current marketplace terms on ownership, permitted licensing, paid skill originality, fees/refunds/taxes, payout eligibility, geographic/payment restrictions, security review and what "70%" is calculated from. Review changes with the user; never authorize the commercial listing, share payment information or externally message Joeri without explicit approval.

Keep the free skill available on GitHub even if Agensi removes its listing. Do not grant exclusive control over the Tetherplane core, GitHub repository or trademarks to a marketplace.

## 7. Managed Tetherplane — optional later subsystem

Managed services are **not** a prerequisite for community adoption or the free skill release. Defer implementation until actual usage and support demand can be demonstrated.

Possible future paid service components:
- Setup/onboarding and installation support.
- Hosting, upgrading, monitoring and recovering an authenticated relay for customers.
- Team operational policies, device fleet onboarding, lifecycle support and scoped enterprise connectors.
- Optional support contracts with clearly stated service hours and incident handling.

Do not promise an SLA, 24/7 availability, unattended recovery or regulatory certification before evidence supports it. If hosting, explain in clear terms that the relay terminating MCP traffic can see request/result payloads as stated in the canonical design. No misleading "end-to-end encrypted, zero knowledge" marketing.

A managed operator must never be able to override the local device's policy or an unexpired foreground lease. Tenant isolation, least privilege, auditable administration, data deletion, transparent billing, incident response and explicit consent are mandatory before handling customer devices.

Commercial service customers may use the free core without subscribing. Cancellation must never disable their self-hosted copy.

## 8. Distribution architecture

```
                     GitHub (free, open source)
                 Tetherplane Core + full self-host path
                                  |
                +-----------------+--------------------+
                |                                      |
      Free Official Starter Skill             Community docs and tests
      GitHub + optional Agensi listing               (always free)
                |
           Real adoption data
                |
          +-----+-------------------------+
          |                               |
    Paid Specialist Skills       Optional Managed Services
    (distinct workflows)         (onboarding/hosting/support)
    Agensi + other channels       Direct commercial agreement
```

Each path consumes provider-neutral Tetherplane operations. The Agensi-specific adapter is distribution/instructions only; it must not import marketplace policy into `tether-core`, providers or the local policy broker. No tracking of user operations to calculate skill revenue.

**Minimal first integration:** avoid creating a full payments platform, organization billing backend, proprietary fork, plugin marketplace, new host authorization server or telemetry infrastructure.

## 9. Metrics and privacy

Success should be tied to user outcomes, not GitHub stars alone:
- Verified install completion and time to first successful local `device.status`.
- Separately verified first authenticated remote `device` operation.
- Agent/client compatibility and first-week trouble reports.
- Free listing views/installations when Agensi legitimately provides them.
- Qualitative demand for the proposed advanced workflow.
- Paid conversion, refunds and time spent supporting each paying customer, once real transactions exist.

Do not embed analytics SDKs into the core or collect command payloads, file paths, machine identifiers, prompt text or personal device data for marketing. Marketplace analytics must be used only as disclosed and permitted by its terms. Any optional product analytics require privacy review and informed opt-in; self-hosted core remains usable with zero telemetry.

## 10. Engineering sequencing and release gates

**Prerequisite, in progress:** Finish previously approved live connector/auth routing validation, recoverability/security, native Windows tray presence and repository CI hardening. Related approved plans live on `feature/windows-tray-presence-design-20261014`; do not claim they are merged or completed.

**Track A — Free official integration (first commercial-distribution deliverable):**
1. Verify current repository and commit; create isolated feature branch.
2. Write a focused starter-skill implementation plan after this architecture is reviewed.
3. Confirm actual Agensi packaging specification and supported host clients from live documentation.
4. Write failing acceptance tests for six-tool help/discovery, read-only proof, denied operations, offline errors, credential redaction, legacy-client handling and clear installation support.
5. Implement the minimal free agent-neutral skill and install/readme files; run actual fixture and Windows smoke tests.
6. Obtain a verified four-device authenticated test where feasible. Publish only supported capability claims.
7. Submit the free Agensi listing only with explicit user approval; record its actual public URL and creator-dashboard evidence.

**Track B — Pro workflow (only after A verifies):**
1. Select one workflow users repeatedly request and verify underlying core support.
2. Create separate, scoped design/spec and implementation plan for this product.
3. Prove repeatable value and safety across supported clients; package using actual marketplace constraints.
4. Ask the user to approve distinct pricing, licenses, customer support/updates and publication.

**Track C — Managed service (only after evidenced demand):**
1. Gather non-sensitive support burden and deployment evidence.
2. Write separate multi-tenant/privacy/security operational spec and threat model.
3. Resolve production hosting, consent, billing, support and incident response requirements.
4. Pilot in a test tenant with explicit operator authorization; never silently migrate existing device credentials.

**Repository release:**
- Remains a separately approved process requiring fresh CI across OSes, security and package checks, license notices, real RPC and human-coexistence evidence; no new public release/tag on documentation approval alone.
- GitHub core binaries remain free; paid offerings do not weaken the core.
- Avoid release promises before current Windows/Linux Clippy and unattended-startup issues are resolved.

## 11. Verification and decision records

Before implementation, verify a single coherent interpretation of:
- Free core permissive MIT OR Apache-2.0, commercial forks legally allowed.
- Free official skill with source-controlled installation and no dependency on buying anything.
- Paid skill as a separate, demonstrably original, tested convenience product.
- Managed services as a future optional service, not a mandatory remote relay.
- Existing Tetherplane safety/architecture constraints unchanged.
- No new marketplace listing, outbound communication or transaction without explicit approval.

Design-review exit: user approves this written spec. Only then author and review a focused implementation plan for **Track A**. Treat Tracks B and C as separate product projects, not implied approvals to build cloud billing, collect telemetry or publish paid products.

## 12. Known uncertainties

- Agensi's precise current skill artifact format, integration-install flow, marketplace review criteria and payout/tax rules must be checked before implementation/publishing.
- Revenue share, claimed reach and discovery mechanics are reported by the partner, not independently audited.
- The first paid workflow, price and update/support obligations are proposals; demand and tested core support are not yet proven.
- Managed hosting needs additional architecture, security and legal review before any customer's machine is connected.
