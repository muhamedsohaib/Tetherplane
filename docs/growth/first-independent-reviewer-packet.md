# First independent reviewer packet (no installation required)

**Status:** draft for owner review, 2026-11-15. This is a **source/documentation review** protocol, not third-party device acceptance, a signed beta or an approved outreach campaign.

## Why a developer should care

Tetherplane explores a narrowly defined problem: letting an MCP-compatible AI client operate a computer that its owner has explicitly authorized while keeping local capability restrictions and human-owned sessions protected.

**Review hypothesis:** The architecture might reduce risk and interference for developers who want background-first Windows AI workflows. Claims should be judged against actual code, permission boundaries and device-level evidence rather than branding.

- Canonical source: https://github.com/muhamedsohaib/Tetherplane
- Review PR: https://github.com/muhamedsohaib/Tetherplane/pull/146
- Threat model: https://github.com/muhamedsohaib/Tetherplane/blob/main/docs/security/threat-model.md
- Security reporting: https://github.com/muhamedsohaib/Tetherplane/blob/main/SECURITY.md
- Draft evaluator guide: https://github.com/muhamedsohaib/Tetherplane/blob/docs/acquisition-funnel-20261115/docs/evaluate-tetherplane.md

The current three-step Windows beta (PR #135) is unsigned and still needs clean-host acceptance. **Do not recommend downloading/running it on an everyday device or disabling security features.**

## Fifteen-minute, no-installation reviewer test

1. **3 minutes — Problem framing:** Read the README introduction and evaluator guide. In one sentence, explain when you would choose Tetherplane over ordinary remote desktop or running a script yourself. If that value is unclear, report that explicitly.
2. **5 minutes — Trust boundary:** Examine the threat model and answer where device-level policy is enforced, and which operation a paired MCP client is *not* automatically allowed to perform.
3. **4 minutes — First-use clarity:** Without installing anything, follow the documented sequence mentally or in an isolated disposable development environment. Identify the earliest point where a new evaluator would be uncertain, require undocumented knowledge, or need elevated permissions.
4. **3 minutes — Evidence standard:** Identify one concrete permitted action, one expected denial and one recovery condition that would convince you the product is safer or less disruptive than alternatives.

**Successful review:** At least one specific, reproducible critique or a clearly supported statement that the docs explain the trust boundary and first action. “Looks cool” or a star is not acceptance.

## Optional later supervised installation test

**Not authorized by this packet.** Only after the installer package has passed the documented signing/security and clean-host gates, and only on a consenting, non-sensitive device:

- Record exact artifact hash, source SHA, Windows version, MCP host and isolation boundary.
- Confirm explicit owner pairing and selected, least-privilege test-only allowed root.
- Verify permitted `device.status` and one non-sensitive allowed action. Confirm one out-of-root or ungranted action is denied; do **not** attempt to read secrets.
- With owner present, verify revocation, restart/reconnection, recovery after interruption, and that human cursor/keyboard/clipboard and browser tabs were not disrupted.
- If any prerequisite or consent is absent, **stop**. Never bypass antivirus, SmartScreen, Smart App Control or authentication.

## Feedback card (no personal information required)

```text
Review date (UTC):
Review type: Documentation only / Isolated development build / Owner-observed first use
Exact commit or PR:
OS / MCP client (if tested, coarse version only):
Problem Tetherplane would solve for me:
First unclear or broken step:
Expected behavior:
Observed behavior (if executed):
Security concern / required permission:
Test result: pass / fail / blocked / not attempted
Would I evaluate it again? yes / no / conditional
One suggested improvement:
I confirm no credentials, customer data, personal hostnames or sensitive logs are included: yes / no
```

Owner reviews feedback before any public posting. Security disclosures use [SECURITY.md](https://github.com/muhamedsohaib/Tetherplane/blob/main/SECURITY.md), not public issues.

## Draft personal invitation — **not sent**

> I'm working on Tetherplane, an open-source MCP control plane for owner-authorized Windows computer use. The newest installer is **not ready for public testing**, so I am looking for a **15-minute no-install review** of the architecture and the safe developer onboarding guide. Could you identify one concrete permission/security weakness or one step where a new developer would get stuck? The code and documents are public; you need not share any personal device information. I'm specifically looking for critical feedback, not endorsements or stars.

One-to-one, consent-respecting outreach only after specific owner approval. Do not send bulk DMs, comment spam or a disguised promotional pitch.

## Evaluation decisions after 5 real reviews

- **Value unclear in 3+ reviews:** refine the problem statement and audience, not the deployment stack.
- **Docs unclear in 3+ reviews:** fix the first-time guide; retest with people who haven't seen it.
- **Trust concerns recur:** update the threat model and acceptance evidence before onboarding expansion.
- **Five strong reviews but no install attempts:** recheck installer risk and user intent; don't claim activation.
- **Any unsolicited sensitive logs:** do not republish or ingest into the repository; securely minimize and request sanitized reproduction.

This packet is a proposed validation tool, not proof that reviewers have been recruited or an external trial has passed.
