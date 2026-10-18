# Windows Smart App Control / MSIX feasibility and release gates

Status: technical packaging proof only; unsigned, uninstalled and untrusted.
Date: 2026-10-18. Base: 14f3143ea6f98036db3a5eecc55a0fe3b0af7896.
Do not merge this proof as a signed release or install it on personal computers.

## Incident

Prior authenticated MCP operations on Leno and RTX were real but did not
prove that a newly launched agent was accepted under SAC On/enforcement mode.
Leno's controlled restart later recorded Code Integrity 3077 under
VerifiedAndReputableDesktop against an Authenticode NotSigned tetherd.exe.

The block is proven; the exact trigger for a different trust decision is
still unknown. Evaluation-to-enforcement transition, cloud reputation,
binary identity and policy changes require historical evidence. A running
scheduled task does not establish live MCP connectivity.

The earlier release process lacked a mandatory SAC-On real-install/restart
and authenticated device.status acceptance gate. Add that for release.

## Alternative distribution architecture

Microsoft re-signs MSIX packages only after Store certification; its process
does not give us a signed standalone EXE/MSI. Microsoft also has a no-fee
individual developer registration flow, subject to identity verification.
References:
https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer
https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview
https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.startuptask

This POC leaves the native agent unchanged, declares Windows full trust and an
explicitly disabled startup task, and does not install software, import trust
roots, disable SAC, enroll with Microsoft, or use any signing credentials.
It has placeholder images and a deliberately untrusted publisher.

## TDD and Windows CI evidence

RED: https://github.com/muhamedsohaib/Tetherplane/actions/runs/39145146095
Failed intentionally because the POC packager was not implemented.
GREEN: https://github.com/muhamedsohaib/Tetherplane/actions/runs/39145279843
Actual release tetherd build and MakeAppx packaging succeeded. Tests compared
native executable hashes, unpacked package manifest and files, full-trust
and startup declarations, deliberately unsigned state, refusal to overwrite,
and non-deploying local execution.

These prove packaging compatibility, not Store certification, SAC acceptance,
the bootstrapped agent's runtime behavior, or multi-device connectivity.

## Remaining acceptance gates

1. Build an owned native startup/bootstrap component that reads locally
   protected per-device state, validates it, and launches with least privilege
   without embedding device secrets or identities in packaged assets.
2. Preserve existing Leno device identity, local policy, credentials and
   ownership receipts; design migration and rollback without replacing
   a foreign installation or an existing scheduled task.
3. Test real MSIX installation, launch, startup, reconnect, upgrade,
   uninstall and local policy in Windows CI. An MSIX startup task at logon
   does not automatically prove pre-login always-on service operation.
4. Obtain owner approval before identity verification or Store submission;
   use a certified Store-signed package to test Leno with Smart App Control
   still On and no exceptions. Separately retain the reviewed Authenticode
   pipeline for non-Store EXE distribution.
5. Validate Leno, Surface, RTX and Vaulter independently through existing
   authenticated MCP, background_only policy and the required six-tool
   contract. Do not broaden local privileges to cure onboarding.
6. Publish a memorable CLI only after its true install, pairing, ownership
   and verified reconnect process works. A downloader for an unsigned EXE
   is not a SAC solution.

No real device, relay, scheduled task, Microsoft account, live credential,
Store listing or Windows security configuration has been changed here.
