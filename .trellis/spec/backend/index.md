# Backend (Platform) Development Guidelines

Server-side conventions and executable contracts for the Platform API layer under `server-py/`.

## Runtime and Tooling

- Python 3.12+, FastAPI, uvicorn, sqlite3, playwright sync API, cryptography, openpyxl, pytest.
- SQLite database (`data/platform.sqlite` by default (repo-root `data/`, aligning with the production `%BASE%\\data` layout)), WAL mode, FK constraints ON after migrations. `PlatformServices.database` is a per-thread connection property (WAL + 30 s busy timeout): the event loop, the maintenance thread (`asyncio.to_thread`), and ManagedRunner worker threads must never share one sqlite3 connection — a shared connection interleaves `BEGIN IMMEDIATE` transactions and silently merges autocommit writes into open transactions. Multi-statement writes use explicit `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`; `with conn:` is not atomic under `isolation_level = None`.
- Route handler: `server-py/autoflow/handler/` package (domain route modules composed by `create_platform_router`; shared helpers in `handler/_shared.py`) + `server-py/autoflow/services/` package (domain mixins composed into `PlatformServices`; shared helpers in `services/_shared.py`); application root is `server-py/autoflow/main.py`.
- Revision checksum uses canonical execution snapshots from `server-py/autoflow/revision_snapshot.py`; display/transient fields such as `updatedAt`, `validation`, and step `status` do not create new revisions.
- Automation routes support schedule/webhook/channel updates, webhook secret rotation, and channel test delivery without exposing stored secrets.
- Run and delivery list endpoints support server-side `page`/`pageSize` filtering and return `total` alongside the existing `runs`/`deliveries` arrays.
- Tests: `server-py/tests/unit` with `npm run test:py`, Python smoke scripts under `server-py/tests/smoke/`.
- Environment setup and validation: `npm run setup:py`, `npm run test:py`, and
  `npm run start` for the supported production service. `server:py` is an
  internal launcher used by the production wrapper and is not a deployment
  entry point.

## Guidelines Index

| Guide                                                                 | Coverage                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [Audit & Governance Contracts](./audit-governance.md)                 | Audit event naming, audit query API, analytics API, notification env wiring, secret snapshot mechanics                          |
| [Identity, Membership & RBAC](./identity-membership-rbac.md)          | Local-account bootstrap, workspace roles/capabilities, safe invitation/reset lifecycles, session revocation and admin audit     |
| [Run Batch & Recording Contracts](./run-batch-recording-contracts.md) | Batch execution, run-record deletion, browser-recording routes, validation, lifecycle, isolation, and regression requirements   |
| [Assertion Field Contract](./assertion-field-contract.md)            | 断言字段/枚举/缺省/动作-判定映射/事件载荷与顺序；前端 `assertions.ts` 与后端 `assertion_contract.py` 的权威来源（单源化） |
| [Production Startup](./production-startup.md)                         | `npm run build` / `npm run start` prerequisites, environment contract, readiness/maintenance behavior, and Worker route removal |
| [Route-Wide Workspace And Project Isolation](./route-workspace-project-isolation.md) | Executable route inventory, parent-scoped child resolution, cross-workspace error and side-effect contracts |
