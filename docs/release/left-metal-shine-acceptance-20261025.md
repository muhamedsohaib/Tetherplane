# Tetherplane — left metallic plate shine correction (2026-10-25)

## Defect and intended geometry
Owner explicitly rejected both the original visibly misplaced star-region shimmer and the subsequent incorrect right-side metallic shimmer. The accepted target is the solid upper-left metallic plate.

Inspection of the immutable 400-column ASCII glyph data shows that the left upper arm consists of the first contiguous '#' run on source rows 211–228 and the second contiguous '#' run on rows 229–230. The '*' glyphs on rows 231–257 are the lower-left shaded interior, not the metal plate. The right metallic face and supports must not shimmer.

## Source-only implementation
On isolated branch fix/control-center-left-plate-shimmer-20261025:
- tools/correct-left-plate-shine.mjs checks the exact privately approved original HTML checksum and emits a distinct new output, never modifying the input or publishing the private HTML.
- test/left-plate-shine.test.mjs verifies every animated glyph against the original exact left-side run and excludes all other faces, shades and supports.
- Change is limited to upper-left '#' mask, wave progression, local flow-canvas bounds, baseline wave opacity, glyph used in both theme overlays, and inline explanatory comments.
- Original ASCII artwork arrays, page geometry, CSS, dark/light transition, buttons, front-end integration script and backend are not edited.

Original private HTML SHA-256: 36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82
Corrected private HTML SHA-256: c6af06aea797cd51b9f2eef82262b6a4731b7c6c5dde766cb8c0421d878946cb

## Test evidence
- TDD RED: four new tests failed against the no-op/old animation.
- TDD GREEN: four new tests passed after the focused correction.
- Complete current Control Center test suite: 28 passed, 0 failed.
- Original-artwork integrity verifier: passed.
- Geometry tests include 1728x960 at DPR 1 and 1.25, 1366x768 at DPR 1 and 1.75, 1920x1080 at DPR 2, and 390x844 at DPR 3.
- Isolated Microsoft Edge 1728x960 dark-mode preview created on Leno; a second phase screenshot generated independently. Sampling at 2-pixel spacing with RGB threshold 36 showed:
  * Upper-left metallic plate: 605 changed samples.
  * Right metallic plate: 0 changed samples.
  * Lower-left shaded interior: 0 changed samples.
  * Top pole: 0 changed samples.
  * Empty background: 0 changed samples.
This is a direct independent animation-localization check. Light theme rendering paths are structurally unchanged and exercised by source geometry tests; a separate live light-mode visual acceptance should still be obtained.

## Live deployment constraints
Only replace the installed VAULTER Control Center public/index.html after verifying pinned original, OAuth server hash, front-end integration script hash, scheduled-task state and loopback listener. Preserve a uniquely named exact original rollback; do not modify relay, OAuth configuration, grants, device credentials, agent policies or Windows privileges. Verify served HTML has left metallic mask and no outdated star/right mask, and that HTTP and anonymous 401 checks still pass.

The rejected right-face change in local commit 53007f8 is specifically excluded. No public release, protected authentication change or merger is authorized by this private visual correction.
