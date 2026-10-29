# Windows candidate byte evidence

This read-only command inventories an already supplied, quiescent Windows x64 package. It never runs package files, installs, signs, changes tasks or publishes. The package must contain `manifest.json`, `bin/tetherd.exe` and `bin/tetherd-agentw.exe`. Its manifest must identify the independently expected full source commit and Windows x64 platform.

Use Node 22. To print a deterministic inventory:

```text
node scripts/release/windows-candidate-digests.mjs record PACKAGE EXPECTED_SOURCE_COMMIT
```

Save stdout as a UTF-8 inventory file **outside** PACKAGE, preserving the exact bytes, including LF newlines and no BOM. Compute and retain its SHA-256 through the approved independent evidence channel. A digest delivered beside untrusted bytes does not authenticate those bytes.

To verify against an independently obtained inventory digest:

```text
node scripts/release/windows-candidate-digests.mjs verify PACKAGE EXPECTED_SOURCE_COMMIT INVENTORY EXPECTED_INVENTORY_SHA256
```

The command authenticates inventory byte identity against the supplied digest, then rehashes every regular payload file. It rejects changed, missing or additional files, case-folded path collisions, Windows reserved names, symlinks/junctions and hard-linked files. It treats the inventory as canonical bytes and never follows paths supplied inside it. It does not write the package or the inventory. Inventory, logs and receipts must remain outside the payload so their addition does not change candidate identity.

The inventory covers ordinary file data streams and relative file paths. It does not cover ACLs, NTFS alternate streams, external runtimes, empty directories, or filesystem metadata; use a clean reviewed extraction environment. The directory must remain quiescent. This is not protection against a concurrent malicious writer or a substitute for cryptographic authentication of an archive and trusted extraction. Deterministic inventory output for identical bytes is **not** evidence of independently reproducible compilation.

Successful verification always prints:

```json
{
  "byte_identity": "MATCH",
  "source_commit": "<the full expected commit>",
  "build_provenance": "UNVERIFIED",
  "authenticode": "UNVERIFIED",
  "windows_acceptance": "NOT_RUN",
  "release": "NO_GO"
}
```

These statuses are deliberate. A source field in manifest.json is a package claim. File hashes, including executable hashes, do not prove the claimed source built those bytes, identify a trusted publisher, establish valid PE files or verify Authenticode. The behavioral tests use inert binary placeholders and cannot constitute Windows installation acceptance.

## Remaining release gates

Obtain an immutable archive, archive SHA-256 and inventory; verify an approved build attestation that binds archive digest, exact source and expected workflow identity using an independently trusted verifier. Preserve the attestation verification result, actual checked-out revision (including a PR merge revision where applicable), workflow/run/attempt, lockfiles and compiler/SDK/tool versions. Repeat independent clean builds and compare the **unsigned executable** SHA-256 digests. A mismatch needs investigation; no reproducibility claim follows from a successful build alone. ZIP timestamps and signing can change archive or signed-executable hashes even when the reviewed unsigned payload is identical.

For a signed candidate, independently verify Authenticode trust and the owner-approved publisher under the approved timestamp/revocation policy, and record unsigned and final signed digests separately. This tool neither signs nor verifies those signatures. An unsigned candidate remains quarantined and cannot pass the public-release gate.

Then independently accept the exact immutable artifact in an approved disposable Windows environment: clean install, installed-byte comparison, stdio/six-tool behavior, operator-observed windowless execution and foreground coexistence, injected copy/task-registration failures with demonstrated rollback, uninstall/state retention, and reboot/reconnect using an isolated synthetic identity. Record unknown/fail/pass separately, with environment and observer identity and immutable evidence hashes. CI process/subsystem tests do not replace interactive observation. Four-device and VAULTER pre-login acceptance remain separate owner-controlled gates.

No part of this document authorizes a protected merge, release, signing operation, production relay/auth/OAuth/DCR change, live installation, worktree modification or task/terminal change. The existing `UNSIGNED_PUBLIC_RELEASE_BLOCKED` workflow remains mandatory.
