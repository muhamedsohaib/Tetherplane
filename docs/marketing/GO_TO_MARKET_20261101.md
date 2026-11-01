# Tetherplane — open-source go-to-market experiment (working draft, 2026-11-01)

> **Status:** Positioning and revenue hypotheses, **not validated demand or customer traction**. No publication/outreach authorized. Keep open-source MIT OR Apache-2.0 code openly usable; sell optional value, not a misleading promise of exclusive access.

## Most expensive narrowly addressable problem

AI coding agents frequently propose commands that pass inside a model's sandbox but fail on a developer's **actual Windows machine**. Manual copy/paste, incomplete context, terminal focus theft, broken remote connections, weak authorization boundaries and repeated setup cycles consume operator time.

**Proposed wedge:** Give a model-neutral assistant an authenticated, locally constrained path to run and verify actions on a *real, owner-approved computer*, without interrupting the human's desktop.

**Evidence-backed today:** exactly six default MCP tools; Leno authenticated/ready; desktop background policy; non-PTY Windows child-process no-console proof; local authorization can deny out-of-scope operations. **Not yet available as a general claim:** browser availability, repeatable new-device setup, reliable four-device connection, clean-install signing acceptance, or zero failures.

## Recommended path — proof before scale

| Rank | Channel | Why it fits | Prerequisite | Action |
|---|---|---|---|---|
| 1 | **GitHub repository + two-minute real Windows demo** | Developers can audit code and reproduce tests; immediate intent and no store gate | Clear README, signed/verified download path, honest limitations, permissions/rollback docs | Show one command that works on the real owner machine without flashing a terminal, then an unauthorized request denied |
| 2 | **5–10 developer/operator design partners** (warm dev community participation first) | Directly tests painful setup and reliability; cheaper learning than broad launch | Safe owner-consented beta, isolated test machine, no credentials or destructive actions | Offer supervised install/feedback session; capture failures without harvesting secrets |
| 3 | **Official MCP Registry** | Indexes MCP servers for clients and discovery; supports GitHub-verified namespace and HTTPS icons | Registry-compliant `server.json`, stable deployable package/remote URL, approved logo bytes | Publish only after private acceptance; avoid duplicate or false version labels |
| 4 | **Show HN, relevant technical subreddits/Discord, Product Hunt** | Useful for peer review and distribution of an honest, reproducible demo | Enough confidence for strangers to reproduce a clean install; polished, accurate demo | Submit by genuine participation, answer technical criticism, avoid unsolicited spam |
| 5 | **WinGet community catalog** | Natural Windows CLI installer distribution without relying on Microsoft Store | Real signed/trustworthy .exe/MSI/MSIX installer, clean uninstall, silent install, hashes | Submit manifest later; community repo does not accept script-only installers |

References: [MCP Registry](https://github.com/modelcontextprotocol/registry), [Windows Package Manager policy](https://github.com/microsoft/winget-pkgs), [Product Hunt launch guide](https://help.producthunt.com/en/articles/17350772-launch-guide), [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins).

## Actual positioning / copy

**One sentence:** *Let AI agents work on your real computer—without taking over your screen or bypassing your permissions.*

**20-second developer pitch:** *I built Tetherplane because I was tired of pasting commands that AI said were tested, then debugging them on my own Windows laptop. It gives an AI assistant a small, model-neutral MCP interface to an authorized real computer. Local policy controls what it can touch, and background actions are designed not to hijack the human's session. I've independently tested the latest no-console Windows path on my machine; I'm recruiting a few developers to stress-test clean installation and reconnection before calling it production-ready.*

**60-second live demonstration:** (1) Show the developer actively using their Windows desktop, with no staged terminal focus change; (2) an authenticated Tetherplane tool call runs a read-only command and returns its actual output; (3) another read-only command confirms the child has no console window; (4) an unauthorized operation returns a clear denial; (5) show exactly one agent, the source commit, and where the local policy is enforced. No browser claim unless restored and independently accepted.

**Do not claim:** `100% reliable`, `never interrupts anything`, `signed`, `available on all four devices`, `better/faster than every competitor`, or `production-proven` without corresponding independent evidence.

## Open source + paid service hypotheses

- **Free core:** six-tool local control plane and self-hosted/manual installation, source and safety docs, broad technical adoption.
- **Near-term paid value hypothesis:** hands-on installation, device pairing, scope policy setup, update/rollback support, verified connection health and audit logging for a small development team. Only offer what is already operational.
- **Possible later recurring offering (not yet authorized to build):** managed relay and fleet onboarding/monitoring under clear consent and separation-of-duty constraints; no claim that the existing open source repo creates proprietary lock-in.

**Price discovery, not a price announcement:** test an optional assisted setup at **USD 199** and post-acceptance support around **USD 49–99/month** with 3–5 eligible design partners, only after service scope, response expectations, costs and liability are stated. Ask what the operator currently spends in hours and whether those prices are defensible. Reject unsupported numbers. Calculate contribution margin = collected fees − support time × loaded hourly cost − infrastructure/payment costs − estimated incident burden.

## Minimal validation funnel

Over an owner-approved 14-day beta:

1. **5 external authorized Windows installs** from a documented, integrity-verified package. Observe actual time-to-first-authenticated tool call; working target **≤10 minutes** as an aspiration, not existing performance.
2. Run a standardized operator-led logon/restart, disconnection/reconnect and negative-scope trial. Target **0 unauthorized successes**, **0 unrequested foreground windows**, and record every failure, rollback and recovery time.
3. Obtain explicit feedback from at least **3 external developers** and ask a willingness-to-pay question tied to saved support hours. Aim for **2 genuine paid-pilot indications** before investing in managed-hosted features.
4. Track GitHub stars and registry referrals only as distribution signals; measure activated devices, repeat usage and support burden as the real adoption metrics.

**Stop and fix onboarding** if clean install or rollback remains brittle. A passing synthetic CI test alone is not an acquisition-worthy product.

## Opportunity compounding — first reachable move

**Current door:** A public GitHub repository, an actual Windows no-console repair, and access to developer communities from existing open-source contribution activity. This is not proof of a customer relationship.

**Adjacent door:** Offer one authorized developer a **10-minute screen-shared setup test** and a useful reproducibility/permissions checklist.

**Compounding benefit (hypothesis):** One consented case study + installation friction metrics → a stronger GitHub demo and credible MCP Registry submission → a paid onboarding/support pilot.

**Value-first ask:** *"Would you try installing an open-source AI-to-Windows connector on a spare machine while I observe? I'll give you an installation and rollback checklist, and I'll fix the first failure you hit. No credentials or remote control without your approval."*

Do not send any communications without the owner's explicit approval.
