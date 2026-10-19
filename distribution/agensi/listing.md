# tetherplane — Agensi creator listing draft

**Name:** tetherplane

**One-line summary:** Securely operate your own paired computers through a policy-gated, six-tool MCP control plane.

**Description:** tetherplane helps connected AI agents inspect device status, work with files and owned processes, and execute verified browser and desktop workflows without taking over the human user's session. Device-local permissions, pairing, resource ownership and explicit approval remain authoritative. This Agensi package is an instruction skill, not a device installer or hosting service.

**Categories (proposed):** AI Agents & LLM Ops; DevOps & Deployment; Productivity.

**Tags:** MCP, Windows, AI agents, computer automation, safety, accessibility, background automation.

**Compatibility:** Agents with SKILL.md support and an independently configured, authenticated tetherplane MCP connection exposing six tools. No claim of automatic availability in every Agensi client.

**Required permissions:** Tetherplane's six MCP tools only as enabled by the client. Actual local read/write/foreground permissions are denied unless the user's on-device policy grants them. Network host is whichever authorized tetherplane MCP endpoint the user configures; do not publish the private development relay.

**Price:** Not set. Creator decides free or paid after review.

**Use cases:** Check the actual health of paired devices; inspect an allowed file; gather semantic browser state from a tetherplane-owned context; run a policy-checked batch and verify the outcome.

**Limitations:** The skill does not install an agent, enroll a new computer, grant permissions or provide cloud hosting. Operating the MCP requires prior device pairing and an existing reachable authenticated relay. Windows Store certification and signed public Windows installer are separate pending work.

**FAQs:**
- Is this a Windows executable? No. It is a SKILL.md guidance bundle.
- Does downloading grant computer access? No. A user-owned device must be independently installed, paired, and authorized.
- Does tetherplane take over my mouse? Not in default `background_only` mode.
- Does the skill contain credentials? No.
- What if the policy denies an action? The agent stops and reports the denial.

**Assets:** Use only the owner's two original uploaded logos; obtain explicit authorization before adding or altering any graphical asset. Supply logo separately through the creator dashboard.

**Review checklist:** Upload the validated `skill.zip` from the canonical build, review required tools/host scopes, inspect Agensi's eight security checks, approve listing metadata and price, and stop before Submit for Review without separate explicit publication approval.

**Canonical source:** https://github.com/muhamedsohaib/Tetherplane
**Agensi requirements:** https://www.agensi.io/learn/how-to-sell-skills-on-agensi
