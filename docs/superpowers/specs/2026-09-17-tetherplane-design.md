# Tetherplane — Canonical Architecture & Product Design

**Status:** Design candidate for user review  
**Date:** 2026-09-17  
**Project:** Tetherplane  
**Tagline:** Open control plane for AI-operated computers.

## 1. Purpose

Tetherplane is an open-source, self-hostable control plane that allows AI clients to securely operate real computers locally or remotely through MCP while remaining lightweight for both the controlled machine and the AI model.

Tetherplane combines the capability classes that are currently fragmented across remote desktop MCPs, desktop automation MCPs, and browser MCPs:

- filesystem and document access;
- search and surgical editing;
- terminal, REPL, and persistent process control;
- browser observation and automation in authenticated real-browser sessions;
- semantic desktop automation with physical input as a fallback;
- remote device routing over outbound-only connections;
- enforceable policy, approvals, auditability, and human-coexistence safeguards.

The product is not defined as a clone of Remote Desktop Commander. Remote Desktop Commander is a compatibility target. Tetherplane has a clean internal capability model and exposes compatibility adapters at the edge.

## 2. Product Principles

### 2.1 AI-efficient by default

Tetherplane optimizes model effort as deliberately as machine effort. The default MCP surface is small, responses are delta-first, long-running work uses stable handles, and independent operations can be batched server-side.

### 2.2 Human-first coexistence

The controlled computer remains usable by the person sitting at it. Background semantic automation is preferred. Tetherplane does not steal focus, move the physical cursor, overwrite the global clipboard, navigate human-owned tabs, or close human-owned resources unless an explicit scoped foreground lease authorizes that behavior.

### 2.3 Local agent is final authority

Policy enforcement occurs on the device. The AI client and hosted relay cannot bypass local ownership rules, approval requirements, path restrictions, or foreground-control restrictions.

### 2.4 Semantic control before physical control

Preferred mechanisms are APIs that act on semantics rather than screen coordinates: CDP, browser extension APIs, Windows UI Automation, macOS Accessibility, Linux AT-SPI, native filesystem APIs, and process APIs. Mouse, keyboard, focus, clipboard, and coordinate clicking are fallback mechanisms.

### 2.5 Verify intent, not just input dispatch

An action is successful only when the intended state change is observed. Tetherplane supports preconditions, semantic waits, postconditions, and verified actions instead of treating a click or keystroke dispatch as completion.

### 2.6 Local-first and self-hostable

Cloud infrastructure is optional. The same capability engine serves local stdio/HTTP clients and remote clients routed through a relay.

### 2.7 Compatibility without architectural inheritance

Legacy or third-party tool schemas are implemented as adapters. They never define the internal protocol or capability boundaries.

## 3. Canonical Architecture

Tetherplane uses five hard boundaries.

### 3.1 Capability Kernel

The kernel defines stable capability semantics independent of MCP, browsers, operating systems, or AI vendors.

Canonical capability namespaces:

- `device`
- `filesystem`
- `search`
- `process`
- `browser`
- `desktop`
- `document`
- `system`
- `policy`

Every invocation uses a common internal envelope containing a request ID, device ID, capability, arguments, actor/session context, optional preconditions, optional expectations, response budget, and idempotency key.

Every result uses a common result envelope containing status, structured data, state delta, diagnostics, timing, continuation handles, policy metadata, and verification status.

### 3.2 Providers

Providers implement capability namespaces without defining the public MCP interface.

Initial providers:

- native filesystem provider;
- native search provider;
- native process/PTY provider;
- browser extension/CDP provider;
- Windows UI Automation desktop provider;
- document parsing provider for text, JSON, CSV, XLSX/XLS/XLSM, PDF, DOCX, and supported images.

Provider interfaces must allow future macOS Accessibility and Linux AT-SPI implementations without changing the kernel contract.

### 3.3 Adapters

Adapters translate external protocols and compatibility surfaces into canonical capability requests.

Initial adapters:

- Tetherplane Compact MCP;
- Tetherplane Expanded MCP;
- Remote Desktop Commander compatibility adapter.

Future adapters may expose REST, CLI, or other agent protocols without changing providers.

### 3.4 Transport

Local modes:

- stdio MCP;
- local Streamable HTTP.

Remote mode:

