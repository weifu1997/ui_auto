# 修复 Sauce Demo 发布管理页面报错

## Goal

Restore access to `/project/sauce-demo/platform` by replacing the abandoned
local Platform account state, so the user can register a new account.

## Confirmed Facts

- The Vite dev server returns the application shell for the reported URL with
  HTTP 200.
- `ProjectShell` lazy-loads `PlatformPage` for the `platform` route.
- The PlatformPage module transforms successfully in Vite, and the production
  build succeeds. A syntax or lazy-module error is therefore ruled out.
- An isolated Chromium visit to the URL renders the Platform login view with no
  page errors, console errors, or failed requests.
- The reported `POST /api/auth/register` response is `409
  EMAIL_ALREADY_REGISTERED`. The handler returns this when the email already
  has password credentials (`server/platform-handler.ts:76-84`).
- The reported `GET /api/auth/session` response is `401`. The session endpoint
  intentionally requires a valid bearer token or HttpOnly session cookie
  (`server/platform-handler.ts:132-136`); it is covered by contract tests.
- The standard client login flow first posts to `/auth/login`, then restores the
  cookie-backed session (`src/platform-api.ts:267-274`).
- The repository does not define a default Platform account or initial
  password. Test-only credentials are created in isolated temporary databases
  and do not apply to the running `server/.data/platform.sqlite` instance.
- Passwords are stored as credentials and cannot be recovered from the
  database; account recovery requires a known credential, an authenticated
  workspace owner/administrator, or an explicitly authorized local reset.
- The current local Platform database is not empty: it contains three users,
  three workspaces, two Platform projects, two project documents, and one flow
  revision. Reinitializing it would discard those Platform records.
- The user has confirmed that the two existing Platform projects are obsolete
  and has explicitly authorized resetting the complete local Platform database,
  including its accounts and workspaces.

## Requirements

- Make a recoverable backup of all three `platform.sqlite` files before any
  reset.
- Reset only the local Platform database; do not modify `autoflow.sqlite`,
  source files, or unrelated worktree changes.
- Restart the Platform service and verify that a new account can be registered
  and its session restored.

## Acceptance Criteria

- [x] The prior Platform database files are retained in a timestamped local
      backup directory.
- [x] A new Platform account can register successfully with an unused email
      and obtain a valid session. (Verified 2026-08-13 via API: register 201 +
      session cookie restore 200; logout 200 / login 200 / wrong-password 401.
      The temporary test account was removed from the local DB afterwards and
      the service restarted.)
- [x] `GET /health` reports the restarted service as online.

## Out of Scope

- Broader Platform workflow changes, visual redesign, and unrelated review
  findings.
- Modifying the local Worker database (`autoflow.sqlite`) or deleting the
  Platform backup.

## Key Decision

- The user authorizes reset of the abandoned Platform account, workspace, and
  project data after a recoverable local backup.
