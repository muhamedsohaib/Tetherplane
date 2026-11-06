# Tetherplane brand-surface audit — 2026-11-06

## Scope and evidence
- Inspected 452 tracked files in the Leno Tetherplane source worktree at parent commit `6a3cde5`. Filtered possible logo/icon/toast/asset usage and inspected the actual extension and MSIX entrypoints.
- Current brand source commit on isolated branch `feature/brand-icon-unification-20261106`: `ced4095`, pending exact binary import.
- User-provided source images verified by SHA-256; originals and all 56 generated binary files plus exact-hash manifest in `Tetherplane-Exact-Logo-Pack-20261106.zip` (archive SHA-256 `c74daf86415f2a3178c69dbe3196ee454a37a2555dae5744949853bf3eb60ca9`).
- No live Tetherplane agent/existing Edge browser tab/credential/extension grant/Windows task was changed by this source-only work.

## Source surface matrix

| Surface | Source reference / finding | Source correction | Remaining proof |
| --- | --- | --- | --- |
| Edge toolbar and extension list | Manifest omitted icon metadata, causing platform fallback tile | Added 16/32/48/128 exact brand assets to `icons` and `action.default_icon` | Import PNG files; load/reload owner-pinned extension in Leno Edge; screenshot |
| Edge popup header | Blue CSS-drawn placeholder | Replaced with `icons/black-64.png` img; removed placeholder CSS | Import PNG, reload & visual compare |
| Edge extension package | `scripts/package-windows.ps1` copied manifest/html/dist but no icons | Includes `extension/browser/icons` copy; smoke checks every required size | End-to-end Windows package after assets imported |
| Windows setup window | No graphical icon/header mark | Added `brand-128.png` header, favicon `brand-32.png`, style | Runtime HTTP asset and screenshot tests after import |
| Windows setup HTTP serving | Only HTML/CSS/JS allowlisted | Explicit local image GET routes, PNG MIME, CSP `img-src 'self'` | Integrated runtime browser verification |
| Microsoft Store MSIX tile/logo | Store candidate expects externally owner-approved `Logo44/50/150.png` | Exact candidate tile exports `branding/windows/Logo44/50/150/300.png` | Separate owner approval of asset hash manifest, Store packaging, certification, signing |
| Windows classic icon / shortcut | No executable icon resource embedding in current code | Exact `branding/windows/Tetherplane.ico` created and copied with Windows package | Native PE icon resource embedding and signature verification **not yet implemented** |
| Windows toast app icon | No tracked native WinRT toast notification image implementation found | Exact branded notification-ready variants created | Actual notification implementation / native toast visual verification **not yet available** |
| Control Center logo/toasts (VAULTER) | Source frontend not tracked here; connected device VAULTER was unavailable | No cross-project mutation attempted | Access live VAULTER frontend source/release and verify actual toast assets |
| Other device installs (Surface, RTX, Vaulter) | Not available as authorized connected devices for this task | Source assets standardized only | Separate controlled build/install + screenshots per device |
| Historical Store artwork documentation | Older blue/halftone assets documented | Preserved history with 2026-11-06 supersession notes | Separate store review |

## Completed independent tests before binary import
- Windows PowerShell parser: 0 errors for modified package installer, Windows smoke test and both branding scripts.
- TypeScript extension: build/typecheck PASS.
- Store candidate + Store artwork tests: 19 PASS.
- Node runtime static parse PASS; staged diff whitespace check PASS.
- Full brand inventory and extension manifest file-hash tests **cannot pass until archive import**, and were not represented as passed.

## Hard release boundaries
Do not deploy, overwrite the currently installed owner-approved Edge extension, modify principal/OAuth/relay settings, run Store submission, or embed/re-sign a native EXE without the relevant owner-controlled release gate. Do not claim 'no inconsistencies anywhere' until live Control Center/Windows notifications, native executable resources and all installed-device surfaces are inspected. Source changes are reversible and isolated.
