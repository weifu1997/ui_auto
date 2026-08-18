# Technical Design

## Boundaries

The supported runtime becomes one Platform application:

```text
npm run build -> dist/
npm run start -> start-production.mjs -> server-py.mjs -> FastAPI Platform + dist/
```

Vite's `dev` command may remain for HMR while editing, but it is a build-tooling mode only. It must not switch authentication, navigation, storage, API selection, or execution behavior.

## Production entry contract

Add a small Node entry script, `scripts/start-production.mjs`, which:

1. resolves the repository root and checks `dist/index.html` (or the configured static directory) before spawning anything;
2. checks `PLATFORM_SECRET_KEY` is present and non-blank, with an actionable error mentioning how to provide it;
3. creates a child environment with `NODE_ENV=production` and leaves explicit `AUTOFLOW_LISTEN_HOST`, `PORT`, CORS, data, and browser settings untouched;
4. delegates process execution to the existing Python launcher and forwards its exit code and signals.

`package.json` makes `start` point at this entry. `server` may remain as a compatibility alias only if it invokes the same checked entry; `server:py` remains an internal launcher and must not be documented as the deployment command. The Python launcher keeps the secure defaults (`127.0.0.1`, `8787`) and production static serving is selected by the wrapper's environment rather than an independent developer flag.

## Single product mode

Remove product decisions based on `import.meta.env.PROD` and `VITE_AUTH_REQUIRED`. Platform authentication, server workspace hydration, navigation, routes, persistence, and API clients are unconditional. The API layer uses same-origin `/api`; no local Worker base URL or environment switch remains.

Delete local-only stores, seeded demo data, `local-worker-run`, Worker error fallback, Worker run/detail branches, local picker panels, and Worker status indicators. Existing Platform run, validation, recording, artifact, and remote-debug flows remain the source of truth. Where recording currently obtains browser storage state through `WorkerService`, extract that narrowly required session-state provider into the supported recording/debug service before deleting `worker.py`; no `/api/projects/*` route or Worker persistence is retained.

## Backend boundary

`create_app` includes only Platform routes, health/readiness/fixture routes, and static serving. Remove `WorkerService` construction, `app.state.worker`, `create_worker_router`, Worker-specific shutdown, and the `worker.py` module once any required recording state provider has moved. The default production response for a former Worker path is the normal FastAPI 404, not a compatibility error contract.

## Test and deployment flow

Playwright uses one built production server: build before the run, launch `npm run start` with an isolated data/artifact directory and a test secret, and target its same-origin URL. Remove the `VITE_AUTH_REQUIRED` dev-auth server and split projects that only exist to compare dev and production. Replace local Worker E2E assertions with Platform contracts or delete tests whose behavior is intentionally removed. Keep a focused negative smoke asserting that a former Worker URL is unavailable.

Unit and Python tests follow the same boundary: retain Platform and recorder contracts, remove Worker router/service tests, and add entry-script checks for missing `dist`, missing secret, default host, and explicit host/port overrides. Documentation and Windows service templates use the same `build` then `start` contract and no longer promise loopback-only Worker compatibility.

## Compatibility and rollout

This is a deliberate breaking change for callers of `/api/projects/*`, `worker-api.ts`, and Worker data. No data migration is planned. The rollout is atomic: update frontend, backend, scripts, tests, and docs together so a build cannot serve UI code that calls removed endpoints. Rollback is a source revert before deployment; do not restore the removed route behind a hidden environment switch.
