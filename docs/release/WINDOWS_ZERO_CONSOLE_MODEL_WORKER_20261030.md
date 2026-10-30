# Optional model-worker zero-console release gate (2026-10-30)

Draft candidate, stacked on #113. No devices, production identities, tasks, HKCU
Run values, credentials, OAuth/DCR, signing infrastructure or protected branches
were changed.

The previous `install-model-worker-windows.ps1` provisioned a persistent
PowerShell supervisor (`-WindowStyle Hidden`) in HKCU Run. Windows Terminal
could still display this console when Windows Terminal was the default console
host. A production "no unwanted terminals" claim cannot ignore the optional
worker launcher.

The new `bin/tetherplane-modelw.exe` uses the Windows GUI subsystem and starts
the existing packaged model worker with `CREATE_NO_WINDOW`. The Node model
client already runs its stdio `tetherd.exe` child with `windowsHide:true`.
The native launcher reads only the bounded, already local
`config/model-worker-args.json` (no model secrets in the command line),
rejects a foreign `--tetherd` executable, writes bounded diagnostic logs,
and restarts with capped backoff. The worker monitors its native parent and
cancels on launcher termination. HKCU Run is registered by explicitly invoking
the model installer; an existing foreign/legacy registration is **not**
silently replaced, even with `-Force`.

The uninstaller recognizes only the exact current-install native autorun
command alongside its historical legacy command, preserving unrelated
registrations. Windows CI must confirm the installed model launcher has PE
subsystem 2 and no visible Node child. CI uses fake local model endpoints and
synthetic temporary principal documents without real credentials.

Physical release gates remain: actual signed clean Windows interactive session,
no visible terminals on startup, crash, logoff, reboot and battery transition;
verified launcher-child ownership and rollback; scoped model operations and
negative authorization; code integrity, existing user migration, four-device
core acceptance. GitHub-hosted headless Windows smoke is not that proof.

RELEASE / STORE SUBMISSION: NO-GO.
