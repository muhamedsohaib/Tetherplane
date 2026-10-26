# Windows PowerShell MCP stdio repair — isolated release candidate

Date: 2026-10-26. Base: draft PR #61 commit `84550bd73604f4e14ca716c7d7df9b815b782ba9`.
Worktree: `fix/windows-powershell-mcp-stdio-20261026`.
Scope: Windows installed `launch/tetherplane-mcp.ps1` and synthetic regression only. No production relay, OAuth clients, device identities, or local access policies changed.

## Historical failure to explain

In [GitHub Actions run 40322542030](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40322542030) the Windows release binary, packaged install and direct six-tool SDK smoke succeeded, then the **installed PowerShell launcher** did not complete an MCP handshake within the bounded 20-second check. This is a real release blocker; direct Node success is not a substitute for the actual user-exposed launcher.

## Verified local fault isolation

- Windows PowerShell 5.1, Node 24.19.0 on Leno. Plain Node and ordinary PowerShell **text echo** can pass a small stdin/stdout test, including when stdin stays open. Therefore a generic claim that PowerShell never forwards stdin is inaccurate.
- The actual MCP SDK's `StdioClientTransport` builds a restricted inherited environment. Its Windows whitelist **omits `PATHEXT`** (verified from the installed SDK source and a live test).
- A disposable synthetic MCP SDK client and server successfully negotiate/list tools when launched directly through Node. The same server through Windows PowerShell's native `& node` invocation fails with this restricted environment. Adding only `PATHEXT` to the **initial child environment** makes that synthetic path work. Trying to restore the variable inside the script was insufficient in the tested environment.
- Replacing the nested native call with `Start-Process -FilePath <exact existing node.exe> -ArgumentList <CRT-quoted args> -NoNewWindow -Wait -PassThru` passes the actual MCP SDK handshake/list-tools test with its original restricted default environment. It does not require changing any global/user/machine environment variables.
- Node is resolved via `Get-Command node.exe` with an absolute PATH-directory fallback, not by installing new software or guessing a version.
- The positive test executes a copy of the **actual patched launcher** inside a temporary fake package, with a test-only non-executable `tetherd.exe` placeholder, tests six tool names, checks the forwarded `--tetherd`, `--allow` and `--state-dir` paths, and exercises paths containing spaces and trailing backslashes. No real system or agent is touched.
- A separately embedded historical PR #61 launcher fails as a negative control under the same SDK default environment.
- `node --test adapters/compact-mcp/windows-powershell-launcher-env.test.mjs`: **3/3 PASS** on Leno.
- `node --test tests/release/windows-clean-install-contract.test.mjs`: **6/6 PASS** on Leno.
- `node --test tests/release/windows-main-publication-block.test.mjs`: **4/4 PASS** on Leno.
- Workspace `pnpm -r typecheck`: **PASS** on Leno.

## Remaining verification and limitations

This repair has **not yet been tested against the exact Windows release binary and package** from the hosted runner. The historical CI cause is strongly implicated, but not established until the original `WINDOWS_PACKAGED_POWERSHELL_MCP_HANDSHAKE_PASS` acceptance succeeds on the new exact-head candidate.

Leno cannot locally compile the Windows Rust release executable because the MSVC `link.exe` build tool is unavailable. The TypeScript MCP adapter builds successfully. Installing toolchains or altering an existing production canary is outside this isolated fix.

The Windows CI workflow now contains an early synthetic PowerShell SDK regression before `cargo build --release`; the existing real packaged launcher handshake remains a **mandatory separate gate**. A passing synthetic fixture is not a substitute for signed package installation, clean first-user OAuth enrollment, actual API operations, restart/rollback, and four-device authenticated/denied acceptance.

**Decision: release NO-GO until exact-head hosted Windows CI and complete clean-install acceptance pass.** Do not merge/publish protected changes without approval.