- MCP Streamable HTTP between AI client and relay;
- outbound TLS WebSocket between device agent and relay.

The remote endpoint should support current MCP protocol revision behavior and a compatibility path for established 2025-era clients where practical.

### 3.5 Policy Broker

Every state-changing operation crosses the local policy broker before execution.

Policy outcomes:

- allow;
- deny;
- require approval;
- allow once;
- allow for scoped lease/session.

The policy broker evaluates capability semantics, resource ownership, side-effect class, requesting actor, device state, human activity, and applicable grants.

## 4. Default MCP Surface

The default AI-visible surface exposes six compact tools:

1. `device`
2. `files`
3. `process`
4. `browser`
5. `desktop`
6. `batch`

Each tool accepts a compact `op` plus operation parameters. Full operation-specific schemas are discoverable on demand instead of injecting a large schema catalogue into every model context.

The Compact MCP must remain sufficient for normal work. Expanded mode exposes more granular tools when a client benefits from strict individual schemas. RDC compatibility mode exposes legacy-equivalent names and semantics.

### 4.1 Schema-on-demand

Compact mode must avoid hiding hundreds of fields inside six enormous JSON schemas. The initial schema remains small; an AI can request namespace capabilities or an operation schema only when needed. Invalid calls return the minimal expected schema for that operation.

### 4.2 Stateful handles

Tetherplane assigns stable handles to stateful resources, including:

- devices;
- pages/tabs;
- browser contexts;
- processes and REPLs;
- searches;
- outputs;
- files when useful;
- checkpoints;
- approvals;
- foreground leases.

Handles reduce rediscovery and preserve continuity across reconnects where safe.

### 4.3 Delta-first responses

Normal responses return only information that changed or has not previously been delivered in the handle/session context.

Examples:

- process reads return new stdout/stderr;
- browser actions return changed accessibility nodes, navigation state, validation messages, and relevant network failures;
- file patches return changed ranges;
- searches return unseen matches;
- desktop operations return changed windows/elements.

Full-state responses remain available explicitly.

### 4.4 Response budgets

Every operation supports response modes such as `compact`, `normal`, and `debug`. Compact is the default. Large results return continuation handles instead of unbounded output.

### 4.5 Server-side batching

`batch` executes independent operations in parallel when safe and ordered operations sequentially when explicitly requested. V1 does not include a general workflow programming language.

## 5. Browser Architecture

Browser automation is a first-class capability provider, not a shell add-on.

### 5.1 Browser provider priority

Preferred order:

1. browser extension bridge attached to an existing authenticated profile;
2. direct CDP attachment to a Tetherplane-owned browser context/profile;
3. controlled headed browser workspace using the installed Chromium-family executable;
4. semantic desktop automation;
5. physical mouse/keyboard fallback under foreground lease.

Tetherplane does not require a bundled browser.

### 5.2 Authenticated real-browser operation

Where possible, Tetherplane works through a user-authorized extension in the existing browser profile. This permits authenticated sites without exporting cookies or credentials from the browser.

The extension creates or attaches Tetherplane-owned tabs without activating them. Sensitive browser state remains local and is not returned to the model by default.

### 5.3 Browser ownership

Every tab/page has ownership metadata:

- `human`;
- `tetherplane`;
- `shared-observe`;
- `shared-authorized`.

Default rules:

- Tetherplane-owned tabs may be navigated, edited, and closed by Tetherplane;
- human-owned tabs are observe-only unless explicitly attached;
- human-owned tabs cannot be closed or navigated in `background_only` mode;
- attaching a human tab creates an explicit scoped grant.

### 5.4 Accessibility-first snapshots

The normal browser observation primitive is an accessibility/semantic snapshot with stable references. Screenshots are supplemental and coordinate interaction is fallback-only.

### 5.5 Stable semantic references

A reference records enough semantic identity to be reacquired after SPA re-rendering, including role, accessible name, contextual ancestry, document/frame identity, and snapshot revision.

If a reference becomes stale, Tetherplane attempts semantic reacquisition. Ambiguous reacquisition fails safely instead of selecting an arbitrary element.

### 5.6 Verified actions

`browser.act` supports multiple semantic actions in one request plus preconditions and expectations.

Examples of expectations:

