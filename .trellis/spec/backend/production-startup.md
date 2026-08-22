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
- `PLATFORM_SECRET_KEY`: required, non-blank. Alternatively
  `PLATFORM_SECRET_KEY_FILE` may point to a readable, non-blank key file
  (absolute, or relative to the repository root); the Node gate validates the
  file and the Python service reads it, mirroring `services.py`. A direct
  `PLATFORM_SECRET_KEY` always wins when both are set.
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

| Condition                                                                      | Result                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `dist/index.html` is absent                                                    | startup fails with `Run \`npm run build\` first` and no listener      |
| `PLATFORM_SECRET_KEY` is absent or blank                                       | startup fails with the required variable and no listener              |
| explicit config path is absent, invalid, or unreadable                         | startup fails with the path and no listener                           |
| selected config file is not regular, not user-owned, or mode is too permissive | startup fails and recommends `chmod 600 <file>` for permission errors |
| default `.env` is absent                                                       | startup continues with inherited environment values                   |
| no host/port overrides                                                         | binds `127.0.0.1:8787`                                                |
| explicit host or `PORT`                                                        | binds the supplied values                                             |
| former Worker URL                                                              | FastAPI 404, never a compatibility handler                            |

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

## Scenario: Windows PowerShell Source Compatibility

### 1. Scope / Trigger

- Trigger: adding or editing a deployment PowerShell script under `scripts/`,
  or changing the Windows deployment smoke gate.
- Scope: the supported deployment shell is Windows PowerShell 5.1 as well as
  newer PowerShell hosts. GitHub Windows runners are the portability proof.

### 2. Signatures

- `npm run test:windows` -> `powershell.exe -NoProfile -ExecutionPolicy Bypass
  -File scripts/windows-scripts-smoke.ps1`.
- Every tracked `scripts/*.ps1` deployment source file contains only ASCII
  bytes (`0x00` through `0x7F`).

### 3. Contracts

- Deployment script source, including prompts, comments, and diagnostics, is
  ASCII-only. Generated data may still use an explicit output encoding where
  its file contract requires it.
- This avoids Windows PowerShell 5.1 interpreting a no-BOM UTF-8 source file
  through a legacy code page, which can turn non-ASCII bytes into parser-significant
  punctuation on a hosted runner.
- `windows-scripts-smoke.ps1` scans every `scripts/*.ps1` byte stream before
  `Parser::ParseFile`; a non-ASCII byte is a smoke-test failure even if the
  current local PowerShell configuration parses the file.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| A deployment PowerShell source contains a byte above `0x7F` | Windows smoke fails with the script name and the ASCII-source contract |
| All deployment PowerShell sources are ASCII and parse cleanly | Windows smoke proceeds to service-template and backup/restore checks |
| A script has a syntax error | `Parser::ParseFile` reports it with the source script name |

### 5. Good / Base / Bad Cases

- Good: use `"Enter a PLATFORM_SECRET_KEY with at least 32 characters"` in a
  deployment prompt and run `npm run test:windows` on `windows-latest`.
- Base: use `Set-Content -Encoding UTF8` when producing an operational data
  file; that output encoding does not relax the source-file ASCII contract.
- Bad: add localized text directly to a no-BOM `.ps1` source file because it
  happened to parse on one developer workstation.

### 6. Tests Required

- `scripts/windows-scripts-smoke.ps1`: assert byte-level ASCII compatibility
  and parse every deployment PowerShell source before executing the backup /
  restore smoke.
- `deployment-windows` in `.github/workflows/phase0-ci.yml`: run
  `npm run test:windows` on `windows-latest` for the supported-host proof.

### 7. Wrong vs Correct

#### Wrong

```powershell
Read-Host -AsSecureString "localized deployment prompt"
```

#### Correct

```powershell
Read-Host -AsSecureString "Enter a PLATFORM_SECRET_KEY with at least 32 characters"
```

