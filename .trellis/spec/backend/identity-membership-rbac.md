# Identity, Membership, And RBAC Contract

## Scenario: Controlled Local Accounts And Workspace Membership

### 1. Scope / Trigger

- Trigger: changing local authentication, `workspace_members`, account status,
  invitations, password reset, or any route that requires workspace access.
- Scope: one deployment-global `super_admin`, plus workspace-scoped `admin`
  and `member` roles. The FastAPI service is the authorization authority;
  client capabilities are a display projection only.
- Out of scope: OIDC/SSO/LDAP/MFA, SMTP delivery, external audit immutability,
  tenant isolation beyond the current workspace model, and retention execution.

### 2. Signatures

- Migration 12: `add_identity_membership_rbac(database)` adds
  `platform_users.enabled`, `platform_users.global_role`,
  `workspace_invitations`, and `password_reset_tokens`; it normalizes legacy
  workspace roles and revokes every `platform_sessions` row.
- Migration 13: `add_deployment_audit_events(database)` adds the internal
  deployment ledger used for bootstrap events before a workspace exists.
- Bootstrap command:
  `npm run bootstrap:super-admin -- --email <email> [--name <name>]`.
  It reads a password only from a TTY or, for deliberate noninteractive
  automation, from `--password-stdin`.
- Session response: `GET /api/auth/session` returns
  `{ user: { id, email, name, globalRole }, workspaces: [{ id, name, role,
  capabilities }] }`.
- Account boundaries:
  `POST /api/auth/register`, `POST /api/auth/invitations/accept`,
  `POST /api/auth/password-resets/accept`, `GET/PATCH /api/admin/accounts`,
  and `POST /api/admin/accounts/{account_id}/password-reset`.
- Workspace administration:
  `GET/PATCH/DELETE /api/workspaces/{workspace_id}/members/{member_id}` and
  invitation list/create/revoke routes below `/api/workspaces/{workspace_id}`.

### 3. Contracts

- `POST /api/auth/register` is permanently terminal: it returns
  `410 REGISTRATION_DISABLED` and creates no account, workspace, session, or
  audit event.
- The only global role is nullable `super_admin`; workspace roles are exactly
  `admin` and `member`. Migration maps legacy `owner` and `admin` to `admin`,
  and every other legacy role to `member`. It never silently elects a
  super-admin.
- `super_admin` has support access to every workspace and writes
  `super_admin.workspace_accessed` when accessing a workspace without a local
  membership. `admin` has every workspace-scoped capability in its workspace;
  deployment-only `account.manage` is issued only to a `super_admin`. `member`
  can view and perform authoring/run actions, but cannot manage members,
  invitations, projects, secrets, workspace settings, or deployment accounts.
- `PlatformServices.require_workspace_capability` and
  `require_project_capability` must resolve an enabled session user, its
  workspace/global role, and the requested named capability before data access
  or mutation. UI visibility must never be the enforcement mechanism.
- Invitation and reset tables store `sha256` token digests only. Raw values are
  returned once in their creation response, carry `Cache-Control: no-store`,
  and must not appear in database rows, audit details, browser storage, logs,
  or later list responses.
- Invitation acceptance uses `BEGIN IMMEDIATE`: it validates terminal state,
  caller/email, account and membership, writes membership, consumes the token,
  writes one safe audit event, and commits before a new-account session is
  issued. A consumed token always wins over all caller-controlled input.
- Disable, workspace-member removal, workspace-role change, deployment-role
  change, bootstrap promotion, and password reset revoke every active session
  for the affected account in the same transaction. Removing a member must not
  delete memberships in other workspaces.
- A mutation may not remove/demote/disable the last enabled workspace admin or
  revoke/disable/demote the last enabled super-admin. Audit details contain
  IDs, role names, booleans, and counts only; never token, password, password
  hash, or full email.
- Bootstrap writes `account.super_admin_bootstrapped` to
  `deployment_audit_events` in the same transaction. This is deliberately a
  separate internal ledger: existing `audit_events` rows require a workspace
  foreign key and remain the project-governance trail.
