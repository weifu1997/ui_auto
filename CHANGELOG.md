# Changelog

All notable changes are documented here. Version numbers follow the release
sequence, not semantic versioning (no stable tagged release yet).

## Unreleased

### Phase 2 — Stable internal production

- Runner: global/per-workspace concurrency with eligible FIFO scheduling (RUN-01).
- Retention: configurable 180d audit / 90d run / 15d artifact cleanup with dry-run
  and orphan-safe cascade (DATA-01).
- Backup: SHA-256 manifest + restore-time verification and byte-level encryption
  helpers (BKP-02).
- Observability: `GET /metrics` JSON endpoint (OBS-02).
- Quality: frontend coverage thresholds and CI dependency/security scanning
  (QA-01).
- Release: pinned `requirements.lock` + `verify-lock.py` (REL-01).

### Phase 1 — Controlled multi-team pilot

- Local accounts, workspace membership and three-role RBAC with audited,
  replay-safe invitations (IAM-01/02/03, AUD-01).
- Route-wide workspace/project isolation and authorization matrix (ISO-01).
- Secure cookies, loopback binding and HTTPS enforcement (SEC-01).
- Remote-change polling and conflict actor/time visibility (COL-01).

### Phase 0 — Baseline

- Production baseline governance and Phase 0 CI gate (GOV-01, CI-01).
- Artifact backup and health observability fixes (BKP-01, OBS-01).
