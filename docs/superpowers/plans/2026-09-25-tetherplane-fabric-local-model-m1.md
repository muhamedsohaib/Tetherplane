# Tetherplane Fabric + Local Model Milestone 1

**Date:** 2026-09-25
**Branch:** `feature/fabric-local-model-m1`
**Base:** `feature/production-relay-m1` at `8a6a08b`

## Goal

Make local intelligence an always-available Tetherplane controller without adding a seventh MCP tool or weakening local policy. A remote client such as ChatGPT can create a durable job on a target device; an always-on local worker on that device can discover only jobs permitted to its authenticated principal, acquire a lease, execute bounded model-selected canonical operations, checkpoint observable progress, and release the lease.

This milestone is deliberately local-first. The model endpoint may live on the same machine or another owner-controlled machine, but the worker opens no inbound control port and executes only through the launch-bound local `tetherd` principal.

## Invariants

- Local `tetherd` remains final authority.
- Six default MCP tools remain unchanged.
- Model output cannot assert principal identity, approvals, leases, or policy overrides.
- Job leases coordinate execution but never widen capability grants.
- Worker never stores chain-of-thought/private reasoning.
- Worker does not execute a model-selected action for a different job or target device.
- Model API keys, if needed, are read only from an explicitly named environment variable.
- No raw credentials enter Git, logs, CLI arguments, or persisted checkpoints.
- One worker failure must not corrupt the durable job record.
- Human coexistence and foreground-lease rules remain unchanged.

## Task F1 — Discoverable jobs

Add canonical `job.list` and compact `device op=job_list`.

Contract:
- requires authenticated principal and explicit `job.list` grant;
- returns only jobs whose `permitted_principals` contains the bound principal;
- prunes expired leases before returning records;
- supports optional bounded `limit`, `status`, and `unleased` filters;
- never leaks inaccessible job identifiers or objectives.

TDD:
1. RED Rust test for principal-filtered listing.
2. RED Compact MCP translation/schema tests.
3. GREEN minimal provider + schema/translation implementation.
4. full gates.

## Task F2 — Always-on model worker core

Add a worker in `@tetherplane/model-client`.

One polling cycle:
1. call `job.list` for accessible, unleased non-terminal jobs;
2. acquire a bounded execution lease;
3. call the configured OpenAI-compatible model for one canonical action at a time;
4. reject any action targeting another job/device;
5. submit actions with the active job ID;
6. feed only bounded structured results/checkpoint state back as model context;
7. stop on a terminal checkpoint (`completed`, `blocked`, `cancelled`) or action limit;
8. always release the lease in `finally`.

TDD:
- no jobs => no model call;
- inaccessible jobs are never returned by the agent;
- lease conflict => skip without model action;
- cross-job/cross-device model output => rejected before execution;
- denied capability is returned to model context but not bypassed;
- terminal checkpoint releases lease;
- model/transport failure releases lease;
- max-action guard prevents runaway loops.

## Task F3 — Worker service CLI

Add a background-safe CLI entry point.

Required configuration:
- model endpoint;
- model name;
- `tetherd` path;
- principal profile path;
- state directory;
- optional allowed roots;
- poll interval;
- optional API key environment-variable name.

Requirements:
- no secrets as CLI values;
- bounded reconnect/backoff;
- clean SIGINT/SIGTERM shutdown;
- Windows hidden/background compatibility;
- no foreground UI.

## Task F4 — Device-fabric deployment contract

Document/install one worker per device, each with a device-scoped principal profile. A single owner-controlled model endpoint may serve many workers; each worker remains constrained by its own local policy.

A remote client assigns work by creating a job on the target device through the existing `device` tool. No central scheduler is required for Milestone 1.

## Deferred to next milestone

- central cross-device scheduler / placement;
- worker health surfaced through relay presence;
- automatic model selection;
- self-hosted OAuth authorization service;
- public ChatGPT plugin submission.

The self-hosted OAuth service is the immediately following milestone and will use a standards implementation rather than custom OAuth cryptography.
