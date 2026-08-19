# Team Production Readiness Gap Register

> Target: one company, up to 10 internal workspaces, sharing one deployment.
> Baseline: 100 accounts, 20 concurrent web users, 500 runs/day, global runner concurrency 2, per-workspace concurrency 1.

## Severity

- P0: blocks the confirmed internal-production target.
- P1: required shortly after the controlled pilot or before wider adoption.
- P2: scale, compliance or resilience enhancement outside the first production gate.

## Register

| ID | Type / Dimension | Priority / Phase | Gap And Evidence | Impact | Suggested Owner | Exit Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| GOV-01 | Engineering / governance | P0 / Phase 0 | Eight Trellis tasks are active; completed acceptance lists remain `in_progress`, while planning tasks lag current code. | No reliable release baseline; duplicate or conflicting work can ship. | Tech lead | Every active task is reconciled to code, archived or re-scoped; one tagged baseline and owner per remaining task. |
| CI-01 | Engineering / quality gate | P0 / Phase 0 | `package.json:14-23` defines broad local checks, but no tracked CI workflow or required-check policy exists. | Tests can be skipped and branch state is not reproducible. | DevOps + QA | Linux and Windows CI run the agreed matrix on every PR; protected branch requires green checks and review. |
| BKP-01 | Operations / recovery | P0 / Phase 0 | Runtime writes artifacts under `data/artifacts`, while service config, backup and retention use root `artifacts` (`services.py:410-422`, `backup.ps1:13`). | A successful backup can omit screenshots and Trace files. | Backend + DevOps | One canonical artifact directory; backup manifest includes DB and artifacts; a restored run downloads its artifact successfully. |
| OBS-01 | Operations / observability | P0 / Phase 0 | `/ready` returns `ready`, soak reads `ok`; maintenance catches all exceptions silently (`main.py:158-161`, `:223-279`). | Schedules, notifications, retention or watchdog can fail without operator signal. | Backend + DevOps | Ready/soak contract test passes; maintenance failures emit structured error, counter and alertable health state. |
| IAM-01 | Product / identity | P0 / Phase 1 | Registration is open and always creates a private owner workspace; member/invite APIs were removed (`handler.py:209-280`, deployment decision `:66-69`). | Teams cannot join or govern a shared workspace. | Backend + Frontend | Public registration is closed; bootstrap super-admin and 24h one-time invite flow cover new/existing accounts, revoke, expiry and `410 INVITE_ALREADY_USED` replay without detail leakage or duplicate effects. |
| IAM-02 | Product / authorization | P0 / Phase 1 | Backend retains eight roles; workspace capability checks ignore requested capability; frontend `canUseCapability` always returns true (`services.py:631-639`, `shared.tsx:123-132`). | Privilege boundaries are inconsistent and UI exposes unauthorized commands. | Backend + Frontend | One super-admin/admin/member matrix is shared by route policy and UI; direct API negative tests prove UI cannot bypass it. |
| IAM-03 | Product / account lifecycle | P0 / Phase 1 | No product account disable, membership removal, password reset or immediate session-revocation lifecycle exists. | Departed or compromised users retain access until session expiry. | Backend + Security | Super-admin can disable accounts; admin can remove workspace membership; affected sessions are revoked immediately; events are audited. |
| SEC-01 | Operations / transport security | P0 / Phase 1 | LAN deployment is documented as HTTP and Secure cookies are opt-in (`docs/决策-内网部署形态与平台裁剪.md:14`, `auth.py:58-78`). | Credentials and authenticated traffic can be observed or altered on the LAN. | DevOps + Security | Approved TLS termination, loopback-only app listener, Secure cookies, proxy/origin validation and HTTPS smoke test. |
| ISO-01 | Product / data isolation | P0 / Phase 1 | Data has workspace/project columns and some negative tests, but no route-wide authorization inventory; a dependent-row deletion bug previously crossed project boundaries. | IDOR or cross-project mutation can expose another team's data. | Backend + QA | Every route/resource pair has unauthenticated, non-member, wrong-workspace and insufficient-role tests; child IDs are resolved through their authorized parent. |
| COL-01 | Product / collaboration | P0 / Phase 1 | Version conflicts and outbox recovery exist, but workspace hydration has no continuous remote-change subscription/poll contract (`ServerWorkspaceSynchronizer.tsx:147-152`). | A member may work from stale data until conflict or reload. | Frontend + Backend | Remote changes become visible within a documented interval; dirty local drafts are never overwritten; conflict actor/time is visible. |
| AUD-01 | Product / audit | P0 / Phase 1 | Audit infrastructure exists, but new identity/admin operations and retention-policy changes do not yet exist; no completeness matrix. | Sensitive administrative actions may be untraceable. | Backend + Security | Auth, invite, membership, role, account, secret, deletion, retention-policy and global-admin access events are complete and redacted; retention enforcement remains owned only by DATA-01. |
| OPS-01 | Operations / secret custody | P0 / Phase 1 | `PLATFORM_SECRET_KEY` is written into WinSW XML and there is no checked-in service-account/ACL or key-loss recovery runbook (`install.ps1:20-27`). | Local users may read the encryption key; key loss makes encrypted data unusable. | DevOps + Security | Dedicated service account, least-privilege ACLs, separate key escrow and tested key-loss/restore procedure; no key in backups stored with ciphertext. |
| BKP-02 | Operations / disaster recovery | P0 / Phase 2 | Backup helper validates SQLite, but scheduling, off-host copy, manifest/hash, alerting and timed restore evidence are absent. | Confirmed RPO <=24h / RTO <=4h is not proven. | DevOps | Daily automated encrypted/off-host backup, failure alert, quarterly drill, timed restore <=4h and newest recovered point <=24h. |
| RUN-01 | Product / execution capacity | P0 / Phase 2 | ManagedRunner owns one active item and one worker thread (`managed_runner.py:13-21`, `:113-167`). | Confirmed multi-workspace concurrency target cannot be met. | Backend | Configurable global limit default 2, workspace limit default 1, eligible FIFO scheduling, cancellation/restart isolation and no shared-connection transaction races. |
| CAP-01 | Evidence / capacity | P0 / Phase 2 | No repeatable multi-user/load evidence exists for the confirmed target. | SQLite, API, browser processes or disk may saturate under team load. | QA + DevOps | Declared hardware passes 10 workspaces/100 accounts/20 users/500 runs-day profile with agreed P95, error, queue and resource thresholds. |
| DATA-01 | Operations / retention | P0 / Phase 2 | Current cleanup covers events/outputs/deliveries, not the confirmed complete retention model; root artifact cleanup can leave DB rows (`main.py:247-276`, `retention.ps1:3-8`). | Storage grows unpredictably or APIs reference missing files. | Backend + DevOps | Configurable 180d audit, 90d run/event and 15d artifact cleanup is transactional/project-safe, has dry-run and leaves no orphans. |
| SEC-02 | Product / encryption | P1 / Phase 2 | AES-GCM data has no key identifier or platform-key rotation path (`crypto.py:16-49`). | Routine key rotation can make existing secrets and notification configs unreadable. | Backend + Security | Versioned key IDs/keyring or a transactional offline re-encryption tool rotates the platform key with backup, rollback and mixed-version tests. |
| REL-01 | Engineering / release | P1 / Phase 2 | Python requirements use lower bounds and install/upgrade builds on the production host (`requirements.txt:1-8`, `upgrade.ps1:11-16`). | Two deployments of the same source can contain different dependencies. | DevOps | Locked Python dependencies, immutable versioned package, checksums/SBOM, staging migration check and rollback evidence. |
| OBS-02 | Operations / monitoring | P1 / Phase 2 | WinSW rotates process logs, but there are no service-level metrics, dashboards or alert thresholds. | Operators learn about queue, disk or notification problems from users. | Backend + DevOps | Metrics/log dashboard and alerts cover ready state, queue age/depth, runs, notifications, backup age, disk and maintenance errors. |
| QA-01 | Engineering / security quality | P1 / Phase 2 | No coverage thresholds or dependency/security scanning are enforced (`vitest.config.ts:4-10`). | Important paths can lose tests; vulnerable dependencies can enter releases. | QA + Security | Risk-based coverage thresholds plus dependency, secret and static security checks run in CI with documented exception process. |
| DOC-01 | Documentation / operations | P0 / Phase 2 | There is no production operations, identity, recovery, incident, upgrade or release runbook. | Team ownership and recovery depend on the original developer. | Tech lead + DevOps | User/admin/operator docs and on-call runbooks are exercised by someone other than the author. |
| GOV-02 | Engineering / ownership | P1 / Phase 2 | No tracked CODEOWNERS, contribution policy, release checklist, changelog or security-response policy. | Review responsibility and change traceability remain informal. | Tech lead | Ownership, PR/review, release, rollback, vulnerability and task-archive policies are checked in and used for one release. |
| SCALE-01 | Architecture / deferred scale | P2 / Phase 3 | Single node, single SQLite database and no external audit sink/IdP. | Future compliance, HA or cross-company use needs architectural change. | Architecture | Reassess only when scale or compliance exceeds the confirmed target; do not block first internal production. |