- URL changed;
- target text appeared;
- form value persisted;
- button became enabled/disabled;
- validation errors absent/present;
- application toast appeared;
- expected network request succeeded;
- relevant resource revision changed.

Result states distinguish `verified`, `executed_unverified`, `precondition_failed`, `conflict`, and `failed`.

### 5.7 Semantic waits

The browser provider supports event/state waits rather than fixed sleeps, including:

- element state;
- page/navigation state;
- network condition;
- text/alert/toast state;
- JavaScript predicate where policy permits;
- download/upload completion.

### 5.8 Form verification

Filling a form field is not considered successful merely because input events were dispatched. Where possible the provider reads back application/DOM state and returns validation information.

### 5.9 Native uploads and downloads

Browser uploads accept a local path and use browser/CDP/file-input mechanisms directly without navigating the human user's file picker. Downloads are tracked with handles and can be passed directly to filesystem/document operations.

### 5.10 Console and network diagnostics

Browser diagnostics can expose bounded console errors, failed requests, and selected request metadata. Sensitive headers, cookies, authorization values, and credentials are redacted by default.

## 6. Human Coexistence Contract

`background_only` is the default mode.

Without a foreground lease, Tetherplane must not:

1. change the user's active browser tab;
2. navigate or close a human-owned tab;
3. steal keyboard focus;
4. move the physical cursor;
5. inject OS-level keystrokes into a human-owned window;
6. read or overwrite the global clipboard except where explicitly granted;
7. minimize, maximize, move, resize, activate, or close a human-owned window;
8. switch the user's desktop/workspace;
9. invoke Alt+Tab or equivalent focus-switch mechanisms;
10. kill a human-origin process;
11. open disruptive dialogs in the foreground;
12. leave temporary UI state altered after a scoped foreground interaction.

### 6.1 Resource ownership

Tetherplane tracks ownership of tabs, windows, processes, browser contexts, temporary files, searches, and sessions. It has broad authority over resources it created and narrow authority over human-origin resources.

### 6.2 Foreground leases

Physical interaction requires a scoped, expiring lease specifying:

- target window/resource;
- permitted capabilities;
- maximum duration;
- requesting actor;
- reason;
- restoration requirements.

A lease automatically expires and cannot silently become permanent full-machine control.

### 6.3 Human activity detection

The agent locally detects recent keyboard/mouse activity and active-window changes only for collision avoidance. Foreground-requiring work is deferred or requests approval while the human is active.

No human activity stream is uploaded to the relay for analytics.

### 6.4 Private Tetherplane clipboard

Tetherplane maintains an internal clipboard object for text/files/images. Semantic browser and desktop APIs use direct value mechanisms rather than the global clipboard. Global clipboard access is policy-gated.

### 6.5 Application-resource conflicts

For applications where two tabs/windows can edit the same underlying object, Tetherplane supports checkpoint revisions and optimistic conflict detection.

When a resource appears to have changed since the checkpoint, Tetherplane returns `conflict` instead of blindly overwriting state.

## 7. Desktop Architecture

Desktop control is split into two planes.

### 7.1 Semantic plane

Preferred providers invoke UI semantics without moving the physical mouse where possible.

Windows v1 uses UI Automation patterns such as Invoke, Value, Selection, Toggle, ExpandCollapse, and Window operations when available.

### 7.2 Physical plane

Mouse coordinates, drag operations, keyboard injection, focus activation, and global clipboard operations are fallback tools and require policy permission. Human-owned foreground interactions normally require a foreground lease.

## 8. Filesystem, Search, Documents, and Processes

### 8.1 Filesystem

Required parity features include:

- bounded reads and tail reads;
- multiple-file reads;
- atomic writes/appends;
- exact block edits and guarded patches;
- directory listing;
- metadata;
- create/move/rename;
- configured allowed paths;
- symlink/junction/path traversal validation.

### 8.2 Search

Search supports filename and content modes, literal and regex matching, filters, bounded context, progressive results, cancellation, and handles.

Implementation should reuse efficient native search libraries/algorithms rather than shelling out when not necessary.

### 8.3 Documents

A single files/document path should automatically dispatch by file type where practical. The model should not need separate high-level concepts for ordinary PDF, spreadsheet, Word, image, JSON, or CSV reads.

### 8.4 Processes

