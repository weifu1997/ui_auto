# Quality Guidelines

## Source Style

Frontend source predominantly uses double quotes, semicolons, two-space
indentation, trailing commas in multiline constructs, and relative imports.
Match the surrounding file. `src/stores/flow-store.test.ts` retains an older
single-quote/no-semicolon style; do not reformat unrelated code while changing
a focused behavior.

Prettier is installed but no project formatting command or checked-in Prettier
configuration exists. Do not claim formatting is enforced and do not run a
repository-wide format as part of an unrelated change.

Comments explain non-obvious policy or compatibility behavior, such as local
storage migration in `src/App.tsx` and intentionally unreachable legacy remote
execution in `src/pages/FlowsPage.tsx`. Avoid comments that merely restate JSX
or assignments.

## Required Checks

Run checks in proportion to the change:

```bash
npm run lint
npm run build
npm run test:unit
npm run test:startup
npm run test:py
npm run check:bundle
```

- `npm run lint` runs Oxlint. `.oxlintrc.json` makes the Rules of Hooks an error
  and mixed component exports a warning.
- `npm run build` runs the composite TypeScript build and the Vite production
  build.
- `npm run check:bundle` enforces the 500 kB JS chunk budget against
  `dist/assets/*.js`.
- `npm run test:unit` runs Vitest in jsdom with `src/test-setup.ts`.

For route, interaction, persistence, API composition, responsive behavior, or
cross-page changes, run the relevant Playwright spec and then the full suite
when practical:

```bash
npx playwright test --project=chromium e2e/platform-run.spec.ts
npx playwright test --project=chromium e2e/platform-sync.spec.ts
npm run test:e2e
```

The complete project gate is `npm run test:all`; it exercises the production
launcher, Platform backend, browser flows, and Windows deployment smoke.

## Test Placement and Style

Use Vitest for deterministic store or utility behavior. The representative
`src/stores/flow-store.test.ts` resets the Zustand store in `beforeEach`, calls actions
through `getState()`, and asserts externally visible state transitions.

Use Playwright for user workflows. Tests under `e2e/`:

- start from user-visible navigation and controls;
- locate controls by role or label where possible;
- intercept exact API routes when verifying request composition;
- assert both the visible result and important payload/persistence effects;
- isolate service data through the temporary directories in
  `playwright.config.ts`.

`e2e/platform-ui-fixtures.ts` is the shared fixture for Platform run UI
composition. Extend it instead of duplicating a large route mock when the same
contract is involved.

Choose regression coverage by risk. Examples:

- Workspace migration/persistence: `e2e/workbench.spec.ts`.
- Server synchronization/version conflicts: `e2e/platform-sync.spec.ts` and
  `e2e/templates-and-conflicts.spec.ts`.
- Production launcher prerequisites: `scripts/start-production.test.mjs`.
- Platform run request composition: `e2e/platform-run.spec.ts`.
- Recording and server session state: `e2e/recording.spec.ts` and
  `server-py/tests/unit/test_recording_state.py`.

## Accessibility and Interaction Review

- Forms must retain visible/associated labels because tests and users navigate
  them by label.
- Icon-only commands need a tooltip and an accessible name; include the target
  item's name for row actions.
- Preserve keyboard-accessible Ant Design or native controls. Do not replace a
  button with a clickable `div`.
- Destructive commands require confirmation and a visible success/failure
  result.
- Loading, empty, unavailable, and failure states are part of the feature, not
  optional polish. Existing pages use `Spin`, `Empty`, `Alert`, disabled
  controls, and `message` feedback.

## Review Checklist

- State is owned at the correct layer and project-scoped collections cannot
  overwrite another project.
- Platform calls remain in `platform-api.ts`, with IDs passed through
  `encodeURIComponent`.
- Async effects/subscriptions clean up and do not update stale components.
- Secrets and raw run requests do not enter persistence, logs, screenshots, or
  rendered diagnostics.
- New browser-storage shapes are validated and migrated.
- UI failures are reported honestly; no mock success or silent fallback changes
  the product contract.
- The relevant unit/E2E regression exists and the build/lint gates pass.

## Forbidden Changes

- Do not commit runtime SQLite files or other `data/` runtime artifacts as part
  of frontend work.
- Do not disable hook rules, weaken TypeScript checks, or add blanket lint
  suppressions. `src/router.tsx` has a narrow documented suppression because it
  intentionally exports one cohesive router API.
- Do not update broad snapshots or rewrite unrelated formatting to make a
  focused test pass.
