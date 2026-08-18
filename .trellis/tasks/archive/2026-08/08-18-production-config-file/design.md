# Technical Design

## Boundary

The Node production wrapper remains the only configuration-file reader:

```text
.env or AUTOFLOW_CONFIG_FILE
  -> start-production.mjs validates file and merges values
  -> NODE_ENV=production
  -> server-py.mjs -> Python Platform service
```

The Python service, frontend bundle, and Windows XML deployment contract keep
receiving ordinary process environment variables. No secret file is passed to
the browser or read by Python independently.

## Configuration Resolution

`scripts/start-production.mjs` will resolve exactly one optional dotenv file:

1. A non-empty inherited `AUTOFLOW_CONFIG_FILE` selects an absolute path or a
   path resolved from the repository root. This is an explicit request, so a
   missing or invalid target fails startup.
2. Otherwise, `<repo-root>/.env` is the default target. Its absence is normal;
   no file values are added and inherited environment variables remain usable.
3. A blank `AUTOFLOW_CONFIG_FILE` is invalid rather than silently selecting a
   different file.

On Linux, a selected existing file must be a non-symlink regular file, owned by
`process.getuid()`, with no group or other permission bits (`mode & 0o077 ===
0`). Permission failures name the file and recommend `chmod 600`. The Windows
service path is unaffected because it supplies the key through XML environment
variables; POSIX ownership/mode validation applies only where `getuid` is
available.

## Parsing And Merge

The wrapper declares Node `>=20.12` in `package.json` and uses native
`node:util` `parseEnv`. It will feature-check the API before parsing so older
Node versions receive an actionable error. The supported grammar is Node's
dotenv grammar, including comments and quoted values.

File values merge into a copy of the inherited environment only when that key
is not already present. An inherited empty value is still an explicit override;
for example an empty shell `PLATFORM_SECRET_KEY` produces the existing missing
secret error rather than falling back to the file. `NODE_ENV=production` is
forced after merging. The resulting environment is supplied both to static
build validation and the Python child process.

## Safety And Compatibility

- `.env` and `.env.*` are ignored by Git; `.env.example` remains trackable and
  documents variable names without real values.
- No file is loaded when the default `.env` is absent, preserving current
  service-manager and Windows XML behavior.
- The implementation uses no third-party dependency and leaves all existing
  `AUTOFLOW_*`, `PORT`, CORS, data, artifact, and browser settings available.
- Rollback is confined to the Node wrapper, engine declaration, docs, and
  template; no persisted data format changes.
