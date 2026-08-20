# Design: Artifact Backup And Runtime Health Repairs

## 1. Canonical Artifact Layout

The artifact location is derived from the one existing data-root contract:

```text
<PLATFORM_DATA_DIRECTORY>/
  platform.sqlite
  autoflow.sqlite
  artifacts/
    artifact_<uuid>.png | artifact_<uuid>.zip
```

`PlatformServices` exposes this resolved per-instance directory to `ManagedRunner`. The separate `PLATFORM_ARTIFACT_DIRECTORY` constant and WinSW environment variable are removed because they do not affect the current runner and create a false deployment contract. Existing database `path` values remain authoritative for historic downloads; the change neither deletes nor rewrites a legacy root `artifacts` directory.

Both run artifacts and element-validation artifacts flow through the same runner directory, persist their absolute generated path to SQLite, and remain served by their existing project-authorized endpoints.

## 2. Script And Backup Layout

PowerShell keeps its existing backup container shape while changing only the source/restore target:

```text
<Root>/data/artifacts/  -- backup.ps1 -->  <Backup>/artifacts/
<Backup>/artifacts/    -- restore.ps1 ->  <Root>/data/artifacts/
retention.ps1 operates on <Root>/data/artifacts/
```

SQLite's online backup/checkpoint/integrity behavior remains unchanged. The Windows smoke fixture is placed under `data/artifacts`; it validates that backup contains the expected file and restore places it back under `data/artifacts`. A backend integration regression uses a real artifact database row and the authorized download route so a correct file copy without a usable recorded artifact cannot pass.

No Phase 2 manifest/hash/off-host behavior is introduced here.

## 3. Health And Maintenance Contract

The endpoints separate liveness from readiness:

| Endpoint | Contract |
| --- | --- |
| `/health` | Process liveness; preserve the current success response. |
| `/ready` | SQLite quick check plus maintenance state. Normal response includes `ready: true` and `maintenance.healthy: true`. |

Maintenance state contains only safe operational fields: `healthy`, `lastFailureAt` and a stable failure type/code. It must not include exception text, secrets, URLs, tokens or database payloads. A failed pass writes a JSON-compatible `maintenance.failed` log event and marks state unhealthy. A later complete successful pass records success and clears degraded state.

The infinite loop delegates one testable maintenance pass to a helper. The loop owns retry scheduling and catches failures; the helper owns watchdog and current cleanup behavior. This makes forced failure/success tests deterministic without sleeping for the production interval.

`soak-test.ps1` consumes `ready` and `maintenance.healthy`, writing separate readiness/degraded/error values to its CSV. It does not infer health from a nonexistent `ok` field.

## 4. Compatibility And Rollback

- Existing `data/artifacts` is already the runtime source, so the directory correction is non-destructive.
- The stale root `artifacts` directory is not removed or recursively migrated in this task. Operators can retain it until a later audited cleanup decision.
- `/ready` retains its existing `ready` field; the maintenance object is additive.
- If deployment verification fails, revert the path/script commit as one unit after preserving both artifact locations and taking the normal database backup. No schema migration is needed.
