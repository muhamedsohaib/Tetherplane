# Tetherplane icon / logo distribution gate

**Owner designation — 2026-11-01:** The **only approved logo sources** are the four monochrome images supplied directly in the owner's latest Tetherplane conversation. These supersede previous visual descriptions and prior logo candidates. Preserve the four originals unmodified. Any proposed derivative must retain the exact emblem geometry and black/white appearance.

## Approved, source-hashed originals

| Design | Owner-supplied filename | Dimensions | SHA-256 |
| --- | --- | --- | --- |
| Textured emblem + wordmark | `Logo with word mark(1).jpg` | 2047×2048 | `4803a8d4c3565e58de5605dbcd44c18256117809ce9722aa4ebddc3bd33ffc3c` |
| Textured emblem | `Logo(2).jpg` | 1062×1062 | `ad09e637464a834fc36bf4e088d1aa767841c89e9f5bb07b6d6dc07f0b2f4f53` |
| Clean white-on-black emblem | `Gemini_Generated_Image_c8tp7c8tp7c8tp7c.jpg` | 2048×1143 | `c964d071774f67ec83b85207e5ff2511e441f3676b5d92893cffe974a74d0e12` |
| Clean black-on-white emblem | `Gemini_Generated_Image_di5utxdi5utxdi5u.jpg` | 2048×1143 | `bbc021833a1c1a0a52dc9014b6f65114c19ba4fffeb6a751923d720ffe8e9e72` |

The master images were verified against the exact uploaded file bytes. A separate **derived icon pack** containing these originals and aspect-preserving light/dark PNG icon sizes (16, 32, 48, 128, 256, 512 pixels) has been prepared in the owner's current ChatGPT artifact workspace, but **the files have not yet been committed to this GitHub branch or installed in a plugin**. Do not misrepresent staging as published branding.

### Canonical usage

- **Plugin icon/composer:** clean monochrome emblem PNG (black-on-white for light mode; white-on-black for dark mode), using only aspect-preserving resizing and background padding. Do not generate a new emblem or modify rods, angles, joints or proportions.
- **Wordmark/marketing:** owner-supplied wordmark source; never shrink the wordmark until illegible.
- **ASCII-textured emblem and wordmark:** use only as intentionally stylized media, not as the default small icon.
- **Source provenance:** preserve raw SHA-256 and the pixel-processing recipe; keep brand rights separate from source-code licenses.

## Distribution integration

1. **ChatGPT/Codex plugin:** package the actual square PNG assets under `assets/` and set `extensions.com.openai.interface.logo`, `composerIcon`, plus dark variants when supported, to **relative paths that exist inside the installed package**. Verify the actual private plugin card and composer, not merely the manifest.
2. **Browser extension:** package sizes 16/32/48/128, wire `icons` and `action.default_icon` in `extension/browser/manifest.json`, and ensure the extension staging workflow copies them.
3. **Windows packaging:** include immutable brand artwork in any installer/MSIX/shortcut implementation; inspect actual installed tiles and the Start menu where supported. Do not replace developer placeholders without install verification.
4. **MCP Registry:** where supported, publish icon metadata consistent with the packaged official assets, but do not depend on a remote URL as the only icon.
5. **Existing installed private ChatGPT plugin:** identify its actual existing app identity/manifest and update branding there; do **not** create a replacement OAuth client or application to solve an icon problem.

## Release-blocking validation

- Every image is traceable to one of the four exact uploaded originals, with matching SHA-256; check visual shape and black/white appearance.
- Every declared logo path exists inside the distributable artifact; CI rejects missing or substituted images.
- Required sizes, format, dimensions and light/dark contrast are checked.
- The owner can see the correct emblem in the installed plugin, browser extension and Windows package on clients that support icons. Where clients lack icon rendering, record the limitation honestly.
- Branding must not touch credentials, scopes, device identity, agent startup or Windows security.

**No universal icon-display guarantee:** We can guarantee bundled files and correct manifest wiring in supported clients; we cannot force third-party interfaces to render icons they don't support.

**Status:** Four approved sources verified; derived bundle prepared; GitHub binary integration and actual host acceptance still pending. Do not release an unbranded package as final.
