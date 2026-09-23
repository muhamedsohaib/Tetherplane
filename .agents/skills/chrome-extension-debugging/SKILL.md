---
name: chrome-extension-debugging
description: Debug Chrome MV3 extensions, service workers, WebSockets, authenticated browser control, and Chrome DevTools integration. Use for Tetherplane browser-extension and authenticated-profile work.
---

# Chrome Extension Debugging

Use Chrome DevTools MCP directly whenever possible.

Do not infer browser runtime state from source code alone.

## Inspect live state

For MV3 extension defects inspect:

- chrome://extensions
- extension load errors
- service worker registration
- service worker console
- service worker lifecycle
- popup console
- Network panel
- WebSocket frames
- WebSocket close code/reason
- runtime messaging
- storage key presence
- extension permissions
- extension ID
- active/inactive worker state

## Secrets

Never print token values.

When inspecting chrome.storage:

allowed:
- key names
- whether a value exists
- value type
- non-secret URLs

forbidden:
- launch token contents
- credentials
- cookies
- auth headers
- passwords

## Authenticated Tetherplane browser contract

Default browser remains isolated and Tetherplane-owned.

Authenticated profile mode is opt-in.

A human must explicitly share a specific tab.

Shared access must be:

- tab-scoped
- operation-scoped
- expiring
- revocable
- fail-closed after expiration or detach

AI clients must never mint their own sharing grant.

## Live acceptance

Authenticated browser support is not complete until:

1. extension loads with no startup errors
2. pairing succeeds
3. WebSocket authentication succeeds
4. authenticated RPC remains stable for at least 90 seconds
5. one explicitly shared harmless tab is visible to Tetherplane
6. semantic snapshot works
7. allowed navigation works
8. harmless fill/click action works
9. resulting state is verified
10. human detaches the tab
11. subsequent mutation is denied
12. unrelated tabs remain untouched

## Debugging discipline

When a live disconnect occurs, capture before changing code:

- service-worker state
- WebSocket close code
- WebSocket close reason
- console error
- host process state
- RPC port state
- relevant host logs

Then form the root-cause hypothesis.

Do not patch based only on timing coincidence.