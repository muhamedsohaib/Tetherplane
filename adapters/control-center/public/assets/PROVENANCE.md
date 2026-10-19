# User-supplied Tetherplane artwork provenance

Original assets provided by user, not generated substitutes. Local derivative images preserve exact logo and surrounding letter field. Public redistribution/license review remains pending.

| Asset | Original | Source SHA-256 | Installed SHA-256 |
| --- | --- | --- | --- |
| `wordmark-field.webp` | `Logo with word mark.jpg` | `13defcb9f9691089088657a0800d9cc4e153f12b525825c0adda5d2418b276e8` | `16ff3a5a2b5d71149039372afb7663830ec73aecf28928576514e033ae816a65` |
| `ascii/outer-field.webp` | crop `(100,100,612,612)` of `Logo with word mark.jpg`, outside emblem and wordmark | `13defcb9f9691089088657a0800d9cc4e153f12b525825c0adda5d2418b276e8` | `f122b6103bc8cb4e79026d568f78e7e83c2fa115d00c48c3a85196dfb7b909d7` |
| `ascii/1.png` | original ZIP `assets/1.png` | `80781aa42eaf8322149ab0e5f1b941a8a17777badccb53247542652a37cb062d` | `80781aa42eaf8322149ab0e5f1b941a8a17777badccb53247542652a37cb062d` |
| `ascii/2.png` | original ZIP `assets/2.png` | `476e00a9008e0801d91eba7b685a7c3f99bbd0fa8e0b1aa06e9a54276b0d1e24` | `476e00a9008e0801d91eba7b685a7c3f99bbd0fa8e0b1aa06e9a54276b0d1e24` |
| `ascii/3.png` | original ZIP `assets/3.png` | `231d538e8c6f3d6ed079b03b1fe785d92569debe522d5cef02882faffb9f6ec7` | `231d538e8c6f3d6ed079b03b1fe785d92569debe522d5cef02882faffb9f6ec7` |
| `ascii/4.png` | original ZIP `assets/4.png` | `a5097cc0a15e25c4f8952d320f1e581e99c7acc6973c087bd82cc2130b19839b` | `a5097cc0a15e25c4f8952d320f1e581e99c7acc6973c087bd82cc2130b19839b` |

Source ZIP: `tetherplane-ascii-loop-pingpong-museum-website.zip`.
Source animation: indices `[0,1,2,3,2,1]`; 700ms hold + 1300ms half-cosine fade; 12000ms period.
Conversion: Pillow LANCZOS source resize to 2048x2049 full image, WEBP q80 method6; outer tile is 512x512 direct source crop, WEBP q75 method6. Originals were not modified.

## Superseding canonical background — 2026-10-20

The user directly chose `ascii-art (16).txt` to replace the earlier composited JPG/WebP/tile and four-frame animated field.

- Canonical file: `ascii/approved-background.txt`, 400 × 460 characters, SHA-256 `62a3ea8172093100422ea4543694441caf93e4368794d9f4104851c07b601e6f`. `.gitattributes` applies `-text` to keep byte identity on Windows and Ubuntu.
- Web derivative: `ascii/approved-background.svg` renders a uniform plus-sign cell and 455 exact non-plus source-character runs. CI reconstructs all 460 original ASCII rows from the SVG and compares against the canonical text.
- Old `wordmark-field.webp`, `outer-field.webp` and four PNG frames remain archived within this feature branch but no longer appear on current screens.
- Same source rendering under the delayed static loading text. No animation and no second background layer.
- User approval is for this isolated frontend design; public redistribution/license permission remains unresolved.
