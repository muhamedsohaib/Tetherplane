# Tetherplane Store image intake — isolated review-only workflow (30 October 2026)

**Release and Store submission: NO-GO.** This is a source-asset preparation procedure only, stacked on draft PR #109. No publisher identity changes, signing, Store upload, actual device install or production runtime mutations.

## Canonical owner-selected source assets and approval

On 30 October 2026, the owner identified **`Logo.jpg` (1062×1062, emblem only)** and **`Logo with word mark.jpg` (2639×2640, full logo)** as the exact final Tetherplane artwork. Both are **monochrome/halftone JPEGs**, with their original opaque background deliberately retained. They supersede the earlier unverified black/crimson source requirement. No recoloring, background extraction, 3-D reconstruction or redraw is authorized.

Use `Logo.jpg` as the source for the square Windows app/MSIX tile images (44×44, 50×50, 150×150) and optional Store tile (300×300). Use `Logo with word mark.jpg` for separate branding/listing media **at a size where the text remains legible**; do not shrink the wordmark into tiny app icons. There is no requirement to produce transparent artwork from these JPEGs. **Do not commit the owner's source JPEG bytes or source-derived final logos to this public Git branch.** Keep them local until the owner approves their specific distribution.

1. Obtain the exact two JPEG files from the owner-controlled input folder and independently record their SHA-256 hashes outside the repo. Do not substitute older blue/accent variants or use filename matching as proof of content identity.
2. On an authorized disposable Windows review machine, execute the exporter with the **actual emblem JPEG's SHA-256**. For illustration only, paths here are placeholders (do not assume the files are at these locations):

   ```powershell
   $source = 'C:\Path\To\Logo.jpg'
   $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
   .\scripts\msix-store\Prepare-StoreArtwork.ps1 -SourceEmblem $source -ExpectedSourceSha256 $hash -OutputDirectory 'C:\Path\To\A-New-Review-Directory'
   node .\scripts\msix-store\verify-store-listing-assets.mjs --source $source --assets-dir 'C:\Path\To\A-New-Review-Directory' --evidence 'C:\Path\To\A-New-Review-Directory\asset-evidence.UNAPPROVED.json'
   ```

   Do not run from an unverified working directory or over an existing output. Windows must actually run the command successfully; isolated CI passes are not a substitute for owner-machine verification. The exporter refuses mismatched hashes, unsupported formats, non-square emblem input, and any existing destination. It accepts verified opaque JPEGs or genuinely transparent PNGs, maintaining the respective backgrounds without modification beyond mechanical resampling.
3. Inspect **at native pixel size** the generated `Logo44.png`, `Logo50.png`, `Logo150.png`, and `Logo300.png` on both light/dark Windows backgrounds. At 44×44 a halftone image will be averaged by resampling; the emblem must remain recognizable. A review preview from the accessible JPEG shows the emblem remains discernible at these dimensions, but that is **not** owner approval of final hashes.
4. The output includes `asset-evidence.UNAPPROVED.json` with schema `tetherplane.store-artwork-preflight.v2`, `source_format: jpeg_opaque`, disposition `UNAPPROVED_SOURCE_TRANSFORM` and `owner_approval_reference: null`. It is **not** the `tetherplane.store-approved-assets.v1` manifest required by the actual Store MSIX packager. After owner approval of the **exported PNG bytes and hashes**, prepare the separate reviewed approval record outside GitHub; no agent may fabricate approval or attach these files to a public CI artifact.
5. The wordmark JPEG remains separate: check the exact source hash, legibility and Store image suitability independently. It is **not** an input to the 44×44 icon exporter.

## Real desktop screenshot capture

### Disposable Windows browser-render proof (source, NOT the Store install)

The dedicated `tests/release/msix-store-unpaired-ui.test.mjs` test starts the **actual source wizard** from a scratch-only copy transformed by the reviewed Store overlay. It uses a brand-new empty state directory and a localhost-only HTTP server, confirms `idle`/`not_verified` with no saved identity, and captures the page viewport using an actual Edge/Chrome headless process. It checks desktop PNG dimensions and deletes the screenshot and browser profile in the same disposable Windows CI run. It never enters relay addresses, starts pairing, spawns the agent, uploads pixels, or touches an owner device. A missing browser, failed rendering, or a runner mismatch is a **test failure**, not a simulated pass.

**This checks UI render/capture mechanics; it is NOT a Store-installed screenshot, private owner capture, Smart App Control acceptance or proof of device connectivity.** Do not promote the discarded screenshot to Partner Center. An actual Store submission still requires separately authorized capture, visual/privacy inspection, and owner review.



**Not captured in this PR.** A real screenshot can only be recorded from an explicitly authorized disposable Windows 11 desktop running the actual owner-review app (or eventual certified Store build). We do not install the unsigned MSIX on a production owner device and do not fabricate screenshots with a mockup or AI-generated connection states.

- Minimum **1366×768 PNG**, max **50 MB** for Windows desktop. A 1920×1080 capture is a useful target if genuinely produced by the app.
- Show the **unpaired onboarding form** only. Do not display the relay endpoint, user paths, device IDs, pairing secrets, OAuth codes, account names, session URL tokens, or credentials; capture before typing any of them. Close or exclude desktop notifications and unrelated private content.
- Do not claim that the agent is online merely because the form is visible. Never put overlays or claims of a successful connection on the screenshot.
- Use `node scripts/msix-store/verify-store-listing-assets.mjs --source ... --assets-dir ... --evidence ... --screenshot ... --require-screenshot` for *only* byte, dimension and size checks. It **never** verifies screenshot authenticity or privacy. A human must independently review both before any Store submission.
- Keep screenshot file bytes, source SHA-256, operator capture evidence, package commit, app version and privacy review privately with the owner. No screenshot, image, executable or secrets are attached to the public pull request or GitHub Actions artifacts.

Microsoft reference: https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/screenshots-and-images

## Independent verification and limits

- `node --test tests/release/msix-store-artwork-preflight.test.mjs` tests metadata constraints, hash drift, forged approval rejection, screenshot dimensions and missing-screenshot refusal without external packages.
- `.github/workflows/msix-store-artwork-preflight.yml` runs only on same-repository draft review branches; Ubuntu runs the contract suite, Windows creates deliberately synthetic transparent PNG **and opaque JPEG** fixtures to exercise actual GDI+ decoding/resizing/PNG/hash output. The CI output never uses the actual logo, creates owner approvals, uploads graphics or builds an app package.
- A green CI run does not prove the final logo bytes, genuine screenshot, privacy policy, Store-account eligibility, Store MSIX signing, Smart App Control, rollback or four-device acceptance.

**Next external dependency:** Microsoft support case `2610290010001747` must clarify the Individual publisher identity. Do not change `ARCUSLabs.Tetherplane` or the existing publisher CN while the ticket is open.
