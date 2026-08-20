# Route-Wide Workspace And Project Isolation

## Scope

Every protected Platform API route must establish an enabled session user and
authorize its workspace or project before reading data or causing a side effect.
The API is the authority; UI capability projection is not an authorization
boundary.

## Executable Route Inventory

`server-py/tests/unit/test_route_authorization_matrix.py` is the source of
truth for route coverage. It expands one typed policy row per runtime
`(path, method)` exposed by `create_platform_router`. Each row records
authentication, scope, minimum capability, and the parent resolver. Adding a
route without adding its row fails the test.

Intentional public exceptions are health, terminal registration, login,
logout, session projection, invitation/password-reset acceptance, and the
signed public Webhook. The Webhook resolves its own trigger project only after
timestamp, signature, idempotency, and rate checks; it never trusts a caller
supplied project ID.

## Parent-Scoped Access Contract

- A project route resolves `project_id`, then authorizes its workspace and
  named capability before child queries or mutations.
- A child ID is queried with its authorized parent in the SQL predicate (or by
  a closed typed join to its real project/workspace). A mismatched child is a
  stable family `*_NOT_FOUND` response and cannot reveal fields or paths.
- Artifact and validation downloads resolve the stored project before
  authorization. Run, validation, dataset-version, batch, recording-session,
  template, and notification child IDs cannot be authorized by a bare ID.
- Body cross-references (revision/environment/dataset-version, template target,
  notification channel) must resolve to the same authorized project/workspace.
- Notification subscriptions and deliveries must enforce that the channel's
  workspace equals the run/project workspace. The channel test endpoint must
  scope lookup by the path workspace and must not turn a scope error into a
  successful audit event.

## Stable Errors And Side Effects

Missing, expired, or disabled sessions retain `AUTH_REQUIRED`/
`SESSION_INVALID`. A foreign parent remains an access denial; a child absent
from an already authorized parent is not-found. Rejected cross-boundary calls
must not mutate database rows, artifact files, runs, deliveries, or audit
events.

Invitation replay remains terminal `410 INVITE_ALREADY_USED`, independent of
caller-controlled input, with no duplicate account, membership, session, or
success-audit effect.

## Verification

The focused regressions in
`server-py/tests/unit/test_route_isolation_regressions.py` build two workspaces
and assert channel, run, and validation isolation. Run the complete backend
unit suite and the repository `test:all` gate before submitting a PR. This
spec does not cover TLS, runner concurrency, retention, backup/restore, or
capacity evidence.
