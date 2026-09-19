# Local Core Baseline

**Measured:** 2026-09-20 (Asia/Dubai)
**Source commit:** `7b4b969ced9f305e257bd38da606612ea9e24e46`
**Machine:** Leno
**Build profile:** Rust `release`

This document records measurements. The figures are not marketing targets and should not be generalized to other hardware.

## Environment

| Item | Measured value |
| --- | --- |
| OS | Windows `10.0.26200` |
| Architecture | x64 |
| CPU | 11th Gen Intel Core i5-1135G7 @ 2.40 GHz |
| Rust | `rustc 1.98.1 (48a229cea 2026-09-01)` |
| Node.js | `v24.19.0` |
| Browser provider | not configured |
| Desktop provider | not configured |

## Runtime baseline

| Metric | Measured value | Original design target | Result |
| --- | ---: | ---: | --- |
| Cold start to first `device.status` response | **2,580.35 ms** | <250 ms | target missed |
| Idle `tetherd` RSS after 10 seconds | **12.22 MiB** (12,816,384 bytes) | <50 MiB | target met |
| Default MCP-visible tool count | **6** | exactly 6 | invariant met |

The cold-start measurement starts immediately before spawning the release `tetherd` process, writes one canonical `device.status` request after process spawn, and stops when the first JSONL result line is received. It therefore includes Windows process startup and first-request initialization. It does not include the preceding Cargo build.

Idle RSS is the Windows working set reported for the same direct `tetherd` process after ten seconds of idle time following the first successful request.

## Compact response measurements

Fixture: a UTF-8 text file containing exactly 1,000 lines and 82,000 content bytes.

| Response mode | Delivered content | Serialized structured result | Truncated | Continuation |
| --- | ---: | ---: | --- | --- |
| `compact` | 16,384 bytes | 16,823 bytes | yes | byte offset 16,384 |
| `normal` | 65,536 bytes | 66,575 bytes | yes | byte offset 65,536 |
| `debug` | 82,000 bytes | 83,201 bytes | no | none |

These measurements confirm the deterministic response-budget behavior: compact and normal responses remain bounded and expose continuation metadata instead of returning the entire fixture.

## AI-visible round trips

| Workflow | MCP tool calls |
| --- | ---: |
| One ordinary shell command via `process(op="run")` | **1** |
| Three-file parallel inspection via `batch(op="execute")` | **1** |

The batch measurement creates the three fixture files during benchmark setup, then reads all three in one server-side parallel batch request. Setup operations are not counted as inspection round trips.

## Tool surface

The measured default tool list was exactly:

`batch`, `browser`, `desktop`, `device`, `files`, `process`.

The browser and desktop tools remain part of the six-tool public surface even when their providers are not configured; capability availability is reported separately.

## Method

The reproducible benchmark entry points are:

- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-local.ps1`
- POSIX: `bash scripts/bench-local.sh`

Both wrappers build release `tetherd`, build the Compact MCP adapter, and run `scripts/bench-local.ts`. Benchmark data files and controlled-machine test state are created only under operating-system temporary directories and are removed after the run. Build artifacts remain inside the repository's normal `target/` and package build directories.

## Limitations and follow-up

- This is one measurement on Leno, not a cross-machine benchmark.
- Windows working set is used as the RSS-equivalent process memory observation.
- Filesystem cache, antivirus, Windows process-start behavior, and machine load can affect cold-start timing.
- The **2.58 s cold-start result misses the original <250 ms design target by a wide margin**. It is retained as a hardening/performance follow-up rather than rewritten as a success.
- Generic CI should enforce deterministic invariants such as six tools and response bounds, not this machine-specific startup/RSS threshold.
