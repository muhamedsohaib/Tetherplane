# Tetherplane Release-Candidate Benchmark

**Measured:** 2026-09-20 (Asia/Dubai)
**Source commit:** `67e017e25c5dd201aeedf5edfbfe75d429c760d7`
**Machine:** Leno
**OS:** Windows `10.0.26200` x64
**CPU:** 11th Gen Intel Core i5-1135G7 @ 2.40 GHz
**Rust:** `rustc 1.98.1 (48a229cea 2026-09-01)`
**Node.js:** `v24.19.0`

These are measured results from one machine, not universal guarantees or marketing targets.

## Local core

Release-profile `tetherd` was measured through `scripts/bench-local.ps1`.

| Metric | Measured value | Original design target | Result |
| --- | ---: | ---: | --- |
| Cold start to first `device.status` | **1,229.56 ms** | <250 ms | missed in this run |
| Idle working set after 10 seconds | **17.44 MiB** (18,288,640 bytes) | <50 MiB | met |
| Default MCP-visible tools | **6** | exactly 6 | invariant met |

The previous historical baseline at `docs/benchmarks/local-core-baseline.md` measured 2,580.35 ms cold start on the same named machine and missed the target. An earlier Plan F run measured 39.57 ms, but the final F8 refresh measured 1,229.56 ms. The startup target therefore remains a measured miss for this release candidate, with substantial run-to-run variance that should be investigated separately rather than hidden.

The measured tool list remained exactly:

`batch`, `browser`, `desktop`, `device`, `files`, `process`.

### Compact response bounds

The 1,000-line UTF-8 fixture produced:

| Response mode | Delivered content | Serialized result | Truncated | Continuation |
| --- | ---: | ---: | --- | --- |
| `compact` | **16,384 bytes** | 16,823 bytes | yes | byte offset 16,384 |
| `normal` | **65,536 bytes** | 66,575 bytes | yes | byte offset 65,536 |
| `debug` | **82,000 bytes** | 83,201 bytes | no | none |

AI-visible round trips remained:

- ordinary shell command: **1**
- three-file parallel batch: **1**

The benchmark metadata correctly reported the Windows UI Automation desktop provider as configured; browser was intentionally not configured for the local-core measurement.

## Browser semantic workflow

`scripts/bench-browser.ts` used an installed `chrome.exe` through the isolated CDP fallback and the deterministic Browser Lab fixture.

| Metric | Measured value |
| --- | ---: |
| Semantic snapshot | **52.95 ms** |
| Verified action | **151.99 ms** |
| Total two-call workflow | **204.94 ms** |
| AI-visible round trips from unknown initial state | **2** |
| Verification | **verified** |

The browser benchmark used a Tetherplane-owned isolated browser context. It did not require control of a human-owned tab.

## Windows desktop semantic workflow

`scripts/bench-desktop.ps1` used release `tetherd`, Compact MCP, Windows UI Automation, and the deterministic owned desktop fixture.

| Metric | Measured value |
| --- | ---: |
| Semantic snapshot | **1,585.23 ms** |
| Value set | **35.43 ms** |
| Invoke | **31.48 ms** |
| Selection | **33.01 ms** |
| Total four calls | **1,685.15 ms** |

The benchmark observed 13 fixture semantic nodes, classified the fixture as Tetherplane-owned, verified the resulting fixture state, and asserted that the physical cursor position was unchanged across semantic operations.

## Reproduction

Windows local-core:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-local.ps1

Windows desktop:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-desktop.ps1

Browser benchmark after workspace build:

    node scripts/bench-browser.ts

Benchmark values can vary with machine load, filesystem cache, antivirus activity, browser startup state, and operating-system scheduling. CI should enforce deterministic invariants such as tool count, safety boundaries, and response caps rather than these machine-specific latency numbers.
