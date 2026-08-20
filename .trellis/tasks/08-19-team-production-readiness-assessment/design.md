# Target Design: Single-Company Team Production

## 1. Boundary And Principles

The target is one company, one deployed AutoFlow service and up to 10 internal workspaces. Workspaces are authorization and data-isolation boundaries, not external SaaS tenants. The design keeps the existing FastAPI, SQLite, React and ManagedRunner stack, adding only mechanisms required by the confirmed target.

Core invariants:

1. Authentication never implies authorization.
2. A resource ID is authorized through its workspace/project parent before it is read or mutated.
3. Frontend visibility mirrors policy but never replaces server enforcement.
4. Administrative, secret and destructive operations are auditable and admin-only.
5. Backup success means a timed restore can recover both database state and referenced artifacts.
6. Runner concurrency cannot weaken SQLite transaction ownership, cancellation, artifact isolation or workspace fairness.

## 2. Identity And Membership

### Account bootstrap

- Installation provides an interactive/CLI bootstrap for the first deployment-global super-admin. No default password or open registration route remains in production.
- Super-admin can create workspaces, disable/enable accounts, recover accounts, inspect system health and assign workspace admins.
- Global account disable revokes all sessions immediately. Workspace removal revokes authorization for that workspace without deleting the user's other memberships or audit history.

### Invitation flow

- Admin creates an invite for `workspace_id + normalized_email + role` (`admin` or `member`).
- The API returns a random one-time token once; the database stores only its digest, expiry, creator and terminal state.
- Default expiry is 24 hours. The first successful accept atomically applies the account/membership change and marks the token consumed. A new user sets a password and joins; an existing enabled user only gains membership and keeps the existing password.
- Acceptance is effect-idempotent, not replay-successful. Every later use of the consumed token returns `410 INVITE_ALREADY_USED` without account/workspace detail, creates no account/membership/password/session change and does not duplicate the successful-accept audit event. This gives a retry after a lost response a stable terminal result; the user proceeds to login with the credentials established by the first request.
- Revoke, expire, replay, email mismatch and disabled-account paths have stable error codes and redacted audit behavior. SMTP is not part of Phase 1.

### Role model

| Role | Scope | Capabilities |
| --- | --- | --- |
| Super-admin | Deployment global | Accounts, all workspaces, system configuration/health and all admin/member actions. Cross-workspace data access is explicit and audited. |
| Admin | One workspace membership | Invite/remove members, assign admin/member, create/archive projects, manage secrets, notification channels and workspace settings; includes member actions. |
| Member | One workspace membership | Create/edit flows, elements, variables, environments and datasets; record and execute runs; view results and project analytics. No membership, secret, notification, workspace-setting or archive/delete administration. |

The old eight-role constants are migrated, not layered underneath the new model. A single backend policy module owns effective-role and capability calculation. Session responses expose global role plus workspace memberships; the frontend derives routes and commands from the same named capabilities.

## 3. Authorization And Isolation Flow

```text
request
  -> authenticated enabled account/session
  -> global super-admin or workspace membership
  -> required capability
  -> authorized workspace/project parent
  -> child resource constrained by parent id
  -> mutation + audit in one transaction where possible
```

- Workspace routes use `require_workspace_capability`; project routes first resolve the project and then evaluate membership/capability.
- Child resource endpoints query with both child ID and authorized parent ID. Dependent deletes first resolve a scoped ID set and use only that set.
- Cross-table references such as schedule/revision, dataset/version and notification/project are validated to the same project/workspace even when SQLite foreign keys alone would accept the IDs.
- The route inventory becomes an executable authorization matrix covering unauthenticated, disabled, non-member, wrong workspace/project, member, admin and super-admin cases.
- Super-admin access to workspace content is allowed for the confirmed support model but writes a dedicated `super_admin.workspace_accessed` audit event.

## 4. Collaboration Contract

- Existing resource versions, 409 conflicts and persistent outbox remain the write-conflict mechanism; no real-time co-editing engine is introduced.
- A lightweight poll/change-version signal makes remote changes visible within a documented interval. It never overwrites a dirty draft.
- Conflict UI identifies resource, remote updater and update time, offering remote refresh or resubmit. Member/admin identity is always server-derived.

## 5. Audit And Retention

- Audit continues as append-only application events in SQLite for Phase 1, with sensitive values forbidden.
- Phase 1 adds invite lifecycle, membership/role changes, account enable/disable/reset, session revocation, global-admin workspace access and retention-policy change events. It does not close the retention gap or claim that target expiry is enforced.
- Phase 2 adds cleanup summaries plus backup/restore and deployment events where the application can observe them, and owns the complete retention lifecycle.
- Phase 2 configurable enforcement defaults:
  - audit events: 180 days;
  - run records and events: 90 days;
  - screenshots and Trace artifacts: 15 days.
