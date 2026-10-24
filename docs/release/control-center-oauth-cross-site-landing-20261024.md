# INTERNAL: OAuth redirect landing bug (2026-10-24)

Branch: fix/control-center-cross-site-return-20261024
Base: 72c4e2b6714719d84166d2e8b31cf64d1fd169ad

Observed: after successful paired-device approval, the browser showed origin_denied at http://127.0.0.1:8791/.
Cause: OAuth callback issues 303 to /, preserving a cross-site Fetch Metadata context. Base ExactPortal rejected cross-site even for public top-level GET /.
Live reproduction: address-bar GET / = HTTP 200; redirected cross-site document GET / = HTTP 403.

Isolated correction: permit only exact public GET / with navigate/document Fetch Metadata, absent Origin and correct numeric Host. All APIs, POST, wrong hosts and foreign Origins remain guarded.
RED: new OAuth callback navigation test failed (403 instead of 200).
GREEN: npm test 21/21 passed; Node syntax and git diff checks passed.
Artifact verification: approved ignored HTML copied only to isolated test worktree; exact SHA-256 36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82 verified.

Live workaround: Ctrl+L, manually type http://127.0.0.1:8791/, Enter. Actual session existence must be confirmed by owner browser.
PRODUCTION UNCHANGED; no token, credential, OAuth registration, device grant, pairing, or provider configuration changed.
Hold deployment pending explicit approval for protected authentication-facing origin-guard change.