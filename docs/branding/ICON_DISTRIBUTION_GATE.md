# Tetherplane icon / logo distribution gate

**Status: BLOCKED ON THE APPROVED ORIGINAL IMAGE BYTES. Do not publish unbranded or substitute synthetic placeholder imagery.**

## Approved identity

The owner-approved artwork is a precise black geometric four-tether/plane mark with a **crimson-red side strip**, no central cross or altered rods. Prefer the **emblem-only** artwork for small icons; use the full wordmark for README, marketing and screenshot material. **Never recreate or recolor a different source as an alleged exact match.**

Relevant owner Library images (visually inspected on 2026-11-01):

- `Tether Plane Minimal Logo.png` — black/crimson on white, includes wordmark.
- `Tether Plane Logo Emblem.png` — black/crimson plus wordmark on a transparent-style image.

The actual PNG bytes could not be materialized from the available Library reference. The older local `tetherplane-publisher-review-kit.zip` contains a **monochrome**, different logo and tiles; its image bytes must **not** be promoted as approved artwork. The repo branch currently has no PNG/SVG/ICO logo assets.

**Blocking dependency:** obtain the approved original file as a local raw PNG/SVG, retain its source SHA-256 and visual review, then mechanically extract/rescale the emblem without changing its proportions, crimson strip or geometry. No generative replacement.

## Package-specific requirements

### ChatGPT/Codex portable plugin

In the distributed plugin package (not a README-only image), keep:

- `plugin.json` with `extensions.com.openai.interface.composerIcon: "./assets/composer-icon.png"` and `extensions.com.openai.interface.logo: "./assets/logo.png"`.
- `./assets/composer-icon.png` and `./assets/logo.png` as actual bundled PNG image files, each **square**, at least 48x48 pixels and at most 4096x4096, 5 MiB.
- Optional dark-theme variants referenced via `composerIconDark` and `logoDark`; prefer versions with contrast verified in both themes.
- `assets/branding-provenance.json` recording each final file SHA-256, the original approved-source SHA-256, source name, approved master revision and transformation steps. This ensures icon files cannot be silently replaced with CI placeholders.
- Test the installed plugin's card and composer in a real supported ChatGPT/Codex client; plugin manifests alone do not control every host's rendering.

An existing private ChatGPT app/plugin may have **separate dashboard branding** outside this repository. Inspect and update that exact app identity before claiming that existing installations show the icon. Do not make a replacement OAuth client or new app.

See the authoritative [OpenAI plugin packaging requirements](https://developers.openai.com/plugins/deploy/submission) for icon sizes and manifest locations.

### Browser extension

Add immutable PNG icon assets at 16/32/48/128, reference them in `extension/browser/manifest.json` under `icons` **and** `action.default_icon`, and ensure `scripts/package-windows.ps1` includes them in the unpacked extension payload. Verify the installed icon in Edge's extensions UI. Do not change extension ID, owner pinning, tab permissions or pairing automatically.

### Windows installer / MSIX (future optional packaging)

Supply exact `Assets\Logo44.png`, `Logo50.png`, `Logo150.png` in both relevant MSIX staging layouts; verify the pixels/hashes in the packaged artifact and actual Start menu after a clean authorized install. The existing development MSIX uses disposable placeholders and **must not** be presented as a branded/signed release. For portable Windows installs, include discoverable `assets/logo.png` and an installer/shortcut icon where the packaging format supports it.

### MCP registry

After a genuine distribution build exists, supply supported HTTPS icon URLs in the published `server.json.icons` metadata with correct MIME and size; do not rely on a remote URL as a substitute for the bundled plugin assets. The schema makes icon rendering optional for clients.

## Release-blocking acceptance

A public or installable branded package is **NO-GO** until all of these pass:

1. Original approved-source SHA-256 and ownership/provenance documented; visual comparison confirms no changes to geometry/colors.
2. Icon files copied into the actual packaged distribution; each referenced path resolves inside the package and matches SHA-256.
3. CI fails on any missing icon, non-square image, unexpected file, omitted dark/light branding when declared, or substituted test placeholder.
4. Fresh-install inspection of the plugin card, composer, browser extension toolbar and Windows tile/shortcut where supported. Explicitly note clients that do not show icons.
5. No new startup, identity, permissions, OAuth/DCR or platform-security bypass introduced merely for branding.

**Limit of guarantee:** We can ensure packages contain correctly referenced, tested icon assets and supported host UIs show them. We cannot guarantee every third-party client renders a logo in every surface or offline/cache condition.
