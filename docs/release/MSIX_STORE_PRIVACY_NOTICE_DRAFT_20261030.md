# Tetherplane — Microsoft Store privacy notice (DRAFT — NOT PUBLISHED)

**Review status:** `NOT_APPROVED`. This text is **not** a live privacy policy, a legal opinion, or a claim about every external relay/operator. Prepared 30 October 2026 from Tetherplane source at `417395769cd68ba6329bdf2f1ff11368486735fd`. The publisher and support contact are awaiting Microsoft case `2610290010001747`. Do not paste this into Partner Center until a responsible operator verifies the open facts below.

## Who operates this application

Tetherplane is an open-source Windows device-connectivity application. The person or entity named as publisher in the final Microsoft Store listing is responsible for this notice **only for services that publisher operates**. A user may configure Tetherplane to connect through their own relay, a separately hosted relay, an external identity provider, or an MCP client. Those providers may have separate privacy practices and responsibilities.

**Publisher identity / contact for privacy requests:** `[TO BE VERIFIED BEFORE PUBLICATION]`

## Information the application can access

When an owner explicitly configures a device and authorizes a connected client, Tetherplane can process device identity and status, selected file paths and file contents, process commands and outputs, browser page information and actions, desktop interface information and actions, and batches of those operations. These may contain personal, sensitive, or confidential information depending on the device, app, or site. The actual access allowed is constrained by the local agent's permissions, device state, client authorization, and applicable user approvals. No user should assume all requested operations will be permitted.

During setup, the application can process a device identifier, relay address, the owner-selected allowed filesystem root, a device-generated secret/credential, and a short-lived pairing code. It does not require the user to paste OAuth bearer tokens into its setup form.

## Where data can travel

- **On the Windows device:** Tetherplane processes requested operations locally; configuration and device-credential data are stored in device-local files, with Windows-specific private-state access checks.
- **Via an operator-chosen relay:** The relay routes authenticated requests and responses between compatible MCP clients and authorized devices over configured transport. A relay that terminates MCP HTTPS can **see the request and response payloads while routing them**. Tetherplane does **not** claim end-to-end confidentiality from the relay operator.
- **Through external clients and identity services:** An MCP client may receive results it requested under its authorized access. If an external OAuth/OIDC service or other provider is configured, that provider processes authentication data under its own arrangements.

Do not enter confidential data into any device, relay, or MCP client unless the operators and their access controls are understood.

## Information that may be retained

- **Device-local setup state:** The selected device ID, relay endpoint, allowed root, and device credential are saved for approved reconnects. Credentials must not be posted in issue trackers or support messages.
- **Device-local audit information:** The agent may append execution/audit records to its local audit file. Such records can include operation labels, identifiers, timestamps, policy/result status and errors; the intended audit record does not persist the raw invocation arguments.
- **Device-local idempotency state:** To prevent duplicated mutations, the agent may persist completed operation **results**. These results can contain file content, process output, or other sensitive data returned by the authorized operation. It would be inaccurate to promise that no payload is ever stored on the device.
- **Relay registration:** When configured with durable state, the relay records device ID, account ID, a **hash** of the device credential, pairing time, and revocation time. Pending pairing/session routing is held transiently; relay code does not implement durable storage of MCP tool arguments/results in its normal router.
- **Deployment and third-party systems:** A relay host, reverse proxy, identity service or external MCP client may have independent access/logging/retention arrangements. Those must be evaluated separately, and this draft does not assert a universal retention period or zero telemetry.

## How you control access

The device owner can choose allowed filesystem roots and local permissions, approve or decline a pairing request, refuse or revoke a device binding through the authenticated owner control plane, and stop an agent session under the applicable product controls. Operations rejected by policy remain denied. Removal of local state/logs and requests for access/deletion must follow an operator-reviewed procedure; deleting identity or idempotency files manually can break reconnect or safe retry behavior. Do not delete another device's state to force access.

## Security and sharing

Production direct relay transport requires HTTPS/WSS. Device credentials are not sent as query parameters, and the relay stores a hash rather than the raw credential for device authentication. Local policy is the final authority for operations; an authenticated client cannot override a stricter local denial. These controls reduce risk but do not guarantee protection from a compromised operating system, a compromised configured relay, or a third-party client that receives authorized result data.

Tetherplane does not sell or transfer a universal guarantee about how independent MCP clients, identity providers, relay hosts, or apps/sites handle information. The owner should review those providers' privacy terms before connecting them.

## Retention, rights, and contact

**Retention periods, publisher-operated services, legal jurisdiction, public privacy contact, support address and deletion process require owner verification before publication.** This draft makes no unsupported promise about automatic deletion periods, log durations, hosted analytics, or incident notification.

For questions about a service controlled by another relay, MCP client, or identity provider, contact that operator. For a privacy request to the Store publisher, use the verified contact that will be supplied in the final published notice.

**Publication gate:** Confirm publisher identity, publish a real contact, verify each data flow and deployment/logging configuration, establish applicable retention/deletion controls and legal review, then place the reviewed notice in a valid Store field/public page. Until then: `PRIVACY_POLICY_NOT_APPROVED`.
