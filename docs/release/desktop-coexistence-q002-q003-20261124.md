# Desktop coexistence containment - Q002 / Q003

Date: 2026-11-24. Source-only review; NO_GO. Live Leno agent v0.1.0, executable SHA-256 A9CCF5180C164883272DF5C3308D842C2EFE36FC861821E7C3CD55239D1F08DC (source provenance unknown).

Q002: WPF checkbox Toggle returned action_unverified, fixture logged unexpected activation and closed, no receipt. Q003: WPF tree Expand returned action_unverified, fixture logged unexpected activation and closed, no selection receipt; Select never attempted. Both restored the previously observed foreground PID. These observations are not conclusive proof of causality. The user independently reported seeing the invoice navigator window. No further visible fixtures may be opened on a human-used production desktop.

Source inspection: semantic dispatch used ? before the final foreground check, so provider errors skipped that check. Toggle/Expand/Collapse had no equivalent unfocused-action guard; a framework pattern is not proof of nonactivation. Generic error advice encouraged retrying uncertain mutations.

Containment: reject focus-sensitive Toggle/Expand/Collapse before dispatch unless the target was already foreground and focused; this deliberately restricts unverified background functionality, not a new grant or certification. Always check observed foreground after dispatch, including failures; preserve uncertainty and avoid automatic replay. Endpoint checks do not detect all transient activations. The full product needs event-level or isolated-desktop verification, evidence for each native pattern and real background acceptance. No protected live changes.

Release gate: exact-candidate CI, isolated Windows guest, physical-device acceptance, visual coexistence and verified recovery remain required. Do not run the staging harness on production devices. Regression reruns Q002/Q003 only after a fix, separately linked and not counted as new coverage.