## Scenario: Operational Readiness And Managed Maintenance

### 1. Scope / Trigger

- Trigger: changing FastAPI lifecycle wiring, `/health`, `/ready`, recurring maintenance, or the Platform runtime artifact location.
- Scope: `create_app` owns the service-scoped maintenance state and registers its lifespan with FastAPI. The canonical runtime artifact directory is `PLATFORM_DATA_DIRECTORY/artifacts`.

### 2. Signatures

- `create_app(services: PlatformServices | None = None) -> FastAPI` constructs the application with `lifespan=...` and exposes `app.state.maintenance_health`.
- `GET /health` -> process liveness payload `{ "ok": true, "queue": "online" }`.
- `GET /ready` -> `{ "ready": boolean, "maintenance": { "healthy": boolean, "lastFailureAt": string | null, "failureCode": string | null } }`.
- A failed maintenance pass writes the JSON log event `maintenance.failed` with `failureAt` and `failureCode` only.

### 3. Contracts

- `/health` stays independent of SQLite and maintenance state. `/ready` runs `PRAGMA quick_check` on each request.
- A healthy database returns HTTP 200 even when maintenance is degraded; callers distinguish this state through `maintenance.healthy: false`. A SQLite exception or non-`ok` result returns HTTP 503 and `ready: false`.
- Readiness payloads and maintenance logs must never include exception text, database URLs, credentials, tokens, or artifact paths.
- A later complete maintenance pass sets `healthy: true`, clears `failureCode`, and retains `lastFailureAt` as the latest failure history. Retention cleanup is marked complete only after every cleanup statement succeeds.
- `PLATFORM_ARTIFACT_DIRECTORY` is not a runtime contract. ManagedRunner, backup, restore, retention, and Windows smoke use the data-root `artifacts` directory. When a backup contains an artifacts directory, restore replaces the runtime target with its contents, including an empty directory.

### 4. Validation & Error Matrix

| Condition                                               | Result                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| SQLite quick check is `ok`; maintenance is healthy      | `/ready` returns HTTP 200, `ready: true`, `maintenance.healthy: true`                    |
| SQLite quick check raises or is not `ok`                | `/ready` returns HTTP 503, `ready: false`, with the safe maintenance object              |
| Maintenance pass raises                                 | State becomes unhealthy and logs `maintenance.failed` without the exception message      |
| Later full maintenance pass succeeds                    | State becomes healthy; the previous failure timestamp remains                            |
| Artifact backup contains an empty `artifacts` directory | Restore creates an empty `data/artifacts` directory and removes stale restored artifacts |

### 5. Good / Base / Bad Cases

- Good: pass the closure to `FastAPI(..., lifespan=lifespan)` so the maintenance task actually runs in production, then test the app's lifespan context.
- Base: a database-ready process with a failed maintenance pass remains process-ready while publishing explicit degraded maintenance state.
- Bad: define an `@asynccontextmanager` inside `create_app` but do not pass it to FastAPI; this silently leaves maintenance inactive.

### 6. Tests Required

- `server-py/tests/unit/test_operational_readiness.py`: data-root ManagedRunner path, authorized download after restore fixture, normal/degraded/SQLite-failure readiness, redacted log event, lifespan startup, and failed retention cleanup retry behavior.
- `scripts/windows-scripts-smoke.ps1`: backup and restore a real `data/artifacts` fixture, then verify an empty artifact backup clears a stale restored artifact.
- Relevant startup and Playwright checks continue to prove the production service can start with the registered lifespan.

### 7. Wrong vs Correct

#### Wrong

```python
app = FastAPI(title="AutoFlow")

@asynccontextmanager
async def lifespan(_app):
    asyncio.create_task(_maintenance_loop(services))
    yield
```

#### Correct

```python
@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(_maintenance_loop(services, maintenance_health))
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

app = FastAPI(title="AutoFlow", lifespan=lifespan)
```
