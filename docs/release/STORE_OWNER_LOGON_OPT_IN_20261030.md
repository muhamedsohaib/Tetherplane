# Tetherplane Store — owner-opted startup after Windows sign-in

Status: DRAFT, nonrelease, NO-GO for production. 2026-10-30.

## Existing independently tested work, not repeated

- Signed Node was verified to be Windows CUI (PE 3) on Leno and Surface;
  PR #115 switched the Store wizard to a GUI-subsystem entrypoint.
- Real Leno unsigned native canary: owner-authenticated connectivity on AC
  and battery; reconnected after sign-in/reboot while browser unavailable.
- PRs #113–#115: disposable Windows package/test coverage including no-window
  child process and Store synthetic MSIX pack/unpack. Physical Windows 11
  Smart App Control (SAC) On, signed Store install and owner startup tests
  have **not** passed.
- The Store MSIX had no user-managed persistent agent startup. The approved
  wizard only spawned an agent for its existing running session.

## Choice: Windows packaged StartupTask, default DISABLED

Microsoft's Windows.ApplicationModel.StartupTask supports an optional
`windows.startupTask` extension for packaged desktop apps. This version
keeps the same two MSIX Applications, the same publisher/identity, and the
same runFullTrust declaration. It adds one extension on the **Runtime**
application, with `Enabled="false"` and task
`TetherplaneOwnerAgentLogon`. No startup is enabled at install or during
pairing. After the user has independently verified authenticated
`device.status`, the setup page directs them to Windows Settings > Apps >
Startup to opt in to "Tetherplane Agent". The user can disable startup from
Windows at any time. This runs **after user sign-in**, not as a system boot
service or before the owner logs on.

There is no elevated scheduled task, Run-key autorun, hidden PowerShell
supervisor, self-signing, exemption from SAC, or auth/scope change.

## Startup authorization path

- `bin/tetherplane-autostartw.exe`: new Windows GUI-subsystem packaged
  startup executable, no extra command-line parameters. Starts only bundled
  Node `app/agent-autostart.mjs` using `CREATE_NO_WINDOW`.
- Node refuses a spoofed/nonmatching native parent process ID; reuses
  `readSavedConfig`, which verifies saved owner/SYSTEM-only DACL, config,
  non-link files, credential and allowed directory. **No** device identity is
  created, replaced, paired, reissued or silently permission-repaired.
  Missing identity is a no-op, insecure/tampered state denies agent startup.
- Launches only the installed `bin/tetherd-agentw.exe` with existing
  owner-approved relay URL, device ID, scoped allow root and credential-file
  path. No credential contents on command line or in fixed-label logs.
- The approved Store-specific wizard and the autostart agent both pass
  `--owner-instance-lock`. The Windows native agent holds an exclusive
  Windows sharing lock inside its existing private state dir. A second
  agent exits with code 73, without a stale PID file. Device relay handling,
  authorization policies and browser independence are unchanged for other
  launches.
- A native-parent monitor kills the one launched agent if the startup
  supervisor exits; nonzero agent failures restart with bounded retries
  and backoff. Rechecks credential ACL and owner identity before each retry.
  Logs fixed status labels only, under the existing private owner directory.

## Independent synthetic review

Windows CI must compile and inspect GUI PE subsystem 2 on the new entrypoint;
deny an unauthenticated/malformed identity without provisioning anything;
test existing owner-protected state, exactly one agent, no foreground window
on the native/Node/agent process, second-process denial, orphan cleanup on
launcher termination; confirm pack/unpack and hashes of the new Rust and Node
payload. The actual Store relay test retains owner approval, six-tool listing,
foreign-account denial, native reconnect and revocation. No Store package is
installed or signed in CI, and no device is modified.

## Remaining release gates

1. Store publisher eligibility and signed certifiable MSIX, including
   valid first-run owner artwork and genuine screenshot approval.
2. New owner-authorized Windows 11 machine with SAC **On**: install the
   trusted Store-signed MSIX, pair only with owner approval, confirm
   device.status and unauthorized scope denial.
3. Manually enable the Startup setting and verify Windows actually registers
   the packaged startup task, zero unwanted visible terminals, exactly one
   native agent after sign-out/sign-in, reboot and AC/battery transitions.
4. Disable startup again and prove no new agent on next sign-in; verify
   no duplicate agent if wizard is opened while startup agent runs; test
   revoked/removed/insecure owner state fails closed, rollback and uninstall.
5. Repeat authorized four-device acceptance and test browser permission
   denial/recovery separately (the Store core does not silently enable
   browser automation).

No merge, public release, protected deployment, signing, trust changes,
production startup activation or Partner Center submission is authorized
by this review branch.

Microsoft API reference:
https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.startuptask
