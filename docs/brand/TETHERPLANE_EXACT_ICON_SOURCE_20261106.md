# Exact supplied Tetherplane brand sources — November 6, 2026

Two user-supplied images supersede generic T/blue-outline placeholders for Tetherplane UI branding:

- Black transparent source: `branding/sources/logo-black-original.png`, SHA-256 `a68a4782baa855b2d58158e7a205802b875f64f84147c879a9b3d6e1c5677f09`.
- White-on-black source: `branding/sources/logo-white-on-black-original.jpg`, SHA-256 `c964d071774f67ec83b85207e5ff2511e441f3676b5d92893cffe974a74d0e12`.

Original source bytes remain unchanged. Exports use only transparent background extraction, crop/centering, proportional padding/resizing. See `branding/brand-asset-manifest.json` from the owner-supplied ZIP.

Mappings: extension manifest toolbar and Edge tile `extension/browser/icons/brand-{16,32,48,128}.png` (white mark on black); one-click popup header `icons/black-64.png`; Windows setup favicon/header `packaging/msix-store-runtime/app/assets/brand-{32,128}.png`; Store tile source `branding/windows/Logo{44,50,150,300}.png`; native icon candidate `branding/windows/Tetherplane.ico`; toast-ready assets `branding/notifications/`.

The original owner ZIP `Tetherplane-Exact-Logo-Pack-20261106.zip` must be imported into this isolated review branch before running `node --test tests/release/brand-icon-inventory.test.mjs` and rebuilding packages.

The MSIX approved-assets file and signed binaries remain separately gated. This patch does NOT sign/publish a Store package, alter OAuth/credentials/grants, change the installed extension, overwrite the agent, or deploy Control Center. VAULTER was not reachable through the current Tetherplane connector, and its UI toast/front-end source is not tracked in this repository. Those live surfaces require separate evidence before a global visual-consistency claim.
