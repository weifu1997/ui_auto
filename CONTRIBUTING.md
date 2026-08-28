# Contributing

## Pull request policy

- Target `master`. Larger efforts land on a working branch (for example
  `v3.2_flow_assertion`) and reach `master` through a release PR once the batch
  is verified. Each change is a focused, independently reviewable Trellis task
  with its own branch and PR.
- `master` requires a passing `quality-linux` and `deployment-windows` check,
  plus one approving review. Do not bypass branch protection.
- Keep CI evidence real: do not commit workarounds that only make local checks
  appear green without exercising the relevant gate.

## Local checks

`npm run setup:py` requires [uv](https://docs.astral.sh/uv/) on PATH (CI provides
it via `astral-sh/setup-uv`). Install it once with the official installer:
`curl -LsSf https://astral.sh/uv/install.sh | sh` (Windows PowerShell:
`irm https://astral.sh/uv/install.ps1 | iex`).

```bash
npm ci
npm run setup:py
npm run build
npm run lint
npm run test:unit
npm run test:coverage
npm run test:py
npm run check:bundle
```

Run `npm run test:all` for the full matrix before opening a PR.

## Commit style

Use conventional, scoped commits (`feat(platform): ...`, `fix(deploy): ...`,
`chore(trellis): ...`). Keep Trellis bookkeeping in separate `chore(trellis)`
commits from the logical change.

## Code of conduct

Be direct and evidence-based. Reviewers verify behavior against the acceptance
criteria in the task PRD; do not merge unreviewed changes to protected branches.
