# Phased Remediation Roadmap

This roadmap is the execution plan for follow-up child tasks. The assessment task itself owns evidence, dependency order and cross-phase exit review; product changes should be implemented in independently reviewable Trellis tasks.

## Phase 0: Baseline And Immediate Risk Containment

Goal: create a trustworthy release baseline and remove operational defects that invalidate current evidence.

- [ ] Reconcile all active Trellis tasks against `python_3.1`; archive completed work, re-scope real remainder and assign one owner/branch per task.
- [ ] Tag the reviewed baseline and record its complete local gate evidence.
- [ ] Add GitHub Actions for Linux build/lint/unit/startup/Python/bundle/Playwright and Windows deployment smoke; document required branch checks and review policy.
- [ ] Unify the runtime, API, backup, restore and retention artifact directory; add a real-run artifact backup/restore regression.
- [ ] Fix `/ready`/soak field agreement and surface maintenance-loop exceptions in structured logs and degraded health.
- [ ] Produce initial operator notes for startup, health, logs, backup and rollback.

Exit gate:

- One clean/tagged source baseline; no stale completed active task.
- Required CI is green on a PR and cannot be bypassed on the protected branch without recorded admin override.
- Backup/restore smoke proves a historical screenshot/Trace remains downloadable.
- Forced maintenance failure is visible to operators; soak reports healthy service correctly.

Rollback:

- Operational fixes land in independent commits and do not change IAM/schema.
- CI can be corrected without weakening existing `test:all`; artifact-path migration preserves/copies existing files before switching.

## Phase 1: Controlled Multi-Team Pilot

Goal: make authentication, authorization, isolation and HTTPS strong enough for a controlled company pilot.

- [ ] Add first-super-admin bootstrap and close production registration.
- [ ] Add invitation storage/API/UI: admin/member selection, 24h one-time token, revoke/expire/accept, existing-account membership and redacted audit; consumed-token replay returns `410 INVITE_ALREADY_USED` without account/workspace detail or duplicate effects.
- [ ] Add account enable/disable, workspace membership removal, role change, password recovery and immediate session revocation.
- [ ] Replace the eight-role/allow-all split with the super-admin/admin/member policy and enforce it on every backend route and frontend action.
- [ ] Add workspace administration UI for members, roles, invites and account state; prevent last-admin/last-super-admin lockout.
- [ ] Build the executable route/resource authorization matrix and cross-workspace/project negative suite.
- [ ] Add remote-change polling/version signal and conflict actor/time without overwriting local drafts.
- [ ] Add identity, global-admin access and retention-policy-change audit coverage; do not claim or activate complete retention enforcement in Phase 1.
- [ ] Deploy behind approved HTTPS termination, bind AutoFlow to loopback, enforce Secure cookies and service-account ACLs.

Exit gate:

- Two workspaces with super-admin, admins and members pass the full positive/negative role matrix.
- Direct API calls cannot bypass hidden UI actions; disabled/removed users lose access immediately.
- Consumed-invite replay returns `410 INVITE_ALREADY_USED` without account/workspace detail and never duplicates account, membership, password, session or successful-accept audit effects.
- Cross-project IDs cannot read, mutate, download or delete another workspace's data/artifacts.
- LAN browser uses HTTPS only; HTTP does not expose an authenticated app.
- A second member's committed change appears within the documented interval; dirty local work survives conflict.

Rollback:

- Take a verified pre-migration backup and retain a tested prior package.
- IAM migration has deterministic legacy-role mapping and fresh/upgrade tests; rollback restores both package and matching DB when schema is incompatible.

## Phase 2: Stable Internal Production

Goal: prove recovery, concurrency, capacity, release repeatability and operational ownership for the confirmed target.

- [ ] Implement global runner concurrency default 2 and per-workspace default 1 with eligible FIFO scheduling and isolated cancellation/recovery.
- [ ] Replace concurrent use of the shared SQLite connection with safe per-thread connections or a serialized persistence boundary; stress transaction/idempotency paths.
- [ ] Implement and activate configurable retention under DATA-01: audit 180d, runs/events 90d, artifacts 15d; begin with dry-run/capacity review, then require orphan checks and cleanup audit summaries before destructive enforcement.
- [ ] Automate daily encrypted/off-host backup, age/failure alerting and manifest/hash verification.
- [ ] Execute and record a timed full restore proving `RPO <= 24h` and `RTO <= 4h`; repeat quarterly.
- [ ] Lock Python dependencies and build immutable versioned deployment packages with checksum and SBOM; validate fresh install, upgrade and DB-aware rollback.
- [ ] Add a tested platform encryption-key rotation path using versioned key IDs/keyring or transactional offline re-encryption; preserve rollback and mixed-key readability during migration.
- [ ] Add metrics/dashboards/alerts for API, queue, runner, schedules, notifications, backup, maintenance and host resources.
- [ ] Run the declared 10-workspace/100-account/20-user/500-run capacity profile and a representative soak; publish hardware and P95/error/queue/resource evidence.
- [ ] Add risk-based coverage thresholds, dependency/security/secret scanning and an exception process.
- [ ] Complete user, workspace-admin, operator, incident, backup/restore, upgrade/rollback and release documentation; run a non-author game day.
- [ ] Perform cross-phase release review and record residual risks/accepted limits.

