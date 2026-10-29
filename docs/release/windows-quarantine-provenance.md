# Isolated unsigned Windows provenance gate

This draft branch tests provenance only. It does not sign, release, tag, merge into protected branches or install on Surface, Leno, RTX or VAULTER.

The Windows job checks out its exact push SHA, builds and packages the real unsigned Windows runtime, records an out-of-package SHA-256 inventory, verifies staged and ZIP-extracted contents, and records an archive SHA-256. GitHub Actions attests that exact archive. An independent Ubuntu job downloads its short-lived GitHub Actions artifact and verifies the downloaded hashes and GitHub/Sigstore SLSA provenance using the exact repository, signer workflow, branch ref and commit. It denies self-hosted-runner provenance.

The artifact is labeled `UNSIGNED-DO-NOT-INSTALL`, with 1-day retention and no release, publication or installation step. **The source repository is public: GitHub Actions artifacts may be accessible to others. Never include credentials or confidential data.**

A passing job establishes a cryptographically verifiable workflow/commit/artifact relationship, not reproducible builds, a trusted publisher, a Windows Authenticode signature, safe rollback, interactive windowless/coexistence acceptance or four-device acceptance.

Release remains **NO-GO**. The independent trusted review and approved signing policy remain required before any live migration or public distribution. Existing `.github/workflows/release.yml` remains the fail-closed unsigned-publication block. 
