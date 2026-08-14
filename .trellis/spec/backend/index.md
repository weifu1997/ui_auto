# Backend (Platform) Development Guidelines

Server-side conventions and executable contracts for the Platform API layer under `server/`.

## Runtime and Tooling

- Node `node:sqlite` database (`server/.data/platform.sqlite` by default), WAL mode, FK constraints ON after migrations.
- Route handler: `server/platform-handler.ts` (auth/workspace/project/automation endpoints) + `server/platform.ts` (services, notifications, analytics, audit writer).
- Tests: `server/platform.test.ts` (unit, `@vitest-environment node`), `server/platform-contract-smoke.ts` (full E2E contract smoke via `npm run test:platform`).

## Guidelines Index

| Guide | Coverage |
| --- | --- |
| [Audit & Governance Contracts](./audit-governance.md) | Audit event naming, audit query API, analytics API, notification env wiring, secret snapshot mechanics |