- Creating a new active invitation for the same normalized workspace/email
  revokes every replaced active invitation in the same transaction and writes
  `workspace.invitation_revoked` with only `{ "reason": "replaced" }`. The
  raw token and target email never enter that event.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Public registration request | `410 REGISTRATION_DISABLED`, no side effect |
| Non-super-admin creates workspace or manages deployment account | `403 SUPER_ADMIN_REQUIRED` |
| Member calls member/invitation/secret/project-management route | `403 CAPABILITY_REQUIRED` |
| Missing workspace membership | `403 WORKSPACE_ACCESS_DENIED` |
| Invalid invite email/role/token | stable `INVITE_*` error, no invitation metadata in body |
| Revoked or expired invitation | `410 INVITE_REVOKED` / `410 INVITE_EXPIRED` |
| Any consumed-invitation replay | `410 INVITE_ALREADY_USED`, irrespective of supplied email/password/session |
| Existing enabled account without its matching session | `409 INVITE_LOGIN_REQUIRED` |
| Reset replay/revoked/expired token | corresponding stable `PASSWORD_RESET_*` terminal error |
| Last enabled admin/super-admin removal or downgrade | `409 LAST_WORKSPACE_ADMIN_REQUIRED` / `LAST_SUPER_ADMIN_REQUIRED` |

### 5. Good / Base / Bad Cases

- Good: an admin creates a 24-hour member invite, the new account accepts it
  once, and every replay returns only `INVITE_ALREADY_USED` without duplicate
  user/member/session/audit state.
- Base: an existing enabled account accepts a matching-email invite through
  its authenticated session; its password and unrelated workspace memberships
  remain unchanged.
- Base: bootstrap creates or promotes the first super-admin while no workspace
  exists, revokes that account's old sessions, and records a safe deployment
  audit event rather than inventing a workspace-scoped one.
- Bad: storing a raw token in SQLite/localStorage, validating email before a
  consumed token, inferring authorization from a hidden button, or promoting a
  legacy `owner` automatically to deployment super-admin.

### 6. Tests Required

- Migration/fresh-install tests assert legacy role normalization, no implicit
  super-admin, existing-session revocation, and the deployment audit ledger.
- HTTP tests cover public-registration no-effect, three-role positive and
  negative capability paths, a second-workspace denial, and super-admin
  support access.
- Invitation tests cover digest-only storage, revoke, expiry, new and
  existing-account acceptance, replacement revocation audit, exact replay
  response/body, and no duplicate account/member/session/audit effects.
- Lifecycle tests cover reset digest/replay, disable/remove/role-change
  session revocation, preservation of other memberships, and last-admin /
  last-super-admin lockout protection.
- Browser tests assert that server-issued capabilities select UI commands and
  raw invite/reset links appear only in component state, never browser storage.

### 7. Wrong vs Correct

#### Wrong

```python
email = validate_email(body["email"])
invite = find_invite(token)
if invite.consumed_at:
    raise PlatformError(410, "INVITE_ALREADY_USED")
```

This lets a replay's changed input alter the terminal response before the
consumed state is checked.

#### Correct

```python
database.execute("BEGIN IMMEDIATE")
invite = find_invite_by_digest(token)
if invite.consumed_at:
    raise PlatformError(410, "INVITE_ALREADY_USED")
validate_remaining_invitation_inputs()
create_membership_and_consume_once()
database.execute("COMMIT")
```

The terminal replay outcome is checked first and successful effects remain one
atomic transaction.

#### Wrong: inventing a workspace for bootstrap audit

```python
self.audit("bootstrap-workspace", actor, "account.super_admin_bootstrapped", target)
```

This either violates the audit foreign key or creates a misleading workspace
that changes authorization state merely to write an audit event.

#### Correct: keep the deployment boundary explicit

```python
self.deployment_audit(
    {"type": "system", "id": "bootstrap"},
    "account.super_admin_bootstrapped",
    {"type": "user", "id": user.id},
    {"created": created, "promoted": not created, "revokedSessions": revoked},
)
```

The deployment ledger records the security event atomically without weakening
the workspace-scoped governance schema or storing sensitive input.
