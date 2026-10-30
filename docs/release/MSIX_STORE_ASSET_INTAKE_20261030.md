# Tetherplane Store image intake — isolated review-only workflow (30 October 2026)

**Release and Store submission: NO-GO.** This is a source-asset preparation procedure only, stacked on draft PR #109. No publisher identity changes, signing, Store upload, actual device install or production runtime mutations.

## Source provenance and approval

The earlier owner-approved black/crimson logo exists in prior design work but **its exact original file bytes were not accessible** in the current development workspace. The available 1254×1254 blue-accent image and halftone/JPEG variants are **not** approved sources and must not be recolored, guessed, or silently substituted.

The approved icon needs to be an emblem-only, square, high-resolution transparent PNG; do not include the wordmark in the square MSIX tiles. Resizing must be a purely mechanical high-quality RGBA transformation of owner-supplied bytes. It must not reconstruct or redesign the mark.

1. Obtain the exact finalized original emblem-only PNG from the owner and record the source SHA-256 outside the repo.
2. On a Windows review workstation with .NET System.Drawing available, run (replace the example paths and hash with real values):

   ```powershell
   $hash = (Get-FileHash -LiteralPath 'C:\Approved\Tetherplane-Emblem-Crimson.png' -Algorithm SHA256).Hash
   .\scripts\msix-store\Prepare-StoreArtwork.ps1 -SourceEmblem 'C:\Approved\Tetherplane-Emblem-Crimson.png' -ExpectedSourceSha256 $hash -OutputDirectory 'C:\Approved\Tetherplane-Store-Review'
   node .\scripts\msix-store\verify-store-listing-assets.mjs --source 'C:\Approved\Tetherplane-Emblem-Crimson.png' --assets-dir 'C:\Approved\Tetherplane-Store-Review' --evidence 'C:\Approved\Tetherplane-Store-Review\asset-evidence.UNAPPROVED.json'
   ```

   The above is an **example only** and is not a command guaranteed to work on all machines. Test it on the actual authorized review machine; do not run it against existing installs. The exporter refuses a non-square or opaque source, a mismatched source hash, and any pre-existing output directory. All staging is new and isolated.
3. Inspect the resulting `Logo44.png` (44×44), `Logo50.png` (50×50), `Logo150.png` (150×150), and optional `Logo300.png` (300×300 Store tile) **at actual pixel size on light and dark backgrounds**. The metadata-only verifier cannot establish visual correctness or catch all malformed PNG content.
4. The output includes `asset-evidence.UNAPPROVED.json`, which deliberately has `owner_approval_reference: null` and disposition `UNAPPROVED_SOURCE_TRANSFORM`. **It is NOT** the `tetherplane.store-approved-assets.v1` manifest required by `Build-StorePrivateCandidate.ps1` owner mode. Nothing is automatically promoted.
5. Only after actual owner review, create the separate approved-assets manifest *outside* the Git repo with the three MSIX hashes and an independent real owner review reference. Do not invent an approval reference; do not upload the logo source or private approvals to public GitHub CI.

## Real desktop screenshot capture

**Not captured in this PR.** A real screenshot can only be recorded from an explicitly authorized disposable Windows 11 desktop running the actual owner-review app (or eventual certified Store build). We do not install the unsigned MSIX on a production owner device and do not fabricate screenshots with a mockup or AI-generated connection states.

- Minimum **1366×768 PNG**, max **50 MB** for Windows desktop. A 1920×1080 capture is a useful target if genuinely produced by the app.
- Show the **unpaired onboarding form** only. Do not display the relay endpoint, user paths, device IDs, pairing secrets, OAuth codes, account names, session URL tokens, or credentials; capture before typing any of them. Close or exclude desktop notifications and unrelated private content.
- Do not claim that the agent is online merely because the form is visible. Never put overlays or claims of a successful connection on the screenshot.
- Use `node scripts/msix-store/verify-store-listing-assets.mjs --source ... --assets-dir ... --evidence ... --screenshot ... --require-screenshot` for *only* byte, dimension and size checks. It **never** verifies screenshot authenticity or privacy. A human must independently review both before any Store submission.
- Keep screenshot file bytes, source SHA-256, operator capture evidence, package commit, app version and privacy review privately with the owner. No screenshot, image, executable or secrets are attached to the public pull request or GitHub Actions artifacts.

Microsoft reference: https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/screenshots-and-images

## Independent verification and limits

- `node --test tests/release/msix-store-artwork-preflight.test.mjs` tests metadata constraints, hash drift, forged approval rejection, screenshot dimensions and missing-screenshot refusal without external packages.
- `.github/workflows/msix-store-artwork-preflight.yml` runs only on same-repository draft review branches; Ubuntu runs the contract suite, Windows creates a deliberately synthetic transparent fixture to exercise actual GDI+ resizing/PNG/hash output. The CI output never uses the actual logo, creates owner approvals, uploads graphics or builds an app package.
- A green CI run does not prove the final logo bytes, genuine screenshot, privacy policy, Store-account eligibility, Store MSIX signing, Smart App Control, rollback or four-device acceptance.

**Next external dependency:** Microsoft support case `2610290010001747` must clarify the Individual publisher identity. Do not change `ARCUSLabs.Tetherplane` or the existing publisher CN while the ticket is open.
