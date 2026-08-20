# ISO-01 Evidence

## Implementation

- Route/method authorization inventory is executable in
  `server-py/tests/unit/test_route_authorization_matrix.py`; every runtime
  Platform route method has exactly one typed policy row.
- Workspace/project parent-scoped lookups and mutation predicates were added
  for templates, schedules, signed Webhooks, notifications, runs,
  dataset-version detail, revisions, artifacts and element validations.
- Cross-workspace notification channel tests now return
  `NOTIFICATION_CHANNEL_NOT_FOUND` without an audit side effect.
- The backend isolation contract is documented in
  `.trellis/spec/backend/route-workspace-project-isolation.md` and linked from
  the backend spec index.

## Focused Verification

Passed:

```text
test_route_authorization_matrix.py                 1 passed
test_route_isolation_regressions.py                3 passed
test_templates.py + test_automation_edit_api.py    4 passed
test_batch_delete_runs.py                           2 passed
npm run build                                       passed
npm run lint                                        passed
npm run test:unit                                   57 passed
npm run test:startup                                1 passed
npm run check:bundle                                passed
task.py validate                                    passed
git diff --check                                    passed
```

The Python unit collection contains 140 tests. The complete run reached the
pre-existing IAM HTTP `TestClient` lifecycle test and then stopped without a
pytest summary; an isolated run of that test also timed out. This is recorded
as an environment/test-harness limitation, not as a passing full-suite claim.

Playwright E2E did not reach test assertions. The backend process reported
startup, but the execution sandbox could not connect to `127.0.0.1:8787` from
the Playwright web-server health probe and timed out after 60 seconds.

`npm run test:windows` was not run on this Linux environment. No external CI,
review, merge or deployment evidence is claimed here.

The original linked worktree could not write its shared Git index because that
metadata is read-only. A writable temporary clone was used only to preserve
the same verified tree as commit `f24d1fb`; the original worktree remains
unchanged apart from its working files. The commit has not been pushed because
the environment rejected the required external Git approval.

## Known Limitations

- The branch is based on IAM dependency commit `a514f64`; it must not be
  represented as merged into `python_3.1` until the dependency PR is actually
  merged.
- This task does not implement TLS, runner concurrency, retention, backup,
  capacity, SSO/MFA or other later roadmap items.