Exit gate:

- All Phase 0/1 gates remain green under concurrency and capacity load.
- Queue honors global/workspace limits with no starvation, duplicate completion or cross-run browser/artifact cancellation.
- Capacity profile meets thresholds established before the run and leaves sufficient disk headroom for retention + backup.
- Retention tests prove expired records/artifacts are removed at the configured boundary, newer data is preserved, dry-run matches the destructive selection and no orphan rows/files remain.
- A non-author operator restores the system within 4 hours from a backup no older than 24 hours.
- One immutable release package is installed and rolled back in staging using only the runbook.

Rollback:

- Runner concurrency can be set back to global `1` without data/schema rollback.
- Retention defaults first ship in dry-run mode; destructive cleanup activates only after count/byte review and backup.
- Package rollback restores the matching pre-upgrade DB backup when migrations are not backward compatible.

## Phase 3: Scale And Governance Enhancements

Trigger only when business evidence exceeds the confirmed boundary.

- [ ] Evaluate corporate OIDC/SSO/LDAP and MFA.
- [ ] Export audit to immutable external storage and extend retention for compliance.
- [ ] Evaluate warm standby/HA and a database beyond single-node SQLite if RPO/RTO tightens.
- [ ] Evaluate multi-machine agents, higher concurrency and workspace quotas after measured saturation.
- [ ] Re-open external/mutually untrusted tenant isolation only as a new architecture task.

Phase 3 is not required for the current single-company internal-production decision.

## Suggested Child Tasks And Order

1. `production-baseline-governance-ci` (GOV-01, CI-01)
2. `artifact-backup-health-observability-fixes` (BKP-01, OBS-01)
3. `local-accounts-membership-three-role-rbac` (IAM-01, IAM-02, IAM-03, AUD-01)
4. `route-wide-workspace-project-isolation` (ISO-01)
5. `https-service-account-secret-operations` (SEC-01, OPS-01, SEC-02)
6. `multi-user-remote-change-awareness` (COL-01)
7. `managed-runner-workspace-concurrency` (RUN-01)
8. `retention-backup-restore-rpo-rto` (DATA-01, BKP-02)
9. `capacity-observability-release-hardening` (CAP-01, REL-01, OBS-02, QA-01)
10. `production-runbooks-and-release-governance` (DOC-01, GOV-02)

Dependencies:

```text
Phase 0 baseline/ops fixes
  -> IAM/RBAC -> route isolation -> controlled pilot
  -> runner concurrency + retention/recovery + capacity
  -> stable internal production review
```

IAM/RBAC must precede the route isolation matrix because the matrix needs the final role policy. Artifact path repair precedes backup automation and retention. Runner concurrency precedes final capacity proof. Documentation evolves with each child and is exercised at the Phase 2 game day.

## Validation Commands And Exercises

Repository gates:

```bash
npm run build
npm run lint
npm run test:unit
npm run test:startup
npm run test:py
npm run check:bundle
npm run test:e2e
npm run test:windows
```

Additional gates to add in child tasks:

- IAM/authorization API matrix and two-workspace Playwright journey.
- Fresh-install and legacy-role migration tests.
- HTTPS/cookie/origin deployment smoke.
- Real artifact backup and clean-target restore smoke.
- Runner concurrency/cancel/restart stress suite.
- Retention dry-run/orphan/integrity suite.
- Repeatable load/soak profile with declared thresholds.
- Timed quarterly recovery game day and versioned release rollback exercise.

## Final Review Checklist

- [ ] Every gap ID is owned by exactly one child or explicitly deferred to Phase 3.
- [ ] P0 gaps have observable tests/exercises, not documentation-only closure.
- [ ] External organization settings (branch protection, backup target, certificate and alert routing) have named human owners and evidence links.
- [ ] No child weakens secret redaction, project isolation, revision/run reproducibility or existing `test:all` gates.
- [ ] The user reviews this latest PRD/design/roadmap before any task is started.