Processes and REPLs are persistent sessions with incremental output, stdin interaction, cancellation/termination, metadata, and reconnect survivability where the operating system process still exists.

Tetherplane tracks whether a process is human-origin or Tetherplane-origin. Human-origin process termination is not allowed by default.

## 9. Remote Control Plane

### 9.1 Relay responsibilities

The relay provides:

- MCP Streamable HTTP endpoint;
- OAuth/OIDC integration;
- user/client identity;
- device directory and online presence;
- device routing;
- transient RPC multiplexing;
- approval coordination where supported;
- bounded operational telemetry;
- revocation.

The relay does not become the ultimate policy authority for device actions.

### 9.2 Device connection

The agent initiates an outbound authenticated TLS WebSocket to the relay. No inbound port forwarding is required.

Each device generates a local cryptographic identity. Pairing binds the device identity to an account through a human-verified device authorization flow. Device credentials are rotated and revocable.

### 9.3 Privacy modes

Tetherplane must document privacy precisely:

- local mode: no relay involved;
- self-hosted relay: operator controls relay infrastructure;
- hosted relay: MCP requests/results necessarily transit the relay endpoint and must be treated as transient sensitive data unless a future end-to-end architecture removes that visibility.

The project must not claim that a generic hosted MCP relay cannot see request/result payloads when it terminates the client MCP connection.

### 9.4 Retention

Default hosted-relay design target: no durable storage of tool payloads or file contents. Operational event metadata is minimized and configurable. Self-hosted deployments can disable telemetry entirely.

## 10. Identity and Authorization

Tetherplane distinguishes:

- human account identity;
- MCP client identity;
- device identity;
- agent/session identity;
- approval authority.

Authorization grants are scoped by device, capability, resource class, side-effect class, and optionally domain/application.

The relay follows current MCP authorization requirements and modern OAuth/OIDC practices. Legacy compatibility is isolated in the transport/auth adapter layer.

Secrets and long-lived device keys are stored using platform credential facilities where available, such as Windows DPAPI/Credential Manager, macOS Keychain, or a Linux secret service.

## 11. Side-effect and Approval Model

Canonical side-effect classes:

- `read_only`;
- `local_reversible`;
- `local_destructive`;
- `external_mutation`;
- `external_communication`;
- `financial`;
- `credential_sensitive`;
- `privileged_system`;
- `foreground_disruptive`.

Default conservative policy examples:

- read local files in allowed directories: allow;
- navigate Tetherplane-owned browser tab: allow;
- edit allowed file: allow or configurable;
- delete arbitrary human file: approval;
- close human tab/window: deny without explicit scope;
- send email/chat/message: approval;
- place order or submit payment: approval;
- reveal raw credentials/cookies: deny;
- use credential locally against authorized domain: separately grantable;
- physical foreground control: foreground lease;
- shutdown/reboot: approval.

Approvals are represented by opaque approval handles. The AI cannot mint or self-approve an approval.

## 12. Threat Model

Tetherplane must explicitly defend against:

- prompt injection from websites, files, terminals, and documents;
- compromised or over-permissioned AI clients;
- cross-account/cross-device relay routing errors;
- replayed tool calls;
- stale semantic references;
- confused-deputy attacks;
- path traversal and symlink/junction escapes;
- malicious uploads/downloads;
- secret exfiltration through tool results;
- browser cookie/token extraction;
- authorization-server mix-up and token misuse;
- unattended foreground takeover;
- accidental destructive actions caused by stale UI state;
- reconnect duplication of non-idempotent actions.

Local malware already running with the same or greater operating-system privileges is outside the primary security boundary, though Tetherplane should avoid increasing its access unnecessarily.

## 13. Idempotency and Recovery

State-changing actions accept idempotency keys where meaningful. Reconnect logic must not blindly replay actions such as form submissions, purchases, messages, deletes, or process starts.

Long-running sessions maintain resumable handles. The agent reports whether a handle survived restart/reconnect or became invalid.

### 13.1 Checkpoints

A checkpoint can capture relevant application state without storing unrestricted secrets, including:

- URL/page identity;
- tab/window ownership;
- semantic snapshot revision;
- selected form values where permitted;
- related resource revision;
- process/session identifiers;
- pending upload/download state;
- recent verified actions.

