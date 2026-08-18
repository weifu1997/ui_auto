# Production Startup Contract

## Scenario: Single Platform Service Entry

### 1. Scope / Trigger

- Trigger: the frontend, FastAPI service, static build, and deployment templates
  must share one product boundary.
- Scope: the supported application entry is `npm run build` followed by
  `npm run start`; Vite dev remains an editing tool only.

### 2. Signatures

- `npm run build` -> writes `dist/index.html` and hashed assets.
- `npm run start` -> runs `scripts/start-production.mjs`, then the Python
  Platform service.
- `npm run server` -> compatibility alias to `npm run start`.
- `PLATFORM_SECRET_KEY`: required, non-blank.
- `AUTOFLOW_STATIC_DIRECTORY`: optional static directory, default `dist`.
- `AUTOFLOW_LISTEN_HOST`: optional listener override, default `127.0.0.1`.
- `PORT`: optional port override, default `8787`.

### 3. Contracts

- The Node wrapper checks the configured static directory for `index.html` and
  checks the secret before spawning Python.
- The child environment always contains `NODE_ENV=production`; explicit host,
  port, CORS, data, artifact, and browser settings are preserved.
- FastAPI serves the built SPA and Platform API only. A former `/api/projects/*`
  Worker URL returns the ordinary 404 response.
- LAN exposure requires an explicit `AUTOFLOW_LISTEN_HOST=0.0.0.0` (or another
  chosen address); the default remains loopback.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `dist/index.html` is absent | startup fails with `Run \`npm run build\` first` and no listener |
| `PLATFORM_SECRET_KEY` is absent or blank | startup fails with the required variable and no listener |
| no host/port overrides | binds `127.0.0.1:8787` |
| explicit host or `PORT` | binds the supplied values |
| former Worker URL | FastAPI 404, never a compatibility handler |

### 5. Good / Base / Bad Cases

- Good: build once, provide a secret, and run `npm run start`; `/health`, the
  SPA, and `/api/platform/*` share one origin.
- Base: `npm run server` behaves exactly like `npm run start`.
- Bad: invoking `server:py` directly as deployment or reintroducing an
  environment switch that selects a local Worker product.

### 6. Tests Required

- `scripts/start-production.test.mjs`: missing build, missing secret, custom
  static directory, and production environment propagation.
- `server-py/tests/unit/test_recording_state.py`: former Worker route is absent
  and returns the standard 404 response.
- Playwright Chromium project: built static UI launched by `npm run start`.
- Deployment smoke: rendered Windows service points to
  `scripts/start-production.mjs`.

### 7. Wrong vs Correct

#### Wrong

```text
set NODE_ENV=production
npm run server:py
```

#### Correct

```text
npm run build
set PLATFORM_SECRET_KEY=<long-random-secret>
npm run start
```
