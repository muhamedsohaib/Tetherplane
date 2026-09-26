# Tetherplane Source of Truth

Canonical repository:
https://github.com/muhamedsohaib/Tetherplane

The GitHub repository is canonical. Local checkouts and device names are
deployment details, not protocol authorities. The protocol supports multiple
devices; the relay resolves a requested device within the authenticated
account and the local agent makes the final execution decision.

Authority order:

1. Current repository implementation and tests
2. docs/superpowers/specs/2026-09-17-tetherplane-design.md
3. docs/superpowers/specs/2026-09-19-tetherplane-model-neutral-control-plane.md
4. docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md
5. docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md

Current ChatGPT integration status and the acceptance procedure are in
`docs/integrations/chatgpt.md`. A local checkout or private plugin is not
evidence that the remote service or ChatGPT connection is live.

Historical proposals, chat summaries, screenshots and external research are
non-canonical unless incorporated into one of the documents above.

For current implementation status, inspect Git directly.
Do not infer current branch/task completion from Project memory or old chats.
