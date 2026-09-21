# Tetherplane Release-Candidate Benchmark — 2026-09-21

**Measured:** 2026-09-21 (Asia/Dubai)  
**Source commit:** `c1ea567c09fe2a0244ff12db2864cf309e0fedaf`  
**Machine:** Leno  
**OS:** Windows `10.0.26200` x64  
**CPU:** 11th Gen Intel Core i5-1135G7 @ 2.40 GHz  
**Rust:** `rustc 1.98.1 (48a229cea 2026-09-01)`  
**Node.js:** `v24.19.0`

These are measured results from one machine, not universal guarantees or marketing targets.

## Fresh Plan F verification gate

Immediately before these measurements, the current canonical source at `c1ea567c09fe2a0244ff12db2864cf309e0fedaf` passed:

- Rust format check;
- workspace Clippy with warnings denied;
- complete Rust workspace tests;
- recursive TypeScript typecheck;
- recursive TypeScript tests;
- recursive TypeScript build;
- black-box E2E suite;
- authored unsafe-code scan;
- `git diff --check`;
- release `tetherd` build;
- Compact MCP release build;
- Windows package/install/uninstall/supervisor smoke;
- final clean-working-tree check.

The Windows release smoke includes a clean temporary install, installed six-tool MCP smoke, ordinary uninstall, preserved state verification, and supervised agent restart behavior.

## Local core

Release-profile `tetherd` was measured by `scripts/bench-local.ts` using a temporary data root.

| Metric | Measured value | Original design target | Result |
| --- | ---: | ---: | --- |
| Cold start to first `device.status` | **256.95 ms** | <250 ms | missed in this run |
| Idle working set after 10 seconds | **12.21 MiB** (12,804,096 bytes) | <50 MiB | met |
| Default MCP-visible tools | **6** | exactly 6 | invariant met |

The startup target remains a measured miss for this release candidate: this run was **6.95 ms** above the original <250 ms target. Historical results remain in earlier benchmark documents because startup measurements have shown meaningful run-to-run variance on the same named machine.

The measured tool list was exactly:

`batch`, `browser`, `desktop`, `device`, `files`, `process`.

### Compact response bounds

The 1,000-line UTF-8 fixture produced:

| Response mode | Delivered content | Serialized result | Truncated | Continuation |
| --- | ---: | ---: | --- | --- |
| `compact` | **16,384 bytes** | **16,823 bytes** | yes | byte offset 16,384 |
| `normal` | **65,536 bytes** | **66,575 bytes** | yes | byte offset 65,536 |
| `debug` | **82,000 bytes** | **83,201 bytes** | no | none |

AI-visible round trips:

- ordinary shell command: **1**
- three-file parallel batch: **1**

The local-core benchmark intentionally did not configure a browser provider. It reported the Windows UI Automation desktop provider as configured.

## Browser semantic workflow

`scripts/bench-browser.ts` used installed `chrome.exe` through the isolated CDP backend and deterministic Browser Lab fixture.

| Metric | Measured value |
| --- | ---: |
| Semantic snapshot | **30.85 ms** |
| Verified action | **101.23 ms** |
| Total two-call workflow | **132.08 ms** |
| AI-visible round trips from unknown initial state | **2** |
| Verification | **verified** |

The browser benchmark used a Tetherplane-owned isolated browser context and did not require control of a human-owned tab.

## Windows desktop semantic workflow

`scripts/bench-desktop.ts` used release `tetherd`, Compact MCP, Windows UI Automation, and the deterministic owned desktop fixture.

| Metric | Measured value |
| --- | ---: |
| Semantic snapshot | **421.46 ms** |
| Value set | **6.85 ms** |
| Invoke | **8.37 ms** |
| Selection | **15.59 ms** |
| Total four calls | **452.26 ms** |

The benchmark observed **13** fixture semantic nodes, verified the fixture result, and asserted that the physical cursor position remained unchanged across the semantic operations.

## Reproduction

Windows local core:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-local.ps1

Windows desktop:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-desktop.ps1

Browser benchmark after workspace build:

    node scripts/bench-browser.ts

Benchmark values can vary with machine load, filesystem cache, antivirus activity, browser startup state, and operating-system scheduling. CI should enforce deterministic invariants such as tool count, safety boundaries, response caps, and test behavior rather than these machine-specific latency numbers.
