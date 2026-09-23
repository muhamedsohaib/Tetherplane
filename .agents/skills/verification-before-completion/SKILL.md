---
name: verification-before-completion
description: Verification protocol for Tetherplane completion claims, commits, pushes, and releases. Use before saying a task is complete or publishing any Tetherplane work.
---

# Verification Before Completion

Never claim success because code was edited.

Never claim success solely because a tool said it made changes.

Obtain fresh verification evidence in the same execution turn.

## Before commit

Verify:

- intended targeted tests pass
- relevant subsystem tests pass
- build passes
- typecheck passes
- git diff --check passes
- diff contains only intended work
- no secrets are present
- no debug instrumentation remains unintentionally

## Before feature completion

Run the applicable repository gates.

Inspect repository plans/scripts for the authoritative gate list.

For browser work include:

- browser bridge tests
- extension tests
- extension typecheck
- extension bundle build
- generated bundle inspection
- live Chrome load
- live browser acceptance

For Rust include:

- cargo fmt --check
- cargo clippy
- cargo test

Use the actual repository scripts when they exist.

## Before release

A release candidate requires more than unit tests.

Verify live:

- local core
- remote plane
- browser plane
- persistence
- security/policy constraints
- human coexistence
- restart behavior

Do not create or push a release tag without explicit human approval.

## Reporting

Use:

Completed
Verification
Git state
Remaining work / blockers

If anything required is red, say exactly what remains red.