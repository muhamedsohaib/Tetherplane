# VAULTER V5 directory ACL hardening — approved-scope proposal, NOT applied
Date: 2026-10-31. Status: **SOURCE-ONLY / NO PRODUCTION ACL CHANGE**.

## Verified production observations

- Owner-run ACL audit observed 2026-10-31T13:01:07Z:
  * C:\ProgramData\Tetherplane and its descendants ControlCenterReleases, accepted V5 release directory and public directory inherit BUILTIN\Users Allow Write with ContainerInherit.
  * V5 oauth.mjs, public/index.html and public/tp-integration.js have no broad Users write allow ACE; they have Users read/execute.
  * The inherited Write ACE in directory ancestors is a real directory-write exposure. No unauthorized exploitation, file overwrite or module injection has been demonstrated.
  * Portal task: Running, S4U, Limited; exact deployed oauth.mjs SHA-256 afab023ea2de6d64d717314082c0d3c1f919ef1d84d426cf1bd9212b612f0a59.
  * The accepted Git V5 oauth.mjs matches that hash after Windows CRLF conversion. No source replacement is indicated.

Windows NTFS distinguishes ContainerInherit from ObjectInherit and honors directory-write rights separately from file-write rights. Inherited ACLs may need explicit protection at a selected subtree; see Microsoft icacls and File Security and Access Rights reference documentation.

## Scope of proposed smallest safe intervention

Candidate target: only C:\ProgramData\Tetherplane\ControlCenterReleases directory and its unprotected descendants. Do not blanket-change C:\ProgramData\Tetherplane or C:\ProgramData and do not remove other task/service identities, SYSTEM, Administrators or owner rights. Do not modify OAuth, DCR, device registry, live grants, the V5 private artwork, scheduled tasks or running processes.

Proposed intent: remove the inherited BUILTIN\Users Allow Write inherited on directories inside the code-release subtree, while preserving required read/execute rights for the S4U portal account and its service dependencies. Parent container ACL remains unchanged; therefore this is *not* a complete audit of the wider ProgramData tree.

## Necessary owner-admin preconditions BEFORE any live modification

- [ ] Confirm only the approved V5 executable at the expected hash is active and there are no surprise writable/junction/symlink paths.
- [ ] Inspect the *current running task* account and the portal authority config without exposing secrets; verify that journalPath, checkpointPath, lock files, OAuth config, sockets, logs, temp files and all other required live writes are **outside** the proposed immutable code subtree. If anything must write inside it, stop and redesign the staging layout first.
- [ ] Inventory DACLs and inheritance flags including explicit, inherited, allow, deny and service-principal ACEs, and verify non-admin effective write access with a controlled, authorized test identity in disposable staging.
- [ ] Capture authenticated four-device baseline (RTX owner-approved when available), signed source/artifact manifests and deterministic task/service fingerprints.
- [ ] Save original ACL and known-good V5 binary/task/config package with owner-only controls, locally encrypted, restore procedure and verified hash; rehearse this package against an isolated Windows fixture.
- [ ] Get explicit owner approval for any change to live security permissions. No current authorization to mutate VAULTER ACLs has been granted.

## What was actually tested on Leno

A synthetic Windows directory hierarchy mirrored the ACL pattern: BUILTIN\Users RX on directories/files and Users Write with ContainerInherit on directories only.

A naive one-pass SetAccessRuleProtection + RemoveAccessRuleSpecific attempt FAILED: inherited write reappeared despite protected inheritance.

Corrected TWO-PASS sequence, tested only in the disposable user TEMP folder:
1. Protect selected subtree ACL inheritance while copying inherited ACEs; **persist** it using Set-Acl.
2. **Reload** the ACL from disk, select only BUILTIN\Users Allow ACEs with write-specific flags (0xD0156 / decimal 852310), remove the exact rule, and persist a second time.
3. Verify no Users write ACE at the subtree, descendants, future children; preserve Users read, original files' SHA-256 and untouched parent ACL.
4. Reapply the exact pre-change ACL object in the test fixture; verify inherited Users write and inheritance state are restored.
5. Delete the temporary fixture.

Result: BASELINE PASS, SCOPED_HARDENING PASS, UNCHANGED_FILE_HASHES PASS, UNRELATED_PARENT_ACL_PRESERVED PASS, FUTURE_INHERITANCE PASS, RESTORE_ORIGINAL_ACL PASS. These are **synthetic ACE/persistence tests**, not a real low-privilege token test and not an actual VAULTER rollback.

Repeatable source-only test: tests/release/v5-control-center-acl-isolated-rehearsal.ps1, integrated into the Windows CI quality job. Independently executed on Leno under Windows PowerShell. Remote GitHub Windows CI result not yet established.

## Acceptance gates for owner-approved remediation

- [ ] Owner-admin captures protected, independently restorable ACL and V5 artifact backup before mutation.
- [ ] Independently validate exact expected task/service identity and write locations.
- [ ] Explicitly approve **subtree-only** permission change.
- [ ] Apply the already-rehearsed two-pass operation to the approved subtree only, with fail-closed preconditions.
- [ ] Verify effective rights with a non-admin principal, including denial of file/subdirectory creation in immutable code tree, and unchanged portal read/execute.
- [ ] Recheck the same accepted V5 SHA-256, three running loopback listeners, S4U portal sign-in and owner authority audit (no change in service identity).
- [ ] Verify unauthorized operations remain denied; collect restoration receipt and preserve independent offline rollback path.
- [ ] Continue separate Leno Full Control and RTX/four-device acceptance gates. ACL hardening does not grant Full Control.

## Release status

**NO-GO for Leno Full Control activation and public release.** This document approves no action itself, and no production permission or security identity was changed.
