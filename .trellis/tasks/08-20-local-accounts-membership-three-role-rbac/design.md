# Identity, Membership And RBAC Design

## Boundary

The change owns local identity, membership, session invalidation and policy decisions. It changes the FastAPI service, SQLite schema, frontend API/session projection and workspace administration UI. It does not implement a second identity provider, mail delivery or Phase 2 retention.

## Data Model And Migration

Migrations 12 and 13 add the following append-only-compatible model:

- `platform_users.global_role` is nullable or `super_admin`; the existing `enabled` field remains the account status.
- `workspace_members.role` is normalized transactionally to `admin` or `member`. The migration expires every existing `platform_sessions` row so old role assumptions cannot survive.
- `workspace_invitations` stores `id`, `workspace_id`, normalized `email`, `role`, `token_hash`, `expires_at`, `created_by`, `created_at`, `revoked_at`, `consumed_at` and safe state timestamps. The raw secret never reaches SQLite or audit details.
- `password_reset_tokens` stores only a token digest, target user, expiry and terminal timestamps.
- `deployment_audit_events` records internal deployment actions that occur
  before a workspace exists, including secure super-admin bootstrap. It carries
  only stable IDs, action names and safe detail fields.

Fresh installs apply the same migration after bootstrap schema creation. Existing upgrades do not pick a global administrator automatically. `python -m autoflow.bootstrap_super_admin` is the explicit operator action: it creates or promotes one account only when no super-admin exists, asks for a password via a TTY or reads password bytes from stdin only in explicit noninteractive mode, and revokes old sessions when it promotes an existing account.

## Policy Module

`workspaces.py` becomes the single named capability source. It exports typed role constants, role normalization and `role_has_capability`.

| Capability family | super_admin | admin | member |
| --- | --- | --- | --- |
| workspace/member/invite/account administration | yes | workspace only | no |
| create/archive project, secrets, notifications | yes | yes | no |
| project/flow/resource edit and run | yes | yes | yes |
| project/workspace view | yes | yes | yes |

`PlatformServices` owns these checks:

1. Load an enabled authenticated user.
2. Resolve global role. Super-admin is granted the requested workspace with a `super_admin.workspace_accessed` audit event.
3. For non-super-admin, load membership and verify the requested named capability.
4. Project checks resolve the project before evaluating its workspace capability.

Existing `require_*` callers retain their API shape where feasible, but boolean `admin`/`write` shortcuts are translated to explicit named capabilities. The route-isolation child task will extend the matrix across every resource route.

## API Contracts

All error payloads continue to use `{ error: CODE }`; successful secret-bearing responses are no-store.

- `POST /api/auth/register` -> `410 REGISTRATION_DISABLED` with no effect.
- `GET /api/auth/session` -> `{ user: { id, email, name, globalRole }, workspaces: [{ id, name, role, capabilities }] }`.
- `POST /api/workspaces` requires super-admin.
- `GET /api/workspaces/{id}/members`, `PATCH/DELETE /api/workspaces/{id}/members/{userId}`, invite list/create/revoke endpoints require `member.manage`.
- `POST /api/workspaces/{id}/invitations` returns a raw one-time token only on the creation response. `POST /api/auth/invitations/accept` accepts the token plus either a new-account password/email/name or a matching authenticated existing account.
- `GET/PATCH /api/admin/accounts` and password-reset issuance/acceptance own deployment account lifecycle; only a super-admin can issue account changes.

Invitation acceptance starts `BEGIN IMMEDIATE`, reads terminal state, validates caller/email, changes account/membership, marks `consumed_at`, writes exactly one success audit event, commits, and only then creates a new account session. A consumed token is checked before any caller/account detail and always returns `410 INVITE_ALREADY_USED`.

## Audit And Session Rules

Audit uses target workspace IDs already required by the schema. Details contain role names, stable IDs and counts only, never token, password, password hash or full email. Account actions affecting multiple memberships write an event to each relevant workspace; global support access writes a dedicated audit event at the accessed workspace. Bootstrap has no workspace by design, so it writes one internal deployment audit event in the same transaction rather than fabricating a workspace.

Session revocation deletes token digest rows transactionally. Disable, password reset, membership remove and role/global-role changes revoke all target-user sessions. The last workspace admin and last global super-admin checks run in the same write transaction as the requested change.

## Frontend Flow

`PlatformSession` carries server-derived `globalRole`, workspace roles and capabilities. A shared selector reads the selected workspace and returns only server-issued capability names; it is presentation behavior, not an authorization decision.

`WorkspaceAdministrationPage` is reachable only when `member.manage` is present. It shows member list, role operations and invite lifecycle. A super-admin view adds account state/global-role controls. Invite tokens are displayed once in an explicit dialog and never stored in localStorage. The login page remains login-only; an invitation-accept route handles new and authenticated-existing-account paths without displaying workspace metadata before a valid token is processed.

## Compatibility, Rollout And Rollback

Before upgrade, take the Phase 0 backup. Migration transactionally maps old roles and deletes existing sessions. Rollback is package plus matching pre-upgrade database restore, not an unsafe downgrade migration. Fresh-install and legacy-fixture tests prove both paths. A partial failure rolls back the migration transaction; invitation effects are atomic.
