# Security Policy

## Reporting a vulnerability

Do not open a public issue for security-sensitive findings. Report privately to the
repository owner (see `CODEOWNERS`). Include:

- affected component and version/commit,
- a minimal reproduction or proof of concept,
- observed impact and whether it requires authentication or a specific role.

## Scope

- `server-py/autoflow` (authentication, authorization, crypto, isolation, runner).
- `scripts/` and `deployment/` (install, backup, restore, Windows service config).
- `src/` (frontend authorization and secret handling).

## Supported versions

Only the latest commit on the active production branch is supported. Historical
tags do not receive security backports.

## Response

The maintainer will acknowledge within 7 days, triage severity, and publish a fix
plus an advisory. Do not disclose externally before a fix is available.
