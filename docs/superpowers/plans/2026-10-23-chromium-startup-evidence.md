# Chromium startup failure investigation

Execute against PR #52 `e35782baaa7cd0ec12c9e01bae96af2f44c55378`, stacked on #50 and #49. Preserve the B6 12-second endpoint deadline, 30-second test deadline, five-second download deadline, local policy, six tools and four-device architecture. No retry, protected merge, release, installation or production configuration change.

1. Compare original exact-head Actions, preserving original RED results and runner metadata. Baseline the isolated source.
2. RED: real failed launch must report sanitized executable selection/version, profile, spawn/exit/close, bounded stderr categories, endpoint state and cleanup; errors must not include arbitrary paths or stderr. GREEN: opt-in diagnostics with fixed fields and bounded buffers. No raw command lines or URLs.
3. RED: signalled exit must fail promptly; a zero-code launcher handoff or living child without endpoint must retain its deadline. GREEN: distinguish failed children and unreadable/malformed/missing files. Test with disposable real child processes and profiles, including late endpoint and flooded/split stderr. Local Edge evidence required retaining zero-code launcher handoff; endpoint and CDP readiness remain mandatory.
4. Run the complete browser suite, workspace TypeScript gates and five isolated B6 trials. Make hosted CI retain sanitized trial receipts even on failure; every failure remains fatal. Obtain independent source review and tests.
5. Push a separate draft stacked on #52, run hosted Windows verification, record exact source/tree and artifacts in the repository. Investigate any demonstrated cause with a new RED regression before a minimal fix.
6. Inspect Leno status/network path using currently allowed read-only operations and inspect Vercel deployment metadata. Document actual boundaries and remaining acceptance gates.

Review focus: diagnostic callbacks cannot change launch outcomes; no path/credential echo from spawn/profile errors; stderr floods drain without unbounded memory or timers; signal/exit-zero cannot become readiness; failed cleanup cannot pin the test; hosted trial failure cannot become a green retry.

Execution authorized by the user's detailed request; implement directly and use one independent reviewer. This plan records that request, without an additional plan-approval pause.
