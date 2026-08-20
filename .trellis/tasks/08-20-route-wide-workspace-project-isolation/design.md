# Route-Wide Workspace And Project Isolation Design

## Boundary

This task owns authorization reachability and data scoping for every Platform API route. It changes the FastAPI route/service boundary, scoped resource resolvers, executable authorization matrix tests and the backend specification. It consumes the finalized IAM session/capability contract and does not change account lifecycle, transport security, retention or runner scheduling.

## Route Classification And Matrix

The test-owned route matrix is the completeness source. It is built from the runtime router rather than a copied Markdown list and has one typed policy row per route/method:

| Class | Authentication | Scope / parent | Examples |
| --- | --- | --- | --- |
| public terminal | intentionally no session | none | health, disabled registration, login, signed webhook, invitation/reset acceptance |
| deployment | enabled session + `super_admin` | deployment | accounts, workspace creation/listing |
| workspace | enabled session + named workspace capability | `workspace_id` | members, invites, projects, imports, notification channels |
| project | enabled session + named project capability | project -> workspace | document, resources, datasets, schedules, runs, revisions, secrets, analytics |
| indirect project | enabled session then real parent join | artifact/validation/run/trigger -> project | artifact downloads and ID-only children |

The matrix expresses all HTTP methods independently when their capability differs. A route is considered covered only when its matrix row is exercised by authentication and scope-negative tests, not merely listed.

## Service Access Flow

```text
HTTP path/body ID
  -> session_user (enabled account)
  -> require_super_admin / require_workspace_capability / require_project_capability
  -> resolve scoped child through its actual workspace/project parent
  -> validate every cross-reference against the same parent
  -> mutation or response
```

`PlatformServices` remains the source of effective role calculation. The isolation work adds narrow, typed scoped lookup helpers for resource families where a handler currently reads by child ID alone. The helper receives only a closed internal resource kind or concrete service method, never a client-provided table/column name. It returns a record whose project/workspace ID is already matched to the authorized parent.

For a route that exposes only an artifact/validation ID, the resolver joins it to the owning run/validation/project first, authorizes that real project, then serves the file. It never trusts an optional request project ID as proof of ownership.

## Parent And Cross-Reference Rules

| Family | Required scope rule |
| --- | --- |
| project document/resources/settings | route `project_id`; resource query includes `project_id` |
| datasets/versions | version joins dataset and dataset `project_id`; dataset mutation includes `project_id` |
| schedules/Webhooks | schedule/trigger ID includes `project_id`; revision/environment/dataset-version inputs are validated against the same project |
| templates | template uses real `workspace_id`; apply target project is authorized and belongs to that workspace |
| notification channels/subscriptions/deliveries | channel uses `workspace_id`; subscription/delivery uses `project_id`; referenced channel/project stay aligned |
| runs/batches/revisions/recording/validation | every ID includes or joins the route `project_id`; dependent state transitions only operate on the scoped ID set |
| artifacts | artifact/validation artifact joins to a project before authorization and preserves safe-file-name restrictions |
| public Webhook | trigger resolves its own project; signing/time/idempotency validation happens before queueing and cannot be redirected to a supplied project |

## Error And Audit Contract

- `session_user` remains the only authenticated-user resolver. Missing/expired/disabled sessions retain existing `AUTH_REQUIRED` / `SESSION_INVALID` behavior.
- A non-member parent request retains `WORKSPACE_ACCESS_DENIED`; a member lacking the named capability receives `CAPABILITY_REQUIRED`; deployment operations retain `SUPER_ADMIN_REQUIRED`.
- A child queried through an authorized parent but not present under that parent returns the family’s `*_NOT_FOUND` result. Handlers must not serialize a cross-project record before rejecting it.
- Cross-workspace super-admin support is still allowed only through the existing effective-role resolver, which writes `super_admin.workspace_accessed` for a non-membership access.
- No new audit detail may include full email, secret, raw token, artifact path outside approved safe metadata, request payload or decrypted values.

## Compatibility And Rollback

No schema migration is planned. Existing correct requests retain their current API shapes and capability names. This is an authorization tightening: a client relying on an invalid cross-project ID will receive a safe denial/not-found response. Roll back by returning to the preceding application package; no data conversion is necessary.

## Verification Shape

1. Build two workspaces with distinct projects and each child-resource family.
2. Execute the matrix against anonymous, disabled, non-member, member, admin and super-admin sessions.
3. For each child family, pass a valid other-project ID through the authorized project route and assert safe error, unchanged DB/artifacts and no cross-project audit mutation.
4. Reflect every runtime router path/method in the matrix so an unclassified protected endpoint fails the test.
5. Run full Python, TypeScript, browser, startup, bundle and Windows gates, then independently review authorization ordering and scoped SQL predicates.