Checkpoints are used for conflict detection and recovery, not as a guarantee that arbitrary third-party applications can be rolled back.

## 14. Error Model

Errors are machine-readable and concise.

Required categories include:

- invalid_arguments;
- capability_unavailable;
- permission_denied;
- approval_required;
- foreground_lease_required;
- human_activity_conflict;
- stale_reference;
- resource_conflict;
- precondition_failed;
- action_unverified;
- timeout;
- disconnected;
- process_finished;
- output_truncated;
- provider_failure.

Errors should include the smallest useful recovery hint and avoid dumping irrelevant provider internals in compact mode.

## 15. Compatibility Target

Tetherplane should provide functional parity with the currently observed Remote Desktop Commander categories:

- device list/status/ping/shutdown;
- configuration read/write for safe supported keys;
- file read/multi-read/write/create/move/info;
- PDF/document handling needed to match practical behavior;
- streaming/progressive search lifecycle;
- exact block editing;
- persistent command/REPL sessions and input/output;
- process/session listing and termination;
- usage/history diagnostics where appropriate.

Compatibility means equivalent useful behavior, not copying legacy internals into the canonical kernel.

## 16. V1 Scope

### 16.1 Must ship

- Rust device agent and capability kernel;
- filesystem/search/process core;
- Compact MCP with six tools;
- Expanded/compatibility adapter framework;
- Remote Desktop Commander compatibility for core file/search/process/device flows;
- Chromium-family browser extension/CDP provider;
- background tab ownership and zero-interference enforcement;
- semantic browser snapshot, act, wait, upload/download, screenshot, console/network diagnostics;
- verified actions and checkpoints;
- Windows semantic desktop provider;
- local stdio mode;
- remote relay with Streamable HTTP + outbound WebSocket agent connection;
- pairing, revocation, local policy broker, approvals;
- self-host documentation;
- automated conformance/security/coexistence tests.

### 16.2 Explicitly deferred unless required by implementation

- rich dashboard beyond pairing/device/policy essentials;
- general workflow DSL;
- arbitrary plugin marketplace;
- autonomous credential harvesting;
- mandatory bundled browser;
- pixel-only vision agent as the primary desktop mechanism;
- mobile device control;
- macOS/Linux full semantic desktop parity.

Filesystem, process, search, browser, transport, and protocol architecture remain cross-platform; Windows receives the first full desktop semantic implementation.

## 17. Technology Direction

### Device agent

Rust, asynchronous runtime, modular crates, native OS APIs, long-running daemon/service support, and standalone binaries.

### Relay and MCP edge

TypeScript/Node ecosystem using the current MCP TypeScript SDK and Streamable HTTP behavior. Relay state should be horizontally scalable where practical; ephemeral connection routing may use a shared broker later if profiling justifies it.

### Browser bridge

TypeScript browser extension plus CDP bridge. Prefer extension-local access to authenticated profiles so credentials/cookies do not need to leave the browser.

### Wire protocol

Start with a versioned typed JSON protocol over WSS for debuggability and contribution ease. Move to a binary encoding only if benchmarks justify the complexity.

### Licensing

Recommended project license for original Tetherplane code: dual MIT OR Apache-2.0, preserving attribution and license notices for incorporated or derived third-party MIT code. Final repository license choice should be made before code import.

## 18. Testing Strategy

### 18.1 Unit tests

- kernel request/result semantics;
- provider boundaries;
- policy evaluation;
- ownership rules;
- path validation;
- handles and expiry;
- redaction;
- idempotency.

### 18.2 Contract tests

Every provider runs against the same capability contract tests. Compatibility adapters run a Remote Desktop Commander behavior suite.

### 18.3 Browser fixture lab

A local synthetic web application must reproduce difficult SaaS behaviors:

- SPA rerenders;
- stale nodes;
- asynchronous saves;
- validation banners/toasts;
- nested frames;
- dialogs;
- file uploads/downloads;
- hidden/disabled controls;
- navigation races;
- conflicting edits in two tabs;
- slow and failed requests.

This fixture replaces risky repeated testing against real production Seller Central accounts.

### 18.4 Human coexistence tests

Automated tests assert that background operations do not change:

- active browser tab;
- active OS window;
- cursor position;
- global clipboard;
- human-owned tab URL;
- human-owned window geometry;
- human-origin processes.

