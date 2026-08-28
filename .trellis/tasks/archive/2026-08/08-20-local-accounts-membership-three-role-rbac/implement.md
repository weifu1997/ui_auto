# Implementation Plan

## Ordered Work

1. Add role constants, capability maps and migrations 12/13; add fresh-install and legacy-role upgrade fixtures.
2. Add explicit super-admin bootstrap CLI and remove public registration effects. Update smoke/test account setup to use a controlled local bootstrap path.
3. Implement service-layer effective-role checks, workspace/member/account methods, session revocation and safe audit helpers.
4. Add invitation and password-reset token lifecycle APIs with transaction, replay and redaction tests.
5. Move existing route calls from boolean bypasses to named capability checks where this task owns them; preserve a clear inventory for the isolation child task.
6. Extend frontend session types/API client and replace allow-all `canUseCapability` with server-derived selection.
7. Add workspace administration and invitation-accept UI, focused component tests and browser journey coverage.
8. Run migration, authorization, replay, session-revocation, build/lint/unit/Python/startup/Playwright gates; perform independent code review.
9. Update applicable specs/runbook, commit focused changes, push the feature branch, create PR and record CI/review evidence.

## High-Risk Files

- `server-py/autoflow/migrations.py`, `services.py`, `handler.py`, `workspaces.py`: schema, atomicity and authorization boundary.
- `server-py/autoflow/auth.py`: cookie and session invalidation behavior.
- `src/platform-api.ts`, `src/platform-context.ts`, `src/pages/shared.tsx`: typed server-to-UI policy projection.
- workspace administration routes/components and auth/Playwright fixtures: avoid exposing raw invitation tokens beyond the one-time UI.

## Validation

Run focused tests first, then:

```bash
npm run build
npm run lint
npm run test:unit
npm run test:startup
npm run test:py
npm run check:bundle
npm run test:e2e
npm run test:windows
```

Required focused assertions include fresh/upgrade migration, no registration side effects, super-admin bootstrap, role matrix, two-workspace denial, invite revoke/expiry/existing-account/new-account flow, consumed replay `410 INVITE_ALREADY_USED`, no duplicate audit/session/membership, session revocation and last-admin/super-admin lockout.

## Rollback

Take a verified pre-migration backup and retain the prior package. If migration is incompatible, restore the matching database backup rather than applying an ad hoc down migration. Do not enable a public registration compatibility switch.

## Independent Review And Local Evidence (2026-08-20)

- Independent review corrected the disabled-existing-invitee terminal path,
  password-reset replay ordering, successful-login `Cache-Control: no-store`,
  first-workspace creation from the bootstrap super-admin UI, and the
  deployment-only `account.manage` capability projection.
- Follow-up review findings were closed in this task: bootstrap now records a
  safe `account.super_admin_bootstrapped` deployment event, replacement of an
  active invitation records a redacted `workspace.invitation_revoked` event,
  and a Playwright journey proves a displayed invite link never enters browser
  storage.
- Local gates passed: `npm run test:all` (build, lint, 57 Vitest tests,
  startup checks, 137 Python tests, bundle, Playwright, Windows smoke),
  `python3 ./.trellis/scripts/task.py validate
  08-20-local-accounts-membership-three-role-rbac`, and `git diff --check`.
- Full route/resource isolation remains owned by the next ISO-01 task. Remote
  PR, CI and independent human approval remain external evidence; they are not
  represented by this local review record.
