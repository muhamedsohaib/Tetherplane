# Windows clean-install boundary — controlled red/green acceptance

Date: 2026-10-26. **Nonrelease test PR only.**
Source base: protected main `fc8590a7e997c01878ca4d85469d6ba8eae23882`.
Branch: `test/windows-clean-install-boundary-20261026`.

## Why this is the next gate
A successful G1 MSIX experiment proved disposable packaging/sign/install/removal of a minimal native binary, while the existing Windows CI also performs a full six-tool package smoke using temporary file locations. Neither establishes a new user's seamless first-time OAuth connection to a Windows 11 device.

The installer source was independently inspected and two release blockers were identified:
1. The packaged PowerShell MCP launcher starts with ordinary statements before `param(...)`; Windows PowerShell can parse it but the AST has **no script-level parameter block**, making first-launch argument forwarding unreliable.
2. On protected main the `-Force` branch deletes the existing install prefix before validating scheduled-task JSON. An invalid argument file can therefore destroy an existing installation before failing.

A separate uncommitted worktree `fix/windows-clean-install-gate-20261026` already contains candidate corrections. **This test-only branch does not modify or consume that unrelated worktree.**

## The experiment
- A GitHub-hosted ephemeral Windows PR runner tests a *synthetic credential-free package*. It does not start a real agent.
- Source parser checks launcher's AST parameter block (not merely parse success).
- Synthetic fresh installation checks staging and receipt creation without signing, agent activation or OAuth.
- An intentionally invalid argument file is supplied alongside `-Force -InstallScheduledTask` against a sentinel created only under the disposable runner's `RUNNER_TEMP`.
- The test asserts the invalid arguments are rejected, the sentinel is retained, and no task is registered. It removes only its newly created scratch subtree.
- One JSON report with explicit PASS/FAIL fields is retained for seven days. No executable, private signing certificate, credential or system state is uploaded.
- This test deliberately produces a **RED** result against flawed source. An honest red result is required until an independently reviewed fix passes the same contract.

## Acceptance matrix
| Gate | Required evidence | State |
|---|---|---|
| CI/source isolation | 3/3 Node contracts, PowerShell AST test-script parsing, no ambient device writes | Pending hosted run |
| MCP launch argument parser | `tetherplane-mcp.ps1` parsed with top-level `ParamBlock` | Expected RED on main |
| Fresh synthetic install layout | Valid directory layout and receipt under runner temp | Pending |
| Invalid scheduled arguments denied | No scheduled task created, installer fails closed | Pending |
| Existing install preservation | Sentinel survives invalid `-Force` call | Expected RED on main |
| Full compiled native kit | Packaged tetherd + Node MCP edge + six-tool smoke | Existing CI separate, not replaced |
| New-machine signed package | Trusted publisher/Store-approved package on independent Windows 11 machine | NO-GO |
| New OAuth/DCR pairing | Approved test identity, exact scopes, denied operations, independent results | NOT TESTED |
| Recording | Start before actual install; preserve first attempt and errors | NOT STARTED |

## Release and recording
Do not record a "fresh-install success" while this red gate is unaddressed. A later recording should show a signed or Store-approved **complete** client package, first-time authorized pairing on an approved disposable Windows 11 test machine, the first remote execution and correct denial, then recovery/uninstall. CI alone is not a user demo.

**No modifications to Surface, Leno's installed agent, VAULTER, RTX, OAuth clients, protected main, protected release tags, or signing identities.** No merge or publication is authorized by this PR.

**Release decision: NO-GO** until independently verified fixes and full clean-client acceptance pass.