- Existing partial cleanup before Phase 2 is current behavior, not evidence that the target policy is implemented. Phase 2 cleanup selects authorized/expired IDs first, removes files and dependent rows coherently, reports dry-run counts/bytes and writes only non-sensitive summary audit. External immutable audit export remains Phase 3.

## 6. Secure Deployment

```text
LAN browser --HTTPS--> approved TLS reverse proxy --HTTP loopback--> AutoFlow/WinSW
                                                       |-- SQLite data
                                                       |-- canonical artifacts
                                                       `-- structured logs/metrics
```

- The application binds loopback in production; only the approved TLS endpoint is exposed to the LAN.
- Session cookies are always `Secure`, `HttpOnly`, `SameSite=Strict`; trusted proxy/origin handling is explicit and tested.
- A dedicated non-interactive service account owns app/data/artifact/log paths with least-privilege ACLs.
- `PLATFORM_SECRET_KEY` is supplied through an approved secret mechanism and escrowed separately from encrypted backups. Key rotation requires versioned key support or an offline transactional re-encryption tool before it can be claimed as supported.

## 7. Backup, Upgrade And Recovery

- One canonical configured artifact directory is used by runner, artifact API, backup, retention and restore.
- Backup output contains a manifest with application/schema version, timestamp, file inventory, sizes and hashes; SQLite backup uses its online backup/checkpoint integrity path.
- Daily backup is copied to an independent failure domain and monitored for age/failure. Storage access and encryption follow company policy.
- Restore targets an empty staging directory, verifies manifest/hashes and SQLite integrity, starts the exact application version, then checks login, workspace/project data, one historical artifact and one new run.
- Quarterly timed drills must demonstrate newest recoverable point <=24 hours and service restoration <=4 hours.
- Upgrade uses an immutable versioned package and pre-upgrade backup. Application rollback cannot claim success after a forward-only incompatible migration unless the matching database backup is restored.

## 8. ManagedRunner Concurrency

- Global concurrency is configurable, default 2. Per-workspace concurrency is configurable, default 1.
- Queue selection chooses the oldest eligible item; items from a workspace at its active limit are skipped without blocking other workspaces. FIFO is preserved within a workspace.
- Active state changes from one item to a keyed set with workspace counters. Cancellation addresses one item and cannot close another run's browser/context.
- Each worker uses isolated artifact paths and safe database transaction ownership. The current shared SQLite connection must not be concurrently transacted by worker threads; use per-thread connections or a serialized persistence boundary with WAL/busy-timeout behavior covered by stress tests.
- Restart recovery requeues persisted `queued` runs in deterministic order and closes all formerly `running` runs as interrupted exactly once.

## 9. Quality And Release Gates

- GitHub Actions is the repository-default CI based on the existing origin; organization branch protection remains an external setup step with checked-in instructions.
- Required checks: build/type check, lint, unit/startup/Python tests, bundle budget, production Playwright, Windows deployment/backup smoke and task-specific authorization/migration tests.
- CI publishes test reports and a versioned deployment package. Python dependencies are locked; package checksum and dependency inventory/SBOM are attached.
- Risk-based coverage, dependency scanning, secret scanning and static security checks enter Phase 2. Exceptions require owner, expiry and documented risk.

## 10. Observability And Capacity

- Structured logs include request/run/workspace correlation IDs and never include passwords, invite tokens, secret values, notification URLs or full snapshots.
- Health distinguishes process liveness, database readiness and degraded maintenance/backup state.
- Metrics/alerts cover API errors/latency, runner active/queued/oldest age, per-workspace queue, schedule/notification failures, backup age, maintenance errors, disk, memory and browser processes.
- Capacity validation declares hardware and seeds 10 workspaces, 100 accounts and representative retained data. It drives 20 concurrent web users and a 500-runs/day-equivalent workload while both runner slots execute real representative Chromium flows.

## 11. Compatibility And Rollback

- Existing owner memberships migrate deterministically: the installer-designated first owner becomes super-admin; other existing workspace owners become admins. No user is silently promoted globally.
- Existing sessions are revoked at the RBAC migration boundary so stale role data cannot survive.
- Legacy role strings are migrated transactionally to admin/member and rejected after migration; do not maintain indefinite dual-policy fallback.
- Product data, revision/run snapshots and current project IDs stay compatible. Each schema change has fresh-install and upgrade fixtures.
- Phase 0 operational fixes are independently releasable. Phase 1 IAM migration requires a pre-upgrade backup and explicit rollback/restore instructions. Runner concurrency stays feature-flagged/configurable so limit `1` remains a rollback mode.

## 12. Deferred

OIDC/SSO/LDAP/MFA, SMTP invitations, external SaaS tenancy, multi-machine agents, immutable external audit storage, active-passive/active-active HA and concurrency beyond the validated hardware envelope are Phase 3 or later decisions.
