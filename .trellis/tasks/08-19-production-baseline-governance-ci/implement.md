# Implementation Plan: Production Baseline Governance And CI

## Ordered Work

1. Inspect every active Trellis task against its PRD, implementation checklist, current branch changes and completed validation evidence. Write the governance inventory with an explicit action for each task.
2. Add the release/branch-protection document and Phase 0 operator note. Include required check names, owner/evidence fields, tag procedure, rollback entry points and the distinction between repository evidence and external controls.
3. Add `.github/workflows/phase0-ci.yml` with stable `quality-linux` and `deployment-windows` jobs. Use `npm ci`, supported Node/Python setup and the existing test commands without production credentials.
4. Validate workflow structure and commands locally where possible. Run the Linux-quality commands in the documented order; run the Windows smoke when a Windows environment is available.
5. Push the workflow through the normal review path. Record the first green Actions run, reconcile any task evidence revealed by the gate, and then create the Phase 0 baseline tag only after the worktree is clean.

## Files Expected To Change

- `.github/workflows/phase0-ci.yml`
- `docs/` release, branch-protection and Phase 0 operator guidance
- `.trellis/tasks/` governance inventory and only those task metadata files justified by the reconciliation

## Validation

```bash
npm ci
npm run setup:py
npm run build
npm run lint
npm run test:unit
npm run test:startup
npm run test:py
npm run check:bundle
npx playwright install --with-deps chromium
npm run test:e2e
```

The Windows job and `npm run test:windows` must run on `windows-latest`; a successful remote run is required before claiming CI-01 complete. The final review also checks `task.py list`, the governance inventory, workflow job names and the external-control evidence fields.

## Rollback And Safety

- Revert only the CI/documentation commit if the workflow is malformed; retain the local test matrix.
- Do not archive a task without task-specific completion evidence.
- Do not create the baseline tag until the required evidence exists.
- External branch protection, approval policy and owner assignment remain manual Phase 0 exit conditions.
