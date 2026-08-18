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
- `AUTOFLOW_CONFIG_FILE`: optional dotenv file path, relative to the repository
  root or absolute.
- Node.js `>=20.12`: required for the native `node:util` `parseEnv` parser.

### 3. Contracts

- The Node wrapper checks the configured static directory for `index.html` and
  checks the secret before spawning Python.
- The child environment always contains `NODE_ENV=production`; explicit host,
  port, CORS, data, artifact, and browser settings are preserved.
- The wrapper resolves one configuration file before prerequisite validation:
  an inherited non-blank `AUTOFLOW_CONFIG_FILE` is explicit and required; when
  it is absent, the repository root `.env` is optional. A blank
  `AUTOFLOW_CONFIG_FILE` fails startup.
- On Linux/WSL, an existing selected file must be a non-symlink regular file
  owned by the current user with no group or other permission bits. Use
  `chmod 600 <file>` to satisfy the permission check. Windows service XML
  continues to inject environment variables directly.
- File values only fill keys missing from the inherited environment. An
  inherited empty value remains an override, and `NODE_ENV=production` is
  forced after merging. Dotenv comments and quoted values use Node's native
  `parseEnv` grammar.
- FastAPI serves the built SPA and Platform API only. A former `/api/projects/*`
  Worker URL returns the ordinary 404 response.
- LAN exposure requires an explicit `AUTOFLOW_LISTEN_HOST=0.0.0.0` (or another
  chosen address); the default remains loopback.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `dist/index.html` is absent | startup fails with `Run \`npm run build\` first` and no listener |
| `PLATFORM_SECRET_KEY` is absent or blank | startup fails with the required variable and no listener |
| explicit config path is absent, invalid, or unreadable | startup fails with the path and no listener |
| selected config file is not regular, not user-owned, or mode is too permissive | startup fails and recommends `chmod 600 <file>` for permission errors |
| default `.env` is absent | startup continues with inherited environment values |
| no host/port overrides | binds `127.0.0.1:8787` |
| explicit host or `PORT` | binds the supplied values |
| former Worker URL | FastAPI 404, never a compatibility handler |

### 5. Good / Base / Bad Cases

- Good: in WSL/Linux, copy `.env.example` to `.env`, set `chmod 600 .env`,
  build once, and run `npm run start`; `/health`, the SPA, and
  `/api/platform/*` share one origin.
- Base: `npm run server` behaves exactly like `npm run start`.
- Bad: invoking `server:py` directly as deployment or reintroducing an
  environment switch that selects a local Worker product, or committing a
  real `.env` secret.

### 6. Tests Required

- `scripts/start-production.test.mjs`: missing build, missing secret, custom
  static directory, production environment propagation, default/explicit dotenv
  files, precedence, syntax, and file safety checks.
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

WSL/Linux configuration-file flow:

```text
cp .env.example .env
chmod 600 .env
npm run build
npm run start
```
