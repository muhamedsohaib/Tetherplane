# VAULTER deployment evidence snapshot and liveness diagnosis — 2026-10-22

**Mode:** read-only production investigation; immutable source evidence copied as hashes/metadata only to the existing October 22 draft branch. No binary, service, task, config, credential, identity, Tailscale, or relay infrastructure modifications. XERJ/OpenCode evidence remains untouched.

## Observed owner-created artifacts and timestamps

| Local, owner-produced artifact in authorized Tetherplane Workspace | UTC observation | Meaning |
| --- | --- | --- |
| `vaulter-relay-diagnostics.json` | 08:30:02Z | Agent PID 5112 and listener/task summary; no correlated route traces |
| `vaulter-listener-owners.json` | earlier same day | Port 8788 owned by Node PID 7072; 10000 by tailscaled PID 7624 (two listener rows, one owner) |
| `vaulter-build-identity.json` | 09:11:54.8597350Z | Process executable basename/SHA-256; Node executable hash is **runtime only** |
| `vaulter-relay-entrypoint.json` | 09:15:50.7914953Z | Running PID's on-disk entrypoint `cli.js`: SHA-256 `1C305BAD54DA109D46A26B55D0388C84E6361A8015451053CF865F3B27773B59` |
| `vaulter-relay-bundle.json` | 09:18:59.3373607Z | 17 .js module relative filenames and SHA-256 |
| `vaulter-relay-imports.json` | 09:24:25.3497572Z | On-disk `server.js` explicitly imports `access-log.js` and `http-claim.js` |

The owner retained local files; this report intentionally **does not copy the original production logs, credentials, protected paths, or full command lines**. Those uncollected artifacts and timestamps are **not** claimed to be preserved.

### Process executable SHA-256

- `tetherd` PID 5112: `4F06B70CA4EEFB2C1C5CFB70DA71E1DA45D02ECE54D3F96B1220E16EDCB2102A`
- `node` PID 7072: `3602F2BB1A10F2CBAB4C36886218A33C1AB3DB87290E73B033C46C77147D0237`
- `tailscaled` PID 7624: `A18D777A2BBE2F7CD08A1519BA1645D9B017A83AAF8E4B71318B4245BF67FEEF`

### Deployed on-disk relay JavaScript SHA-256 inventory

| Relative name | SHA-256 |
| --- | --- |
| access-log.js | 1E91CF3CB7ECDBDC81A94E106E3C5E209F67C45A11E197E81D662585FC1B093C |
| cli-config.js | 8D844AA19669493088AC8A20CA3F78AE4500BB764B224DC4B51D38C5E16B4058 |
| cli.js | 1C305BAD54DA109D46A26B55D0388C84E6361A8015451053CF865F3B27773B59 |
| health-http.js | 01C820B160367CD6F0CAC2A41E1EEBCB8DE9F549EEC5833D0C82C2952131E764 |
| http-claim.js | 47F5F3266CE6D748D67821D4EC240D9812DCBD461A58B9C32C4FD20DC0834A50 |
| index.js | 2EFECE136DF44B476EBD6348C8ADFF8B16F0528901E42185B0641193CC698AF8 |
| server.js | 21B2B68568261EB9CF6E4D3D357D4C782035E8E09D180F88A3F0E3EEB93C84F9 |
| auth/login-proof-http.js | 3ABFB2C9C00B3DCD433A7D73FC4C727E71C3435E462C692F0BF5851ADEEE281E |
| auth/login-proof-registry.js | 35FE0A5B8E03C9027F9F60302E1021357BEA9032BA2B0319D131969A63546C57 |
| auth/oauth-resource.js | 7CA1D7F43670A916F91060C76545A5A422B1E2BC917C4FBDC5ED743C99AADC29 |
| auth/oidc-auth.js | E16DE8DACE5EB04CA0CE4419B470E1E85630011FF9F805A252343FF9AE4FCA14 |
| auth/static-auth.js | 8547322C4A6E68F6CFA46B6BBFB3768B5A78750ACB9488219A337B20E6E13670 |
| devices/control-http.js | 934799CBA56B1820C83B63095FF77996B0289320E8AA7DFAB4BAA72CC3DED455 |
| devices/registry.js | 8E49B9524566B58962BBF0914D457E0B4D6E792DADD2E9B2A93FE2E8140BBB47 |
| devices/ws-gateway.js | A376BCBA8E713C56EC14C7BF6E296E8B352EE95EBECA079D25D8C06809FA62D8 |
| mcp/http-gateway.js | 572FECCBE3E087D4D0021A6FFC9F6813A75642EAB7D5D3E4A2EBD139623C5408 |
| routing/device-router.js | 2F9270B3C3FB55115A050D82D86AB691D5AA149E13C331A620BD2C6A7004CBCF |

## Reproducible lineage findings vs inference

**Verified:** A local isolated TypeScript 5.8.3 emission from the two source modules on historical `fix/relay-unmatched-route-404-20261015` (commit `f81706fd516c6da2dbc26900250939d22975fcbf`) produced byte-identical `access-log.js` and `http-claim.js` hashes. This partial compilation reported missing Node declaration diagnostics, so it was **not** a clean full-repository build. Source module presence and the explicit deployed `server.js` imports make mere orphan files an insufficient explanation for the *on-disk* server structure.

**Verified:** GitHub source tree on that historical branch has 17 relay TypeScript modules, including the two above. Current October 22 draft branch has 15; its `relay/src/routing/device-router.ts` and `relay/src/devices/ws-gateway.ts` blobs are identical to historical branch while `server.ts` and `cli.ts` differ.

**Not verified:** All 17 rebuilt module hashes; exact active in-memory files if on-disk files changed after process start; compiler/dependency/build identity of the entire deployed relay; deployed `tetherd.exe` provenance; signed artifact provenance; a source commit for the running deployment. Do not label `f81706fd` as the actual deployed commit.

## Distinct code-level reliability finding (not incident attribution)

At October 22 source head, `agent/tetherd/src/relay_ws.rs` performs `runtime.execute(invocation).await` **inside** the sole `socket.next().await` loop and sends the result before advancing the loop. A legitimately stalled invocation therefore prevents that same agent connection from reading subsequent messages or responding to Ping, including independent `device.status` requests. By contrast `agent/tetherd/src/stdio_rpc.rs` spawns concurrent requests in a `JoinSet`.

This is a **deterministic source-level head-of-line-blocking risk**, independent of whether it caused the observed October 22 production timeouts. The actual incident cannot yet be attributed without route-correlated send/agent-execution/result logs and deployed agent hash-to-source attestation. The operator's release-blocking objective is that no one stalled operation render an entire device unreachable; testing must demonstrate a responsive control plane under a stalled execution with bounded concurrency and correct authorization.

## Existing supervisor reuse

Branch `feature/vaulter-relay-bounded-supervisor-20261010` commit `72284565b05b1ebb6dafe2c8eed59ec10995259c` contains bounded supervisor, source runbook, guarded handover and rollback. It handles **process exits**, not a process that stays alive while an invocation hangs. Its documented live activation is pending. Reuse its evidence and recovery plan; do not stage, install or activate it automatically.

## Gate

CI for previous draft commit `3d3db4d1c8069b78fc4c656f515a93d6881d7195`: Windows/Ubuntu success, but separate Vercel check reported failure. Draft only. No incident root cause, signed clean-install recovery/four-device acceptance. **NO-GO.**
