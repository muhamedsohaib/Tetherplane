# Store integration for reviewed zero-console Windows candidate

**Date:** 2026-10-30. **Status:** DRAFT; RELEASE NO-GO.

## Previously completed (do not repeat)
- Leno's unsigned legacy canary: authenticated AC/battery operation, reconnect
  after sign-in/reboot without browser startup dependency; real Windows 11
  Smart App Control has previously blocked unsigned `tetherd.exe`.
- Parent PRs #113/#114: exact-head Windows/Ubuntu and release-policy CI passed,
  including packaged GUI-subsystem agent, windowless owner-browser and optional
  model-worker synthetic process/child checks. Headless CI is not physical
  desktop observation.
- Earlier PR #107: independent unsigned archive and cleanhost proof. Earlier
  Store PR #109: separate synthetic Store preview with owner approval, relay,
  six-tool listing, stranger denial and native reconnect. Neither exercises
  the integrated zero-console branch.

## Additional exact-head acceptance
The private Store workflow only admitted branches starting
`feature/msix-store-private-candidate-`, so it was SKIPPED for PR #114. This
change allowlists **only** the existing, internal review branch
`fix/windows-zero-console-model-worker-20261030` in both Store jobs, the `-CiValidationOnly`
builder and the real native-agent relay regression. All existing safeguards
remain: same-repository pull_request, hosted Windows worker, read-only token,
no signing/trust-store mutation, no real device, no install, no real artwork,
no uploaded .msix, no release or protected branch change.

Successful CI must compile the complete current checkout, exercise actual
native-agent/relay synthetic owner approval, six-tool surface, other-account
denial, reconnect and revocation, and build/unpack/discard a synthetic-artwork,
UNSIGNED Store identity package. Retain only a JSON report that states SAC-On
and Store signing NOT_RUN.

**Pass does not prove:** Store publisher eligibility, certification, trust,
physical Windows 11 SAC-On admission, no real foreground windows, signed
install/upgrade/rollback or four-device release acceptance. Those remain
explicit separate gates, requiring an authorized trusted-signed build and
operator approval. No private certificates or identities are created.
