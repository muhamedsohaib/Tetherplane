# PR #130 reproducible Windows browser-companion quarantine

**Status:** Source/test infrastructure prepared. **No production package built or deployed by this document. Release: NO-GO.**

## Scope

The companion is **not** the core Tetherplane agent and not a Store-signed MSIX. The quarantined archive includes the existing native `tetherplane-browserw.exe` launcher, an independently signed upstream `node.exe` and its license, bundled `browser/host.mjs`, deployed browser-bridge runtime dependencies and compiled browser extension assets. No human browser profile, identity, credential, enrollment token, Windows security modification or owner opt-in is included.

The new Python standard-library tool `scripts/release/windows_browser_companion_candidate.py` stages a never-before-existing directory and emits a deterministic, uncompressed ZIP with fixed entry metadata, sorted paths and a SHA-256 inventory bound to a full Git commit identifier. It refuses symbolic links, reparse points, credential-like files, incorrect PE x64/GUI launcher identity, output overwrites, added archive entries and inconsistent bytes. Its `verify` operation reads the archive without extracting or executing binaries.

**Reproducibility assertion:** With the **same source commit and identical input binaries**, two successive archives are byte-for-byte identical. This does **not** establish bit-identical native compiler output between different toolchain versions or externally signed provenance. The Rust workspace currently specifies the floating `stable` toolchain; the build records the actual `rustc`, Node and archive SHA for audit.

## Isolated CI-only recipe

`.github/workflows/windows-browser-companion-quarantine.yml` is gated to pushes on the existing exact draft PR #130 source branch `fix/windows-native-crt-static-clean-install-20261102` in `muhamedsohaib/Tetherplane`; it does not widen the separately protected Store workflow allowlist. It requires a reviewed push of this recipe to that branch before GitHub can run it. It has **not been pushed or executed** by this preparation.

On an authorized Windows runner, the recipe:

1. Confirms the checked-out full SHA and executes the Python synthetic tests.
2. Uses Node 22 and pnpm 10.34.5 with the existing frozen lockfile, then builds the exact-source native binaries with the existing static-CRT script.
3. Verifies the Windows native CRT import closure, Node publisher signature and Node license.
4. Deploys the browser bridge and bundles the owner browser host from the exact checkout.
5. Stages the unsigned companion **twice**, verifies identical ZIP hashes and exact archive contents, then tests the native launcher and owner opt-in/revocation with temporary synthetic credentials/loopback ports.
6. Quarantines an explicitly unsigned, non-installable test ZIP and JSON evidence in GitHub Actions for one day. An independent Ubuntu job re-verifies the archive against the recorded source and SHA-256. Neither job signs, installs, enrolls a browser, deploys an agent, calls a live external site or publishes a release.

## Gates not satisfied

- **Unsigned compiled package:** NOT_BUILT at this checkpoint; Windows runner must execute and pass.
- **Signed Store MSIX / publisher trust / Smart App Control On clean host:** NOT_RUN.
- **Limited-token installed owner companion behavior:** NOT_RUN. Synthetic normal-owner private CDP succeeded on Leno but did not exercise the actual packaged native companion.
- **Owner grants, explicit origin/action TTL limits, immediate revocation, safe restart/rollback and four-device acceptance:** NOT_RUN on an installed package.
- **Protected merges or public releases:** Require explicit owner approval; none performed.

## Local review and portable test

Run the new unit tests without installing any browser:

```powershell
py -3.11 -m unittest discover -s tests/release -p test_windows_browser_companion_candidate.py -v
```

Inspect the staged package byte verifier:

```powershell
py -3.11 scripts/release/windows_browser_companion_candidate.py --help
```

Do not use test-fixture PE binaries as production binaries. The unit tests intentionally use synthetic PE headers solely to verify the gate behavior.

**Next physical gate:** An owner-authorized, installed candidate on an eligible limited-token Windows session; run browser grants/revocation/reconnect acceptance with source hash, no core disconnect, reversible cleanup and no secrets in logs. Until then the release remains **NO-GO**.