## Relationship To Existing Active Tasks

| Existing Task | Relationship To This Register |
| --- | --- |
| `08-15-next-roadmap-planning` | Overlaps roadmap ownership; GOV-01 must reconcile it with this evidence-backed roadmap before either becomes the release source of truth. |
| `08-15-flow-recording-mvp` | Acceptance appears complete but status is stale; GOV-01 owns closure. Its recording/run contracts are regression constraints for IAM-02, ISO-01, RUN-01 and CAP-01, not remediation ownership. |
| `08-15-flow-batch-execution-mvp` | Existing batch behavior is a regression and capacity input for RUN-01/CAP-01; the task does not own workspace-fair concurrent scheduling. |
| `08-16-legacy-e2e-failures` | Acceptance appears complete but status is stale; GOV-01 owns closure. Green E2E remains a CI-01 baseline. |
| `08-16-flow-retry-reproduction-correctness` | Planning has drifted behind current code; GOV-01 owns re-scope/closure. Retry idempotency is a RUN-01 regression constraint. |
| `08-19-frontend-visual-consistency-and-ui-alignment` | Coordinate before IAM/COL frontend work to avoid parallel edits; it does not own IAM-01, IAM-02, IAM-03 or COL-01 behavior. |
| `08-19-refactor-templates` | Coordinate sequencing with route-wide authorization and release baseline work; it does not close any gap in this register. |
| `08-19-team-production-readiness-assessment` | Owns this audit, gap register and roadmap only; it does not close product or operations gaps. |

All non-deferred gap IDs are assigned exactly once in `implement.md` under "Suggested Child Tasks And Order". `SCALE-01` is explicitly deferred to Phase 3.

## Current Applicability

- Current: controlled single-owner internal pilot only.
- After Phase 0: evidence-backed development baseline, still not team production.
- After Phase 1: controlled multi-team pilot with enforceable identity and isolation.
- After Phase 2: eligible for the confirmed single-company internal-production target, subject to recorded residual risks.
