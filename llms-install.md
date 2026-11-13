# Tetherplane installation instructions for AI clients (review-only)

Tetherplane is not authorized to connect to any computer merely because its source repository or Skill is accessible.

## Preflight

1. Confirm the operator owns or is explicitly authorized to manage the target Windows x64 computer and that the target is non-sensitive for beta testing.
2. Check exact reviewed build, operator-approved distribution URL, archive SHA-256, and current release notes. Do not download an arbitrary latest binary.
3. The Windows three-step candidate in PR #135 is **unsigned, private-beta-only**, and lacks independently observed clean-device acceptance. Do not bypass SmartScreen, Smart App Control, antivirus, admin prompts, or signature requirements. Stop if Windows blocks execution.
4. Do not write scripts to auto-approve device pairing, OAuth grants, browser tabs, filesystem paths, or foreground leases. These are separate explicit owner actions.

## Owner-supervised trial

Follow the official developer-beta guide: https://github.com/muhamedsohaib/Tetherplane/blob/feature/developer-beta-single-zip-three-steps-20261109/docs/developer-beta-add-device.md

Before claiming success, independently inspect the exact new device with authenticated `device.status`, a harmless scoped operation, a deliberately rejected out-of-scope operation, and revocation/restart evidence. Record actual outcomes and failures. A ZIP extract, executable launch, or successful CI workflow alone does not count as onboarding success.

## Availability

No stable, signed general-availability package or generic public MCP endpoint is asserted here. For a preconfigured and authenticated client, use `skills/tetherplane/SKILL.md` for safe operation guidance. Do not auto-install a system service or register a new OAuth client as a workaround.
