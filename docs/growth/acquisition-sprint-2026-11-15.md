# Tetherplane acquisition baseline and qualified-adoption sprint
**Evidence cut:** 2026-11-15 UTC. **Scope:** acquisition, documentation, discoverability, external evaluation. **Not a public-release authorization.**

## Verified baseline (point-in-time)

| Signal | Observation | Evidence | Interpretation |
| --- | --- | --- | --- |
| Repository | Public; **1 star, 0 forks** in GitHub API at the evidence cut | [Tetherplane repository](https://github.com/muhamedsohaib/Tetherplane) | Early public attention, **not** an install count |
| GitHub metadata | Relevant topics already include MCP, computer-use, browser/desktop automation and self-hosting | [Repo About](https://github.com/muhamedsohaib/Tetherplane) | Topic stuffing is not the bottleneck |
| Web entry point | [Public landing page](https://tetherplane.netlify.app/) with GitHub links and assisted-setup inquiry | Live HTTP/HTML inspection | A visit or form view is not an activated user |
| Google homepage | `https://tetherplane.netlify.app/` shown as indexed in owner's Search Console on 2026-11-15 | Owner-supplied inspection | Eligibility; no verified position or traffic volume |
| Google sitemap | 200 OK; exactly `/` and `/privacy` | [Live sitemap](https://tetherplane.netlify.app/sitemap.xml) | 2 discovered URLs, not 2 indexed URLs |
| Privacy page | Discovered, not indexed; live test said eligible; manual request temporarily quota-limited | Owner-supplied inspection | No evidence of a technical block |
| Windows onboarding | [PR #135](https://github.com/muhamedsohaib/Tetherplane/pull/135) is draft; unsigned clean-host acceptance pending | [README](../../README.md), [acceptance](../live-acceptance.md) | **No broad Windows install promotion** |
| Netlify form inquiry submissions | **2** (2026-11-12/13 UTC), both self-described synthetic QA acceptance tests | Connected Netlify Forms intake readback on 2026-11-15 | **0 qualified customer requests among these two**; do not count as prospects |
| Edge HTTP requests (sampled 2026-11-14 19:00 UTC to 2026-11-15 18:40 UTC) | **21** requests, including **3** homepage requests; user-agent categories: 6 tooling, 5 browser, 5 other, 3 crawler, 2 AI-agent | Connected Netlify observability counts and top URLs | **Not 21 visitors**, and not 3 human visitors |
| Independent external activation, leads from other channels, retained users, Google clicks | **Unknown** | No attributable cross-channel dataset supplied | Do not convert unknown to zero or claim traction |

The only verified site pages at this cut are the homepage and privacy page. Google Search Console and GitHub metrics have different grains and cannot be added together.

**Attribution caution:** Two form test records do not represent a failed conversion campaign, and the HTTP-traffic sample is contaminated by crawler/tool probes (including our own verification). We did not inspect unrelated private contact channels. Treat this as a small, incomplete baseline.

## Focus: a small, qualified evaluation cohort before broad launch

**Primary audience hypothesis:** Windows automation/MCP developers evaluating local owner-control, safe remote access, human-coexistence and auditable denial behavior. Their main likely objections: unclear first-use setup, unsigned binaries, trust/authentication and whether claims are reproducible.

**Offer for now:** open-source technical evaluation, code review and carefully authorized private-beta discussion. **Not:** a one-click publicly supported product, unsigned-download drive, zero-risk computer control, or a proven commercial service.

**Candidate positioning:** "Run AI computer workflows only on devices their owners authorize; local policy, explicit grants, and background-first operation." Validate against real feedback rather than declare product-market fit.

### Proposed acquisition sequence

| Stage | Conversion we should earn | Evidence required | Next intervention |
| --- | --- | --- | --- |
| Discovered | Target developer finds website, GitHub, or a legitimate reference | Verified Search Console query/click, referral, or self-report | Plain-language, problem-led content; relevant technical references |
| Evaluated | Developer reads architecture and can identify safe scope | Repo docs entry/click or opted-in reviewer feedback | [Developer evaluation path](../evaluate-tetherplane.md) |
| First safe proof | An **authorized** developer completes one tested workflow | Device/OS/source SHA, expected vs observed permitted action and denial | Reduce one specific failed setup step |
| Trust proved | Owner sees revocation, recovery and no human disruption | Operator-observed acceptance artifact | Consider public release readiness *only after release gates* |
| Repeat use | A different, consented workflow is performed later | Opt-in follow-up or privacy-preserving install cohort count | Work on real reliability/burden rather than promotional volume |
| Qualified commercial lead | Buyer explicitly describes a painful workflow, budget owner and permission structure | Dated, consented discovery notes | Small controlled pilot, then validated unit economics |

### Hypotheses to test (not forecasts)

- **14-day target:** 10 genuinely relevant developer evaluations of documentation/code, including at least 3 who attempt a safe local source build, subject to qualified opt-in.
- **Quality threshold:** 3 useful *independent* first-run friction reports or security/permission critiques; no secrets or personal device data.
- **Activation gate:** At least 1 outside-operator **explicitly authorized** first-use run with permitted action, denied action, revocation and recovery demonstrated before expanding installation promotion.
- If the cohort does not emerge, do not fabricate a funnel. Record **zero verified opt-ins** only after checking the intake records; otherwise mark unknown.

### Channels — ranked by fit and readiness, not alleged total users

1. **GitHub repository and organic search (now):** improve exact problem-to-docs route; keep honest README, source, acceptance, and security links. No star/fork solicitation.
2. **Technical review from consenting peers (now, owner-approved contact only):** one security-conscious MCP/Windows automation developer at a time; invite criticism of one reproducible test, not generic praise.
3. **Official MCP Registry and aggregators (conditional):** verify a supported publicly available install package or actual accessible remote MCP endpoint and package ownership. Prepare metadata but **do not publish** while release eligibility is unresolved. See [directory gates](directory-publication-gates.md).
4. **Glama and other maintained directories (conditional):** use primary listing rules; avoid duplicate spam, false certification and treating catalog presence as working auth.
5. **Show HN or similarly technical launch (after a usable independent demo):** follow [official Show HN guidelines](https://news.ycombinator.com/showhn.html); waitlist/marketing-only pages do not qualify. Author writes the post personally; do not auto-post or manufacture votes.
6. **Community technical case studies:** publish exact tests, limitations and failure/repair evidence when the owner explicitly approves; no mass DMs or automated comment promotion.

### Measurement contract

Gather only data you can legitimately access. Avoid new tracking or behavioral identifiers without reviewing privacy implications.

| Metric | Grain / definition | Source | Cadence |
| --- | --- | --- | --- |
| Branded/non-branded organic clicks & queries | Search Console *web property* impressions/clicks; distinguish country, page and branded query | Google Search Console | Weekly once data arrives |
| Repo discovery | Unique GitHub visitors, clones, stars/forks; **proxies only** | GitHub Insights Traffic + repository API | Weekly; note GitHub traffic retention |
| Developer interest | Opt-in valid request from distinct developer; no assumed consent | Existing form or manually maintained owner-approved register | Per request |
| Safe first activation | One consented machine + source revision + permitted/denied test + observed result | Approved testing evidence | Per session |
| Recovery success | Revocation, restart, reconnection and no disruption actually observed | Acceptance evidence | Per release candidate |
| Conversion | `verified_first_activations / qualified_opt_in_evaluators`; report both denominator and exclusion reasons | Reconciled owner records | Weekly |
| Cost | Actual acquisition expense, owner/operator time and authorized pilot delivery effort | Receipts and time log | Weekly |

A GitHub star, release download, sitemap discovery, GitHub traffic clone or page view is **not** a device activation.

## Guardrails

- Keep current Tetherplane engineering PRs and runtime untouched; do all acquisition copy on a separate docs branch.
- No live installation promise while beta remains unsigned/unaccepted; never bypass security controls.
- Don't publish registry listings, HN posts, videos, community messages, press releases or email from the owner's accounts without **specific approval**.
- Don't activate analytics/trackers, add external integrations, spend funds, merge to protected main, tag releases, or deploy production without approval.
- Never expose device credentials, bearer tokens, private demo telemetry or real user data.
- Track the actual next blocker, not growth activity disguised as proof.

## Immediate decision rule

**Do not scale pageviews before proving a safe repeatable first-use experience.** If evaluation interest is low, fix the problem framing; if evaluation is high but first-use fails, fix installation and security ergonomics; if first-use succeeds but repeat use does not, investigate real task value. Reassess using evidence after each cohort.
