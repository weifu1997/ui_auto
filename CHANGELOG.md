# Changelog

All notable changes are documented here. Version numbers follow the release
sequence, not semantic versioning (no stable tagged release yet).

## Unreleased

### Reliability / security (code-review follow-up)

- Recording create/stop/cancel no longer block the FastAPI event loop.
- `/ready` and `/health` stay reachable over loopback HTTP when HTTPS is required,
  so Windows `upgrade.ps1` health checks no longer roll back a successful package.
- Production Python interpreter is pinned via `AUTOFLOW_PYTHON`; install copies
  exclude `.env`, venvs, and `.trellis`; Playwright Chromium installs into
  `PLAYWRIGHT_BROWSERS_PATH`.
- Run completion only enqueues notifications; the maintenance loop delivers them.
- Missing `PLATFORM_SECRET_KEY` fails closed unless `AUTOFLOW_ALLOW_INSECURE_DEV_KEY=1`.
- Notification/template errors return stable codes, not `str(exc)`.
- Login rate limits use `X-Forwarded-For` only behind `AUTOFLOW_TRUSTED_PROXY`.
- Backup manifest verify requires `platform.sqlite`; restore checks service stop.
- URL assertions wait for navigation; locator self-heal only runs on a miss and
  keeps role accessible names; assertion reports use unique filenames; redact
  failures keep the payload type; terminal recordings can import in-memory drafts;
  CI checks `uv.lock` before `uv sync --frozen`.
- Planning-tier follow-up: in-step run heartbeat, skip execution when queued
  cancel wins, transactional interrupted finalize, calendar-aligned run trend,
  recording slot fail-fast, capture honors testIdAttribute, cancel only signals
  the worker, PowerShell ShouldProcess/upgrade try scope, and five assertion
  actions in the contract.

### Phase 2 — Stable internal production

- Runner: global/per-workspace concurrency with eligible FIFO scheduling (RUN-01).
- Retention: configurable 180d audit / 90d run / 15d artifact cleanup with dry-run
  and orphan-safe cascade (DATA-01).
- Backup: SHA-256 manifest + restore-time verification and byte-level encryption
  helpers (BKP-02).
- Observability: `GET /metrics` JSON endpoint (OBS-02).
- Quality: frontend coverage thresholds and CI dependency/security scanning
  (QA-01).
- Release: Python 依赖迁移到 uv — `server-py/pyproject.toml` 声明 + 跨平台
  `server-py/uv.lock` 精确锁定，`setup-py.mjs` 用 `uv sync` 按锁安装；移除
  `requirements.lock` 参考锁与 `verify-lock.py`；Windows 生产部署在脚本内
  `pip install uv` 引导并按 `uv sync --no-dev --locked` 安装（生产不再装
  pytest/pytest-asyncio/httpx dev 组），CI 增加 `uv lock --check` 漂移护栏。

### Phase 1 — Controlled multi-team pilot

- Local accounts, workspace membership and three-role RBAC with audited,
  replay-safe invitations (IAM-01/02/03, AUD-01).
- Route-wide workspace/project isolation and authorization matrix (ISO-01).
- Secure cookies, loopback binding and HTTPS enforcement (SEC-01).
- Remote-change polling and conflict actor/time visibility (COL-01).

### Phase 0 — Baseline

- Production baseline governance and Phase 0 CI gate (GOV-01, CI-01).
- Artifact backup and health observability fixes (BKP-01, OBS-01).
