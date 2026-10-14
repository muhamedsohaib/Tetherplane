# Auth0 DCR Scope Recovery Guide

This guide documents the diagnosis, root cause, and verified remediation for authenticated Model Context Protocol (MCP) access failures when using Auth0 with Dynamically Registered Clients (DCR) such as Composio or ChatGPT.

## 1. Problem & Root Cause Analysis

### Symptoms
- Third-party MCP client (e.g., Composio) completes Dynamic Client Registration, user login, and authorization-code exchange against Auth0.
- Subsequent MCP tool calls (`device(op=status, device=Leno)`) fail with:
  ```
  MCP tool error: Authentication required
  ```
- The relay server (`tether-relay`) returns HTTP 200 with JSON-RPC error:
  ```json
  {
    "isError": true,
    "content": [{ "type": "text", "text": "Authentication required" }],
    "_meta": {
      "mcp/www_authenticate": [
        "Bearer resource_metadata=\"https://<relay-host>/.well-known/oauth-protected-resource/mcp\", scope=\"tetherplane:access\", error=\"invalid_token\", error_description=\"Authentication required\""
      ]
    }
  }
  ```
- Auth0 tenant logs display warnings during login:
  ```
  An Action attempted to add tetherplane:access to a third-party client's token and the scope modification was ignored
  ```

### Root Cause
1. **Third-Party Client Scope Isolation in Auth0:**
   Auth0 treats dynamically registered clients (clients with IDs starting with `tpc_` or marked as third-party) under strict isolation rules. In Auth0 Actions, calling `api.accessToken.addScope('tetherplane:access')` is explicitly ignored for third-party clients.
2. **Missing Transaction Target Scopes:**
   When an external MCP client initiates an OAuth authorization code flow, it may send an empty `scope` parameter or request only standard OIDC scopes (`openid profile offline_access`).
   Because the requested scopes do not include the API scope `tetherplane:access`, and `api.accessToken.addScope` cannot force-add it to third-party tokens, the issued RS256 access token contains an empty or insufficient `scope` claim.
3. **Relay Verification Failure:**
   `tether-relay`'s `OidcClientAuthenticator` validates the access token using RFC 9068 / JWT verification rules:
   - Valid signature against the trusted JWKS URL (`https://<tenant>.auth0.com/.well-known/jwks.json`)
   - Issuer matches `https://<tenant>.auth0.com/`
   - Audience matches `https://<relay-host>/mcp`
   - All configured scopes (`tetherplane:access`) must appear in `payload.scope`
   - The token's subject (`sub`) and client ID (`azp` or `client_id`) must match an explicit binding in the relay's `auth.json`
   When `payload.scope` lacks `tetherplane:access`, authentication fails closed and tool execution is rejected.

---

## 2. Secure Remediation Architecture

The remedy uses an Auth0 **Post Login Action** (`auth/examples/auth0-target-scope.cjs`) that requests the required target scope before authorization and consent evaluation, adhering to least privilege:

1. **Target Scopes API (`api.transaction.addTargetScope`):**
   Instead of attempting to mutate the access token directly via `api.accessToken.addScope`, the Action invokes `api.transaction.addTargetScope('tetherplane:access')`. This adds the scope to the transaction's target set, allowing Auth0's authorization engine and user-delegated access policies to grant the scope legitimately.
2. **Resource Server Boundary:**
   The Action checks `event.resource_server.identifier === TETHERPLANE_RESOURCE`. If the authorization request is not targeting the Tetherplane MCP resource, the Action returns immediately without side effects.
3. **Explicit Subject & Client Enrollment:**
   The Action parses `TETHERPLANE_BINDINGS_JSON` from Action secrets. It ensures that both `event.user.user_id` and `event.client.client_id` match an enrolled pair exactly. Unenrolled identities or malformed configurations do not receive scope grants and do not break unrelated flows.
4. **Fail-Closed on Recovery Runtime Failures:**
   For an enrolled identity targeting the Tetherplane resource, if the transaction protocol is unsupported (e.g. non-OIDC basic/refresh flow) or if `api.transaction.addTargetScope` is missing or fails, the Action calls `api.access.deny('Tetherplane authorization is unavailable')` to prevent insecure fallback.

---

## 3. Operator Deployment & Enrollment Runbook

### Step 1: Configure Auth0 API Settings
1. Navigate to **Applications > APIs** in the Auth0 Dashboard.
2. Select the Tetherplane API (Audience: `https://<relay-host>/mcp`, e.g. `https://vaulter.tailf65eba.ts.net/mcp`).
3. Under the **Permissions** tab, ensure `tetherplane:access` is defined.
4. Under the **Settings** tab:
   - Locate **Default Permissions for Third Party Apps**.
   - Under **Authorized for User-Delegated Access**, select `tetherplane:access`.
   - Save changes.
   *(Alternatively, configure an explicit Client Grant via the Auth0 Management API for the specific client ID).*

### Step 2: Deploy the Post Login Action
1. In Auth0 Dashboard, navigate to **Actions > Library > Build Custom**.
2. Create a new Action:
   - **Name:** `Tetherplane Target Scope Recovery`
   - **Trigger:** `Login / Post Login`
   - **Runtime:** `Node 18` or `Node 22`
3. Copy the verified implementation from `auth/examples/auth0-target-scope.cjs`.
4. Configure Action **Secrets**:
   - `TETHERPLANE_RESOURCE`: `https://vaulter.tailf65eba.ts.net/mcp`
   - `TETHERPLANE_BINDINGS_JSON`: A JSON array of authorized subject/client pairs, e.g.:
     ```json
     [
       {
         "subject": "auth0|670b86a...",
         "clientId": "tpc_jszDvrurTq2pWYqXampb11"
       }
     ]
     ```
5. Click **Deploy**.
6. Navigate to **Actions > Flows > Login**, drag the deployed Action into the flow after user authentication, and click **Apply**.

### Step 3: Verify Relay Configuration on Vaulter
Ensure the relay's authentication configuration (`C:\Users\muham\AppData\Local\Tetherplane\relay\auth.json` on Vaulter) contains matching bindings:
```json
{
  "oidc": {
    "issuer": "https://tetherplane-dev.eu.auth0.com/",
    "audience": "https://vaulter.tailf65eba.ts.net/mcp",
    "jwksUri": "https://tetherplane-dev.eu.auth0.com/.well-known/jwks.json",
    "scopes": ["tetherplane:access"],
    "bindings": [
      {
        "subject": "auth0|670b86a...",
        "clientId": "tpc_jszDvrurTq2pWYqXampb11",
        "accountId": "existing-relay-account-id",
        "principalId": "human:owner"
      }
    ]
  }
}
```

### Step 4: Verification Gate
1. Trigger an MCP session from the client (Composio or ChatGPT).
2. Execute `device(op=status, device=Leno)`.
3. Confirm that the tool executes successfully without returning `Authentication required`.
