# Audit & Governance Contracts

Executable contracts for the platform audit trail and governance analytics (implemented in task `08-14-audit-governance-enhance`).

## Audit Event Convention

- Action names are dot-namespaced by domain: `auth.*`, `notification.*`, `run.*`, `secret.*`, `flow_revision.*`, `schedule.*`, `webhook*`, `template.*`, `dataset.*`, `project.*`, `workspace.*`, `element.*`.
- `project_id` NULL rows are **workspace-level events** (auth, workspace, notification channel, template, schedule.triggered).
- The project audit view (`GET /audit-events`) = project events + workspace-level events of the project's workspace, so governance sees the full trail.

### Sensitive Data Rules

- Audit detail records **names only, never values**: no secret plaintext, no notification URL/keyword, no credentials.
- UI rendering must mask detail keys matching `/secret|url|token|password|keyword|signature|credential/i` (see `src/audit-mask.ts`).
- `auth.login_failed` requires a valid workspace FK — when the account does not exist (no workspace), the event is skipped.

### Instrumentation Points

| Event | Hook location |
| --- | --- |
| `auth.registered` / `auth.login_succeeded` / `auth.logout` / `auth.login_failed` | `server-py/autoflow/handler.py` auth routes; login events include `ip` from the request |
| `notification.delivered` / `notification.rejected` / `notification.failed` | `server-py/autoflow/services.py` `deliver_pending_notifications`, terminal attempts only (retries not audited); `rejected` when error starts with `NOTIFICATION_REJECTED_` |
| `run.completed` / `run.failed` / `run.canceled` | `server-py/autoflow/services.py` `audit_run_lifecycle` (managed runner completed + watchdog interrupted paths) |
| `secret.decrypted_for_run` | `server-py/autoflow/services.py` `secret_values` — only when at least one secret is decrypted for a run payload |

### Gotcha: secretNames Snapshot Filtering

`queuePublishedRuns` records only **actually referenced** secrets into the run snapshot: `requiredSecretNames` keeps `flow.secretNames` entries that appear in a step value as `{{name}}` / `{{ name }}` / `{{secret.name}}` / `{{ secret.name }}`.

Consequence: a flow with `secretNames: ["x"]` but no step referencing `{{secret.x}}` produces an empty snapshot list → `secretValues` early-returns → **no `secret.decrypted_for_run` event**. Tests that expect decryption audits must use a step that references the secret.

## Audit Query API

`GET /api/platform/projects/:id/audit-events` — all params optional; response `{ events, total, page, pageSize }`.

| Param | Semantics |
| --- | --- |
| `page` / `pageSize` | 1-based; pageSize capped at 100 (default 20) |
| `action` | prefix match (`auth.` matches all auth events) |
| `actorId` / `actorType` | exact match |
| `from` / `to` | ISO timestamps on `created_at` |
| `q` | LIKE keyword over `action` / `target_type` / `target_id` / `detail` |

## Analytics API

`GET /api/platform/projects/:id/analytics` — additive params, old response fields unchanged.

| Param | Semantics |
| --- | --- |
| `window` | days (1..365) filtering `created_at` |
| `from` / `to` | custom range, overrides `window` |
| `period` | `day` (default) or `week` (ISO week keys `YYYY-Www`) |
| `limit` | cap on runs instead of default 2000 |
| `categoryBy` | failure category dimension: `message` (default) / `code` / `step` |

Response additions: `previous` (same-length earlier window summary for period-over-period deltas; `limit` mode uses runs older than the oldest in the current set), `runDurations` (first event → terminal event time diff, grouped by period), `scheduleHealth` (`{ triggered, skipped, successRate }` aggregated from `schedule.triggered`/`schedule.skipped` audit events), `failureCategories[].dimension`, summary gains `canceledRuns` / `failedRate` / `canceledRate`.

## Notification Delivery Test Wiring

To deliver to a local HTTP sink (e.g. contract smoke) all three env vars are required — `PLATFORM_ALLOW_PRIVATE_NOTIFICATION_URLS` checks `=== "1"` strictly (the historical doc note "未生效" was a value mismatch, not a code bug):

```
PLATFORM_ALLOW_INSECURE_NOTIFICATION_URLS=1
PLATFORM_ALLOW_PRIVATE_NOTIFICATION_URLS=1
PLATFORM_NOTIFICATION_HOST_ALLOWLIST=127.0.0.1,localhost
```

Delivery retry backoff defaults to 30s × 5 attempts (~15 min to a terminal `failed`), so smoke assertions must either point at a local 2xx sink or wait accordingly. A convenient 2xx POST sink is the worker's own `/api/auth/logout` (200 without a token).

## Design Decision: Governance Sources Stay Schema-Free

- Run durations use event timestamp diffs instead of a new `ended_at` column (no migration).
- Schedule health aggregates audit events instead of a new stats table.
- Trade-off accepted: analytics decay if audit rows are ever pruned (no pruning policy exists today).
