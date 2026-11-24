# Relay restart recovery: half-open device WebSocket

## Observed incident

On 2026-11-20, during a guarded VAULTER Owner Portal OAuth cutover, Leno, Surface, and VAULTER reconnected. RTX remained online on Tailscale but disconnected from Tetherplane. After the old relay was restored, restarting the existing RTX Agent scheduled task reconnected RTX. Four authenticated device.status requests then succeeded.

That does NOT independently establish the exact half-open TCP failure mode. Existing RTX stdout/stderr log files contained zero bytes; there was no conclusive packet or process-exit trace. Source inspection exposes a plausible failure: the agent awaited incoming WebSocket frames and only probed browser availability when a browser provider existed; no universal Pong deadline forced reconnection on an otherwise silent socket.

The RTX scheduled task has a logon trigger and bounded restart-on-process-failure settings. It cannot detect a running process that still holds a stale socket.

## Minimal agent source change

The Rust agent now sends a WebSocket Ping every 10 seconds independently of browser integration. A unique per-connection sequence must be echoed in Pong before the next interval; an absent or mismatched Pong returns the existing retryable relay failure. Sending a Ping is bounded at five seconds.

Estimated nominal maximum silent-socket detection: 20 seconds plus existing reconnect delay (roughly two seconds). This is a design bound, not a measured production SLO. Authentication rejection (401/403) remains fatal; credentials and permission policies are unchanged.

## Test evidence and reproducibility

New targeted tests in agent/tetherd/src/relay_ws.rs:
1. Matching Pong required; missing/mismatched Pong forces retry.
2. An isolated localhost WebSocket server accepts hello and goes silent; reconnect timeout must occur even without browser probing.
3. Three healthy Ping/Pong exchanges must not spuriously disconnect.
4. Existing TLS certificate, policy, and authentication tests remain unchanged.

Rustfmt and repo unsafe-code scan passed on isolated Windows worktree. Running cargo tests locally was blocked by VAULTER's installed Windows gnullvm compiler lacking its x86_64-w64-mingw32-clang linker. CI Windows and Ubuntu must compile and run the tests before a protected release. No rust toolchain, running agent, authentication task, or production binary was modified.

## Separate staged rollback hardening

During the previous OAuth cutover, the package was restored but the rollback verification aborted on a transient curl timeout under Windows PowerShell ErrorActionPreference=Stop. The staged rollback checker now converts transport failure into HTTP 000 and retries the private HTTPS portal checks for up to 25 seconds.

The nonproduction staged test hosted a blackholed HTTP socket for six seconds: the checker returned 000 and continued with exit code zero, while the original production relay remained healthy. This proves the helper behavior, not a full interrupted-machine rollback trial.

Staged files (VAULTER, not active production tasks):
- %LOCALAPPDATA%\Tetherplane\release-candidates\owner-portal-oidc-cutover-20261119\rollback-oidc-login.ps1
- %LOCALAPPDATA%\Tetherplane\release-candidates\owner-portal-oidc-cutover-20261119\test-rollback-status.ps1

## Release and acceptance boundaries

1. Pass independent Windows and Ubuntu CI against exact heartbeat commit; verify built Windows executable and negative authorization tests.
2. Rehearse actual agent reconnect after a synthetic blackholed relay socket, including TLS and authentication-denial cases.
3. Do not deploy an agent update, change scheduled tasks, restart the protected relay, or merge without explicit authorization.
4. Conduct a timed, real four-device cutover trial and confirm device.status remains usable within the intended recovery bound; preserve automatic rollback.
5. Reattempt Owner Portal OAuth deployment only once four-device recovery is reliable. The dedicated public PKCE OAuth client is already registered; do not register it again.
6. Confirm actual human owner login before declaring the bearer-token onboarding problem solved.
