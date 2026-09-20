# Tetherplane Release-Candidate Benchmark

**Measured:** 2026-09-20 (Asia/Dubai)
**Source commit:** `7cf9c8164887abc35ce19b7b6a26be67ea79a544`
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
| Cold start to first `device.status` | **39.57 ms** | <250 ms | met in this run |
| Idle working set after 10 seconds | **11.94 MiB** (12,521,472 bytes) | <50 MiB | met |
| Default MCP-visible tools | **6** | exactly 6 | invariant met |

The previous historical baseline at `docs/benchmarks/local-core-baseline.md` measured 2,580.35 ms cold start on the same named machine and missed the target. That historical result remains valid evidence. The fresh 39.57 ms result shows that the miss was not reproduced on the current release candidate; it does not establish a cross-machine startup guarantee.

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
| Semantic snapshot | **28.86 ms** |
| Verified action | **89.08 ms** |
| Total two-call workflow | **117.94 ms** |
| AI-visible round trips from unknown initial state | **2** |
| Verification | **verified** |

The browser benchmark used a Tetherplane-owned isolated browser context. It did not require control of a human-owned tab.

## Windows desktop semantic workflow

`scripts/bench-desktop.ps1` used release `tetherd`, Compact MCP, Windows UI Automation, and the deterministic owned desktop fixture.

| Metric | Measured value |
| --- | ---: |
| Semantic snapshot | **457.90 ms** |
| Value set | **19.81 ms** |
| Invoke | **20.14 ms** |
| Selection | **23.53 ms** |
| Total four calls | **521.38 ms** |

The benchmark observed 13 fixture semantic nodes, classified the fixture as Tetherplane-owned, verified the resulting fixture state, and asserted that the physical cursor position was unchanged across semantic operations.

## Reproduction

Windows local-core:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-local.ps1

Windows desktop:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-desktop.ps1

Browser benchmark after workspace build:

    node scripts/bench-browser.ts

Benchmark values can vary with machine load, filesystem cache, antivirus activity, browser startup state, and operating-system scheduling. CI should enforce deterministic invariants such as tool count, safety boundaries, and response caps rather than these machine-specific latency numbers.
