# Tetherplane

Use the instructions in [skills/tetherplane/SKILL.md](skills/tetherplane/SKILL.md) when a Tetherplane MCP connection has **already been explicitly installed, approved, and authenticated** by the device owner. This extension adds no MCP endpoint or device authority. Never assume a device is connected. Check `device.status` and `device.capabilities` before acting; honor local policy, browser grants, human coexistence, and verification requirements. Do not bypass Windows SmartScreen or release gates.