Foreground lease tests verify exact scope, expiry, restoration, and denial outside scope.

### 18.5 Security tests

Include malicious page/file content, prompt-injection fixtures, cross-tenant routing tests, replay tests, path traversal, symlink/junction escapes, redaction tests, authorization mix-up cases, and approval forgery attempts.

### 18.6 Chaos/recovery tests

Test relay disconnects, agent reconnects, client retries, process survival, browser tab loss, machine sleep/wake, browser restart, and duplicate action prevention.

### 18.7 Performance budgets

Initial engineering targets, to be validated rather than marketed as achieved:

- six default model-visible tools;
- idle agent memory target below 50 MB;
- agent cold-start target below 250 ms on representative hardware;
- zero mandatory bundled-browser footprint;
- ordinary semantic browser operation in no more than two MCP round trips when the initial state is unknown;
- ordinary shell command in one call;
- multi-file inspection in one call;
- compact responses by default.

## 19. Repository Structure

```text
tetherplane/
├── agent/
│   ├── kernel/
│   ├── providers/
│   │   ├── filesystem/
│   │   ├── search/
│   │   ├── process/
│   │   ├── browser/
│   │   ├── desktop/
│   │   └── documents/
│   └── policy/
├── relay/
│   ├── mcp/
│   ├── auth/
│   ├── routing/
│   └── devices/
├── adapters/
│   ├── compact-mcp/
│   ├── expanded-mcp/
│   └── rdc-compat/
├── protocol/
│   ├── schemas/
│   └── generated/
├── extension/
│   └── browser/
├── sdk/
│   ├── typescript/
│   └── rust/
├── fixtures/
│   └── browser-lab/
└── docs/
```

## 20. Naming

- Project: **Tetherplane**
- Main binary/CLI: `tetherplane`
- Device daemon/service: `tetherd`
- Relay: `tether-relay`
- Core protocol/kernel: `tether-core`
- Browser extension: **Tetherplane Bridge**

Repository description:

> Tetherplane is an open-source, self-hostable control plane that lets AI securely operate real computers — filesystem, terminal, desktop and browser — locally or remotely through MCP.

The current name search found no obvious active software/MCP collision for the exact name, but this is not trademark clearance.

## 21. Delivery Phases

### Phase 0 — Design freeze and conformance inventory

Freeze this design, inventory exact RDC behavior, define canonical schemas, and create acceptance tests before production implementation.

### Phase 1 — Local capability kernel

Implement filesystem, search, process, handles, response budgets, policy skeleton, and Compact MCP locally.

### Phase 2 — Browser coexistence engine

Implement Tetherplane Bridge, tab ownership, accessibility snapshots, semantic actions, verified actions, uploads/downloads, checkpoints, and browser fixture lab.

### Phase 3 — RDC compatibility

Map existing Remote Desktop Commander workflows to the canonical kernel and pass compatibility tests.

### Phase 4 — Remote plane

Implement relay, OAuth/OIDC integration, device pairing, WSS routing, revocation, reconnection, and self-host package.

### Phase 5 — Desktop semantic control

Implement Windows UI Automation provider, human activity conflict handling, Tetherplane private clipboard, and foreground leases.

### Phase 6 — Hardening and release

Security review, chaos testing, resource benchmarking, installer/service packaging, docs, contribution policy, and public open-source release.

## 22. Acceptance Definition

Tetherplane v1 is successful when an AI can connect locally or remotely and complete real filesystem, terminal, browser, and supported desktop workflows while:

- seeing only a small default tool surface;
- avoiding unnecessary model round trips and repeated full-state observations;
- preserving long-running state through handles;
- verifying meaningful application state changes;
- maintaining RDC-compatible core workflows;
- enforcing policy locally;
- not disrupting a human concurrently using the machine in background-only mode;
- never requiring a bundled Chromium merely to automate an already installed compatible browser;
- being deployable without the hosted Tetherplane relay.

## 23. External Design References

The design was informed by the observed capability surfaces and current public documentation of:

- Remote Desktop Commander / DesktopCommanderMCP;
- Nuphus MCP;
- BrowserMCP;
- current Model Context Protocol Streamable HTTP and authorization direction.

Tetherplane does not treat any one of these projects as its internal architecture. They are compatibility and design references.
