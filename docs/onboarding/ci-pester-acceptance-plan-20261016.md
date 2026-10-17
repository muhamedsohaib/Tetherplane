# Windows CI onboarding acceptance gate — 2026-10-16

Status: planned implementation on isolated branch `fix/relay-chromium-test-concurrency-20261016`.
Baseline: `c28aea7b62739d110d7172e01909c1a93698d9a2`.
Sources of authority: canonical 2026-09-17 design, roadmap and local core; `docs/onboarding/CONTROLLED-ACCEPTANCE.md`.

## Scope and safety
- CI only: make Windows quality job run the existing complete `scripts/run-onboarding-tests.ps1` suite against the Rust release binary built from the same SHA.
- Use existing source and Windows runner; no live local agent, relay, OAuth, user applications, identities or scheduled tasks are changed.
- Preserve exactly six default AI-facing MCP tools and background-only policy.
- No public release, branch merge, Agensi publication, or unapproved foreground test.

## Strict TDD sequence
1. Add test `tests/e2e/ci-onboarding-gate.test.ts` verifying the Windows-only Pester step is located after release-binary build and before package smoke.
2. Execute the single test; require failure because the step is absent.
3. Add minimum Windows-only step to `.github/workflows/ci.yml`: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-onboarding-tests.ps1`.
4. Execute the single test; require success.
5. Run safe local quality checks, review exact staged changes, and commit/push only the feature branch.
6. Wait for GitHub Windows + Ubuntu quality outcomes at the exact SHA; require Pester total 47 passed with zero failed/skip/inconclusive on Windows.
7. Record any failure without bypassing authorization or relaxing tests.

## Exit and unresolved gates
A successful CI result confirms Windows onboarding *automated* acceptance only. It does not prove operator-observed coexistence, new-machine physical installation/pairing, public hosting, or Agensi host activation. Those remain independent NO-GO gates.
