# Adding a Windows computer to Tetherplane

There are two different things people mean by "connect another computer".

| You want to... | What to do |
| --- | --- |
| **Use ChatGPT from another computer** | Nothing to install. The existing Tetherplane plugin connection belongs to your ChatGPT account/workspace and works wherever you sign in. Do not create another app, OAuth client, or pairing. |
| **Let ChatGPT control another computer** | Install the device kit on *that* computer and pair it once (this guide). Each controlled computer has its own device credential, created on that computer. |

The connection profile ([connection-profile.json](connection-profile.json)) lists the public endpoints, scopes, and the two public OAuth clients already registered. It contains no secrets.

## Prerequisites

- Windows 10/11, x64. No Rust, pnpm, Node, or build tools are needed on the new computer.
- The computer must be joined to the **same Tailscale tailnet** as the Tetherplane relay. The agent connects *outbound only* to `wss://vaulter.tailf65eba.ts.net:10000/device`; that port is reachable from the tailnet, not the public internet. No inbound port is opened.
- The Tetherplane plugin is already connected in your ChatGPT account.

## Get the kit

The kit is a ZIP plus a SHA-256 file, built from a specific Git commit by the **Windows onboarding kit** workflow and stored as a private workflow artifact (`tetherplane-device-kit-<commit>`). Download it from the workflow run (GitHub sign-in required), then confirm the hash:

```powershell
(Get-FileHash .\tetherplane-device-kit.zip -Algorithm SHA256).Hash
# must equal the value in tetherplane-device-kit.zip.sha256
```

To build it locally instead: `cargo build --release -p tetherd`, then
`scripts\package-windows-device-kit.ps1 -OutputPath dist\tetherplane-device-kit -SkipBuild -Zip`.
Nothing here is a release: there is no tag, public download, or listing.

## Add the computer

Unzip the kit anywhere and open PowerShell in that folder.

1. **Install and pair**
   ```powershell
   .\setup.cmd -DeviceId OFFICE-PC -Pair
   ```
   Setup verifies the kit (every file is checked against `manifest.sha256`), installs the agent under `%LOCALAPPDATA%\Programs\Tetherplane`, creates this computer's own 32-byte credential with owner-only permissions, and asks the relay for a pairing code. Only a hash of the credential is sent. It prints an expiring code and the exact request to run next.

2. **Approve in ChatGPT** — in an existing chat with the Tetherplane plugin, ask it to run exactly what setup printed:
   ```
   device(op="approve_pairing", args={userCode:"ABCD-1234", expectedDeviceId:"OFFICE-PC"})
   ```
   The approval is bound to the signed-in ChatGPT account. No token is copied or pasted anywhere.

3. **Finish**
   ```powershell
   .\setup.cmd -DeviceId OFFICE-PC -Finalize
   ```
   This creates a per-user, limited-privilege background task ("Tetherplane Agent") with single-instance semantics and starts it. If it cannot start immediately, setup says so and the task starts at the next sign-in.

4. **Check** — `.\doctor-tetherplane.ps1`

Then ask ChatGPT for `device(op="status", device="OFFICE-PC")`.

## Safe to re-run

Run the same command again at any time. Setup repairs the files it installed, keeps your credential and identity, and keeps a still-valid pairing code instead of rotating it. It refuses (with an explanation) to:

- touch an install folder or scheduled task it did not create,
- reuse a device ID that belongs to different local state,
- overwrite a credential, regenerate identity, or re-pair a paired device.

There is deliberately no `-Force`.

## What the new computer is allowed to do

A new install starts **least-privilege**: `device.status` only, no allowed folders, `background_only`. The local launch-bound profile (`principal.json` next to the credential) is the final authority; neither the relay nor ChatGPT can widen it. Setup never widens an existing profile. Granting more is a deliberate local edit followed by an agent restart.

## Reading the doctor

| Check | Meaning | If it fails |
| --- | --- | --- |
| `install` | Agent files are present | Re-run `setup.cmd` |
| `identity` | Local device ID and credential exist | Re-run setup; never copy another computer's credential |
| `profile` | Connection profile parses | Use the profile from the unpacked kit |
| `public` / `tools` | Public HTTPS discovery and the six tools answer | Check this computer's internet access; do not reinstall |
| `relay-transport` | This computer can reach the device endpoint | Join the same Tailscale tailnet |
| `agent-task` | The background task exists | Run `setup.cmd -Finalize` |
| `online` | The agent runs and holds a relay connection (local transport only) | Check approval and reachability |
| `policy` | The launch-bound policy file the agent was started with exists | Restore it from backup; do not widen policy |
| `account` | Pairing seen from the account side | **Unverified from here**: ask ChatGPT to run `device(op="status", device="<id>")` |
| `browser` | Optional browser provider | **Unverified**; only matters if you need browser automation |

`unverified` is never reported as passing. A passing `online` check proves a local connection, not that the account can use the device; the ChatGPT status call is the functional check.

## Troubleshooting

- **"command not recognized" for a core cmdlet** — Windows PowerShell inherited a PowerShell 7 module path (for example when launched from a `pwsh` terminal). The kit scripts repin the module path for their own process; if you still see it, start `powershell.exe` fresh.
- **"An Application Control policy has blocked this file"** — the computer's Windows App Control / Smart App Control policy is blocking the unsigned agent. Ask the administrator to allow the file; setup never alters security policy.
- **Pairing code expired** — re-run the same `setup.cmd ... -Pair` command; a fresh code is requested only once the old one has expired.

## Status of the approval operation

`device(op="approve_pairing")` is a **relay-side** operation: it never reaches a computer, takes the account only from the validated sign-in (any account or principal argument is ignored), requires the short code *and* the expected device ID to match, and consumes nothing on any rejection. It is implemented and tested in this branch but **not deployed to the live relay**; it is a security-sensitive management operation awaiting review and a guarded deployment. Until then, an account owner approves pairing with the existing authenticated `POST /pair/approve` call described in [self-hosting the relay](self-host.md).

## Limitations

- A tailnet is required; there is no public device endpoint.
- Distribution is a private workflow artifact, not a signed installer or release.
- The agent binary is unsigned; locked-down Windows policies may block it.
- Windows x64 only. macOS and Linux devices use the existing manual flow.
- Setup does not verify that the account approved the code; finalize after ChatGPT confirms `Paired device <id>`.
