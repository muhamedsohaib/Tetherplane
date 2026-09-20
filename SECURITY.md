# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub's repository security-advisory mechanism when available. Do not open a public issue containing credentials, exploit details, or sensitive host information.

A useful report includes the affected commit/version, local or remote mode, operating system, minimal reproduction, expected security boundary, and observed result.

## Security boundaries

The local tetherd agent is the final authority. A relay or AI client cannot override a stricter local denial.

Tetherplane separates authenticated principal authority from model/controller labels and caller arguments. Human-owned browser/desktop resources are protected by default. Physical desktop control requires a scoped ForegroundLease.

See docs/security/threat-model.md and docs/security/remote-plane.md.

## Secrets

Do not submit real bearer tokens, device credentials, browser cookies, authorization headers, private keys, or customer secrets in issues, fixtures, logs, or pull requests.

## Supported development line

The repository currently develops the 0.1.x line. Security fixes are applied to the active development line; no long-term-support branch is promised yet.

## Out of scope

The primary boundary does not attempt to defeat malware already running with equal or greater operating-system privilege than Tetherplane.
