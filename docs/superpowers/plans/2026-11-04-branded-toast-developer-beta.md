# Branded toast developer-beta preparation

Scope: use the two owner-supplied monochrome JPEGs exactly, with proportional
resizing and background padding only. Preserve originals and record SHA-256.
No generated replacement artwork, signing, MSIX, Store, identity-policy changes,
production-agent changes, merge, tag or publication.

1. Confirm previous handoff and automation evidence; inspect clean isolated branch.
2. Establish failing tests for multi-resolution ICO assets and shortcut icon identity.
3. Generate both icon variants reproducibly; wire the default icon into the
   reversible per-user beta shortcut and test-kit packaging.
4. Verify asset decoding, registration/status/idempotency/foreign-shortcut refusal
   and cleanup. Exercise pinned native CI binaries in synthetic loopback only.
5. Inspect security/reconnection tests and collect fresh four-device status without
   changing production agents or deliberately disconnecting real devices.
6. Independently review the patch; prepare a local candidate, checksums, onboarding,
   rollback and explicit GO/NO-GO evidence. Missing gates remain NO-GO.

Release gates include current-source build/CI, actual branded Notification Center
display, clean authorized-machine onboarding, four-device operation/reconnection,
denial boundaries and independent recovery. Historic test results are supporting
evidence only. Publishing and protected changes need separate precise approval.
