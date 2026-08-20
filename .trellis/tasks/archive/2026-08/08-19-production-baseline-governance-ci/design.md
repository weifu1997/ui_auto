# Design: Production Baseline Governance And CI

## 1. Boundary

This child owns only GOV-01 and CI-01. It makes existing checks repeatable and records the governance evidence around them. It does not make a GitHub organization setting, a deployment host, a backup destination or a production account state change.

## 2. Task-Governance Model

The task inventory is a checked-in report, not an inferred dashboard count. For every active task it records:

```text
task id -> current status -> code/acceptance evidence -> owner -> remaining scope
        -> action (continue | re-scope | archive) -> dependency / release impact
```

Archive is permitted only after the task's own acceptance, validation evidence and worktree state support it. A task with active implementation, incomplete validation, uncommitted product changes or unresolved dependency remains active and gets a precise next action. The parent roadmap remains the source of Phase 0-3 ordering; this report only reconciles current state.

## 3. CI Design

One GitHub Actions workflow exposes stable jobs:

| Job | Runner | Required commands |
| --- | --- | --- |
| `quality-linux` | `ubuntu-latest` | `npm ci`, Python setup, build, lint, unit, startup, Python, bundle and Playwright checks |
| `deployment-windows` | `windows-latest` | `npm ci`, Python setup, Chromium setup and `npm run test:windows` |

The workflow triggers on pull requests and pushes to the repository's integration branch. It uses `permissions: contents: read`, does not inject production environment variables, and installs browser dependencies only for test execution. Job names remain stable and are the exact names documented for external branch protection.

Linux runs the existing commands in their current `test:all` order so a local and remote failure have the same meaning. Windows stays separate because the smoke test invokes PowerShell and validates Windows service/backup scripts. The workflow can upload ordinary test reports only when the underlying tools emit them; it must not upload databases, `.env` files, secrets or run artifacts.

## 4. Release Evidence And External Controls

The checked-in release document distinguishes two layers:

1. Repository evidence: workflow definition, passing run URL, local gate output, governance report and baseline tag.
2. Organization evidence: protected branch configuration, required job names, review rule, permitted admin override, owner and a link/screenshot reference.

The repository provides a checklist for layer 2 but never treats its presence as proof that GitHub has enforced it. The baseline tag is created only after the intended commit is clean and both local and first remote CI evidence are recorded; it is a release reference, not an automatic deployment.

## 5. Compatibility And Rollback

- CI introduction is additive. Existing local `test:all` remains unchanged.
- If a workflow command is incorrectly wired, fix the workflow or test setup rather than deleting a quality gate.
- Governance documentation is append-only evidence. No task is archived or status-changed merely to satisfy a report count.
- No production configuration, database or API rollback is required for this child.
