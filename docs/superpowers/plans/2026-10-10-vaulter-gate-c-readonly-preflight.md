# Vaulter Gate C — read-only supervisor preflight and controlled-activation handoff

**Date:** 2026-10-10  
**Status:** Operator runbook only. Does not authorize service disruption.  
**Target:** Vaulter *only through an operator-authorized local session*. Do not use Remote Desktop Commander to target Vaulter under Tetherplane's Leno-only RDC execution policy.

## Intent and current evidence

Protected v2 runner bytes were previously installed and verified on disk; the then-running S4U PowerShell parent was still executing its previously loaded v1 logic. The original Auth0-backed relay remains in service. Prior PID observations are historical, not current. Latest GitHub feature-branch source contains guarded supervisor refresh, an offline original-v1 rescue, and a separate read-only-by-default staged-listener cutback candidate. None of their live activation, cutback, crash exercise or boot acceptance gates have passed.

## Stage 0 — Bring the *staging checkout* up to the approved source (not read-only)

This section changes only the Vaulter staging Git working tree; it does not stop services. Execute only in a separately authorized local operator session after checking the checkout for unrelated work. Never silently overwrite a dirty checkout. Do **not** paste remote URLs or Git credential configuration into chat.

~~~powershell
$repo = Join-Path $env:USERPROFILE 'source\Tetherplane-auth-stage'
$branch = 'feature/tether-auth-vaulter-migration-20261009'
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw 'Staging checkout absent.' }
$dirty = @(git -C $repo status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Staging checkout is not clean; stop.' }
$current = [string](git -C $repo branch --show-current)
if ($LASTEXITCODE -ne 0 -or $current.Trim() -cne $branch) { throw 'Unexpected staging branch; stop.' }
git -C $repo fetch origin $branch
if ($LASTEXITCODE -ne 0) { throw 'Fetch failed; stop.' }
git -C $repo pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'Non-fast-forward staging update refused.' }
$localSha = [string](git -C $repo rev-parse HEAD)
$remoteSha = [string](git -C $repo rev-parse "refs/remotes/origin/$branch")
if ($LASTEXITCODE -ne 0 -or $localSha.Trim() -cne $remoteSha.Trim()) {
    throw 'Staging checkout differs from fetched feature branch.'
}
Write-Output ('STAGING SOURCE VERIFIED: ' + $localSha.Trim())
~~~

Compare the resulting SHA with the **then-current** GitHub feature-branch HEAD before proceeding. Source updates do not mean a protected runner file or its already-loaded PowerShell parent was activated.

## Stage 1 — Genuine read-only live preflight

The four scripts below must run **without any mutation switches**. This is designed for the currently running S4U service, **not** for a stage-owned fallback process. The tooling checks registered task identity, S4U owner, installed runner hashes, protected v1 backup and ACLs, task-owned listener/parent, existing original Auth0 metadata, local/public JWKS, relay readiness and the existing four private Tailscale ports.

~~~powershell
$ErrorActionPreference = 'Stop'
$repo = Join-Path $env:USERPROFILE 'source\Tetherplane-auth-stage'
$scriptDir = Join-Path $repo 'scripts'
$checks = @(
    'vaulter-tether-auth-runner-upgrade.ps1',
    'vaulter-tether-auth-offline-restore.ps1',
    'vaulter-tether-auth-supervised-postcheck.ps1',
    'vaulter-tether-auth-recovery-rehearsal.ps1'
)
foreach ($name in $checks) {
    $path = Join-Path $scriptDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Preflight source missing: $name" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $path
    if ($LASTEXITCODE -ne 0) { throw "Preflight FAILED: $name" }
}
Write-Output 'ALL READ-ONLY S4U PREFLIGHT COMMANDS PASSED. NO ACTIVATION PERFORMED.'
~~~

This output is evidence of the state at the time of the read, **not** evidence of automatic recovery or a successful future cutback. Do not reuse historical PID 8748 as a live process identity.

## Stage 2 — Conditional fallback preflight only

Run the **default no-switch** command below only if a previous, separately approved maintenance operation actually left the named S4U task Disabled and the protected ownership record for the running fallback Node instance exists. In the normal S4U-running state the cutback preflight is expected to refuse, and this is not an error to be worked around.

~~~powershell
$repo = Join-Path $env:USERPROFILE 'source\Tetherplane-auth-stage'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\vaulter-tether-auth-staged-cutback.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Staged cutback preflight failed; no cutback authorized.' }
~~~

No process without a verified protected ownership record may be adopted or terminated merely because it runs Node or uses port 8790.

## Authorization, explicit stop conditions and recovery

- **Separate maintenance approval is required** before any supervisor refresh, process termination, staged cutback, injected failure, Task Scheduler mutation, reboot, Funnel change, Auth0 issuer change or retirement.
- Stop on dirty/out-of-date checkout, unknown Node/PowerShell PID or creation time, a task that changed its action/principal/retry/boot-trigger state, missing or ACL-mismatched v1 backup/proof, multiple or non-loopback 8790 listeners, JWKS drift, original Auth0 resource metadata drift, any unexpected private-port exposure, or failure to prove independent rollback readiness.
- In a controlled activation window, attempt only the guarded named-task refresh; accept v2 only with independent proof of the new task-owned parent and child, v2 source identity, one listener, unchanged keys, Auth0/relay/Funnel/private-port state and health.
- If verified original-v1 recovery fails and staged fallback becomes the only healthy process, preserve the ownership proof and disabled task. Any later staged-to-S4U cutback is a **separate** maintenance operation requiring its own preflight and approval.
- If task restoration fails after partial S4U startup and a new task-owned process cannot be proved safe to stop, the current candidate **fails closed** and may report ROLLBACK UNVERIFIED rather than killing an ambiguous process or starting a competing listener. This is a real availability limitation requiring a staffed rescue plan before live cutback.
- Gate D automatic recovery, a subsequent reboot acceptance, OAuth PKCE/refresh/revocation/public routing, authenticated ChatGPT six-tool acceptance and eventual Auth0 retirement all remain separate later gates.

Never paste credentials, raw process command lines, private signing keys, token environment values, entire protected configuration, or unredacted Git remote URLs into chat.
