# Store owner wizard windowless entry — 2026-10-30

**DRAFT / NO-GO.** Source-only repair stacked on PR #114; no Store
submission, signing, protected merge or owner-device change.

Read-only Windows inspection confirmed the signed Node executable has PE
subsystem **3 (console)** on Leno and Surface. The previously reviewed Store
manifest launched that console-subsystem `runtime/node.exe` directly as the
visible `Runtime` application. A physical Store-launch terminal was not
observed; this is a grounded release risk, not a claimed live failure.

The reviewed entrypoint now uses GUI-subsystem
`bin/tetherplane-setupw.exe` with **zero arbitrary arguments**, which
starts the same signed packaged Node runtime and existing owner setup
`app/runtime-app.mjs` with `CREATE_NO_WINDOW`. Node's wizard still enforces
owner pairing and approval. The new launcher cannot create credentials, tasks
or OAuth clients. It owns its Node child and supplies a parent PID so the
wizard can terminate its own agent and loopback server if the parent dies.
The intentionally opened browser-based setup UI is not an unwanted console.

Windows synthetic CI must inspect PE2, fail on incomplete package or
unexpected args, launch a GUI parent and Node CUI child without process
windows, verify one owned child and no orphaned loopback after parent
termination. The exact candidate's Store builder must hash the setup launcher
and verify its bytes after synthetic MSIX pack/unpack. No unsigned package is
installed or published, nor is Smart App Control turned off.

**Separate release gate:** real Windows 11 Smart App Control On, approved
Store-certified signing, GUI wizard operator-observed first-run activation,
trusted native agent, negative authorization, clean install and rollback,
four authorized devices. Microsoft publisher case 2610290010001747 remains
pending. Code-only synthetic CI cannot prove these.
