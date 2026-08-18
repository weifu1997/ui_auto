# Implementation Plan

## Ordered checklist

1. Load the backend/frontend Trellis specs and map all Worker imports, route registrations, product-mode conditionals, test projects, and deployment command references. Record the exact retained recording/debug dependency before deleting any module.
2. Implement `scripts/start-production.mjs` and update `package.json` so `npm run start` validates `dist/index.html` and `PLATFORM_SECRET_KEY`, sets `NODE_ENV=production`, preserves explicit host/port overrides, and forwards the Python process result. Make any retained `server` alias call this checked entry.
3. Make the frontend Platform-only: remove `PROD`/`VITE_AUTH_REQUIRED` product branches, local seed/fallback state, Worker API clients and UI branches, then preserve Platform run, recording, validation, artifact, and remote-debug flows through their existing contracts.
4. Remove the Python Worker router/service and its lifecycle wiring. Extract only the browser storage/session capability still needed by supported recording/debug flows into an appropriately named Platform service, and ensure `create_app` exposes no `/api/projects/*` routes.
5. Rewrite tests and fixtures around the single product boundary. Add Node entry-script tests, a backend route-negative test, and production static smoke; migrate or remove Worker-only unit/E2E tests and remove the Vite auth shim from Playwright.
6. Update README, deployment decision docs, install/service templates, and smoke scripts with the shortest supported flow: `npm run build`, provide `PLATFORM_SECRET_KEY`, then `npm run start`; document explicit `AUTOFLOW_LISTEN_HOST=0.0.0.0` only for LAN exposure.
7. Run the focused checks, then the full quality gate. Confirm generated `dist` assets, same-origin Platform calls, no Worker imports/routes, and no stale `VITE_AUTH_REQUIRED` or legacy startup instructions remain.

## Validation commands

- `npm run build`
- `npm run lint`
- `npm run test:unit`
- `npm run test:py -- --collect-only -q`
- `npm run test:py`
- `npm run test:e2e -- --project=chromium`
- `npm run test:windows`
- `node scripts/start-production.mjs` with missing `dist` and missing secret cases, followed by an isolated real start with a test secret
- `rg -n 'VITE_AUTH_REQUIRED|create_worker_router|from .*worker|/api/projects' src server-py scripts tests README.md docs`

## Risk and rollback points

- Entry validation is isolated first; revert only `start-production.mjs`/scripts if launcher behavior breaks without touching product APIs.
- Frontend and backend Worker removal must land together; a build-time reference scan is a required gate before deleting the Python module.
- Recording may depend on Worker-owned browser session state; extract and test that dependency before removing `worker.py`.
- Existing dirty worktree changes are unrelated to this planning task and must be preserved. Do not reset or overwrite them.

## Completion Record

- `scripts/start-production.mjs` now validates the build and secret, forces the
  production environment, and delegates to the Python launcher without
  overriding explicit listener settings.
- The frontend no longer has a local product mode, demo seed, Worker API
  client, picker, or fallback run path. Platform project mapping remains only
  to resolve previously imported Platform project identifiers.
- The Python application no longer constructs or exposes the Worker router;
  recording login state is process-local inside the supported Platform service.
- Verified 2026-08-18: `npm run build`, `npm run lint`, `npm run test:unit`,
  `npm run test:startup`, `npm run test:py`, `npm run check:bundle`,
  `npm run test:e2e -- --project=chromium`, and `npm run test:windows`.
