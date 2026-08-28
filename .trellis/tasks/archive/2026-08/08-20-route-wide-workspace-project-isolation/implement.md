# Implementation Plan

## Ordered Work

1. Inventory `create_platform_router` paths/methods and classify public, deployment, workspace, project and indirect-project boundaries. Add the executable matrix skeleton and a test that detects unclassified routes.
2. Inspect each current handler/service child lookup. Add or strengthen closed, typed scoped resolvers that authorize the real parent before returning a child record; do not accept dynamic SQL/table input.
3. Convert workspace and project collection/detail routes from boolean role shortcuts to explicit named capabilities where needed. Cover project base/document/resources/settings, templates and local imports first.
4. Scope data, schedule, Webhook, notification and cross-reference paths: datasets/versions, revisions, environments, channels, subscriptions and template application.
5. Scope run/batch/recording/validation/artifact paths, including download, cancel, retry, delete and dependent-row mutation sets. Preserve signed public Webhook behavior as an intentional exception.
6. Add two-workspace tests for every matrix family: anonymous, disabled/non-member, insufficient member, admin/super-admin positive and mismatched child/reference IDs with no side effect.
7. Add focused browser coverage only where server capability projection needs a minimal correction; update backend isolation spec and task/runbook evidence.
8. Run independent review and all quality gates, commit a focused ISO-01 change, push a dependency-aware PR, record actual CI/review status and leave IAM review/merge status explicit.

## High-Risk Files

- `server-py/autoflow/handler.py`: every route must authorize before exposing a child row or scheduling a mutation.
- `server-py/autoflow/services.py`: shared scoped lookup semantics, run/artifact/recording relationships and transaction boundaries.
- `server-py/autoflow/workspaces.py`: only if a missing named capability must be added; do not duplicate role policy in handlers.
- `server-py/tests/unit/*`, `server-py/tests/smoke/*`, `tests/*.spec.ts`: matrix completeness, negative scope checks and regression behavior.
- `.trellis/spec/backend/`: executable route-isolation contract and audit/redaction boundary.

## Validation

Run focused route matrix and two-workspace regression tests first, then:

```bash
npm run build
npm run lint
npm run test:unit
npm run test:startup
npm run test:py
npm run check:bundle
npm run test:e2e
npm run test:windows
python3 ./.trellis/scripts/task.py validate 08-20-route-wide-workspace-project-isolation
git diff --check
```

Required focused assertions include every router path/method classified exactly once, unauthorized/disabled/non-member/mismatched-parent refusal, no cross-project mutation or download, member/admin/super-admin role behavior, signed public Webhook preservation, and existing invite replay/session-revocation regression.

## Rollback

No schema migration or data rewrite is planned. Keep the prior package during rollout. If a legitimate existing client is rejected, identify the missing parent/capability classification and correct it with a focused regression; never add a permissive cross-project compatibility fallback.
