# Implementation Plan

## Ordered Checklist

1. Add the Node `>=20.12` runtime declaration and Git ignore rules for local
   dotenv files while retaining a safe `.env.example` template.
2. Extend `scripts/start-production.mjs` with configuration resolution, Linux
   regular-file/owner/mode checks, native `parseEnv` feature detection, and
   environment merging before prerequisite validation and process spawn.
3. Extend `scripts/start-production.test.mjs` with default-file, explicit-path,
   precedence, Node dotenv syntax, missing/invalid path, owner/mode, and
   legacy environment-only regression cases.
4. Update README and the backend production-startup contract with the WSL
   bootstrap flow, `chmod 600`, `AUTOFLOW_CONFIG_FILE`, environment priority,
   and Node requirement. Do not alter the Windows XML secret injection flow.
5. Run focused startup tests, build/lint, and the complete project gate.

## Validation

- `npm run test:startup`
- `npm run build`
- `npm run lint`
- `npm run test:all`
- Manual WSL smoke: protected root `.env` plus `npm run start`, then a mode
  failure with `chmod 644 .env`; use temporary files and never create a real
  secret in the repository.

## Risk And Rollback

- Filesystem permissions differ on Windows-mounted paths. The documented,
  supported local-file path is a WSL/Linux filesystem where ownership and mode
  bits are authoritative; Windows service XML remains the supported Windows
  secret source.
- Do not call `process.loadEnvFile`, because it mutates global process state
  and does not express the required inherited-environment precedence.
- If this startup behavior must be rolled back, remove only the configuration
  resolution layer and engine declaration; `npm run start` continues to accept
  explicitly inherited environment variables.
