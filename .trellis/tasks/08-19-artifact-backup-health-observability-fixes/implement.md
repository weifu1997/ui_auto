# Implementation Plan: Artifact Backup And Runtime Health Repairs

## Ordered Work

1. Search every `PLATFORM_ARTIFACT_DIRECTORY`, root `artifacts`, runner artifact and artifact-download reference. Remove the dead separate configuration and make `PlatformServices` own the resolved `data/artifacts` directory passed to `ManagedRunner`.
2. Align `deployment/AutoFlow.xml`, install/backup/restore/retention PowerShell scripts and the Windows smoke fixture with the canonical directory. Preserve the existing SQLite backup behavior and do not delete legacy root artifacts.
3. Add backend regression coverage for the runner path and an artifact record/download after a backup/restore fixture. Extend Windows smoke to verify the runtime source, backup container and restored target.
4. Extract a testable maintenance pass/state boundary. Add safe maintenance state to `/ready`, emit a redacted machine-readable failure event, and update the soak script to evaluate both database readiness and maintenance health.
5. Add success/failure regressions for maintenance state/logging and readiness fields. Run focused tests, then the existing full project gates appropriate to the changed backend/deployment surface.

## Files Expected To Change

- `server-py/autoflow/core.py`, `services.py`, `main.py`, and focused Python tests
- `playwright.config.ts` to remove the stale test-server artifact-directory injection
- `deployment/AutoFlow.xml`
- `scripts/install.ps1`, `backup.ps1`, `restore.ps1`, `retention.ps1`, `soak-test.ps1`, `windows-scripts-smoke.ps1`
- Existing deployment/readiness documentation only where it describes the changed contract

## Validation

```bash
npm run test:py
npm run test:startup
npm run test:windows
npm run build
npm run lint
npm run test:unit
npm run check:bundle
npm run test:e2e
```

Focused checks must prove the ManagedRunner source path, backup/restore artifact layout, authorized artifact download, normal/degraded `/ready` responses, redacted maintenance failure log event and corrected soak parsing. `npm run test:windows` requires a Windows host; its remote CI job is the portability proof.

## Rollback And Safety

- Treat runtime path, PowerShell scripts and smoke regression as one reversible change set.
- Back up database and both artifact locations before production deployment; never delete a legacy root artifact directory during this task.
- Keep `/health` behavior unchanged and preserve the `ready` field for existing callers.
- Do not add off-host backup, retention enforcement or centralized alerts under this Phase 0 task.
