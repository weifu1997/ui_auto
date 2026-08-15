# Backend (Platform) Development Guidelines

Server-side conventions and executable contracts for the Platform API layer under `server-py/`.

## Runtime and Tooling

- Python 3.12+, FastAPI, uvicorn, sqlite3, playwright sync API, cryptography, openpyxl, pytest.
- SQLite database (`server/.data/platform.sqlite` by default), WAL mode, FK constraints ON after migrations.
- Route handler: `server-py/autoflow/handler.py` (auth/workspace/project/automation endpoints) + `server-py/autoflow/services.py` (services, notifications, analytics, audit writer); application root is `server-py/autoflow/main.py`.
- Tests: `server-py/tests/unit` with `npm run test:py`, Python smoke scripts under `server-py/tests/smoke/`.
- Environment setup and startup: `npm run setup:py`, `npm run server:py`, `npm run test:py`.

## Guidelines Index

| Guide | Coverage |
| --- | --- |
| [Audit & Governance Contracts](./audit-governance.md) | Audit event naming, audit query API, analytics API, notification env wiring, secret snapshot mechanics |
