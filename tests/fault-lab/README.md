# Fault lab (Linux simulation)

Isolated, reproducible reliability experiments. See [FAULT_INJECTION_MATRIX.md](/workspaces/Tetherplane/docs/FAULT_INJECTION_MATRIX.md) for the 12-row matrix and oracles.

Run the quick proof (existing router/auth oracles, timed):

```
node tests/fault-lab/run.mjs
```

Release gate: `node tests/fault-lab/run.mjs --seeds 20` plus the seeded suites. Output is written to `results.json` with per-row status and milliseconds. Rows 2 (half-open) and 9 (truthful readiness) are reported `known-fail-on-main` until Spark S1–S3 land — the lab must expose those gaps, never hide them.

Rules: temp dirs only; no live device, production relay, or real user state; ground truth is counters/file bytes, not API claims. Linux results never certify Windows lock/sleep/foreground behavior.
