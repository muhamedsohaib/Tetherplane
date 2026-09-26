# Release operations — OpenCode client + hybrid relay auth

Live production acceptance closure. No runtime deployment was changed to
produce this note; it records already-verified production facts.

## Verified source

```text
Verified source commit: 2d1dd881930f8cf1065ac4d841d314d960c8492f
```

Branch: `feature/opencode-client` (contains `feature/chatgpt-oauth-edge`
as ancestor, plus OpenCode/hybrid-auth commits `1b42128`, `2d1dd88`).

## Deployment artifacts (non-secret)

```text
Deployment artifact SHA256: F6B6BF0961332E941AD0F9EDDBB171AF45982455016695B7EC97786D81510FDE
RTX tetherd SHA256: F412926E5205AD7BE98CB62F16158CA7435017C99B1C66CFCF054A4DC5607B91
```

## Live topology

```text
OpenCode
  -> Auth0 OIDC
  -> VAULTER Tetherplane hybrid-auth relay
  -> paired remote device
  -> tetherd local principal/policy
```

```text
VAULTER live relay (loopback): 127.0.0.1:8788
Public MCP: https://vaulter.tailf65eba.ts.net:10000/mcp
Backup: C:\Users\muham\AppData\Local\Tetherplane\backups\20260926-104916-pre-hybrid-auth
```

Production OIDC identifiers (public, non-secret):

```text
Auth0 Native client: cddeYEWkobslw55zl2dFXkG8RZq1Yr8Y
Audience: https://limits-goals-drove-subsidiary.trycloudflare.com/mcp
Scope: tetherplane:access
```

Six-tool MCP contract unchanged: device, files, process, browser, desktop,
batch. Local principal remains final authority; remote identity cannot
broaden local device permissions. OIDC requires explicit subject/client
binding; no wildcard auth. Static bearer remains supported for controlled
self-host cases.

## Acceptance (already proven live)

- hybrid static auth PASS
- OpenCode OIDC PASS
- RTX pairing PASS
- RTX persistence PASS
- reboot PASS
- real Alfred inference PASS
- outside-root denial PASS

Existing gates also proven before closure:

- Ubuntu CI PASS
- Windows CI PASS
- cargo fmt/clippy/test PASS
- TypeScript tests/build PASS
- Windows package smoke PASS
- VAULTER hybrid static+OIDC deployment PASS
- existing static auth preserved
- RTX paired and persistent
- full RTX reboot acceptance PASS
- local principal authority PASS
- unattended Alfred/Ollama recovery PASS

No secrets or raw subject identifiers are recorded here. See
`docs/opencode.md` for the recommended OIDC production path and static
fallback, and `opencode.tetherplane.example.jsonc` for copyable config.
