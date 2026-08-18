# Frontend Development Guidelines

These guides describe the current React/Vite frontend under `src/`. They are
based on the repository's source, build configuration, unit test, and
Playwright suites rather than on framework defaults.

## Runtime and Tooling

- React 19 and TypeScript 6, built by Vite 8.
- Ant Design 6 and `@ant-design/icons` for the UI.
- Zustand for client stores; TanStack Query is used for server workspace
  synchronization and cache invalidation.
- Vitest with jsdom for colocated unit tests and Playwright for browser flows.
- Oxlint enforces React hook rules and warns about mixed component exports.

## Guidelines Index

| Guide | Project-specific coverage |
| --- | --- |
| [Directory Structure](./directory-structure.md) | Entry points, pages, stores, API modules, styles, and tests |
| [Component Guidelines](./component-guidelines.md) | Page composition, Ant Design usage, props, feedback, and accessibility |
| [Hook Guidelines](./hook-guidelines.md) | Effects, selectors, async loading, subscriptions, and the local router hooks |
| [State Management](./state-management.md) | Local, form, Zustand, query, URL, persisted, and secret state |
| [Type Safety](./type-safety.md) | Domain types, API contracts, narrowing, and boundary validation |
| [Quality Guidelines](./quality-guidelines.md) | Formatting, lint/build gates, test selection, and review checks |

## Representative References

- Application composition and lazy routes: `src/main.tsx`, `src/App.tsx`
- Page and shared-view patterns: `src/pages/ProjectsPage.tsx`,
  `src/pages/ElementsPage.tsx`, `src/pages/shared.tsx`
- State and persistence: `src/workspace-store.ts`, `src/run-store.ts`,
  `src/secret-store.ts`
- HTTP boundary: `src/platform-api.ts` (same-origin `/api`)
- Tests: `src/flow-store.test.ts`, `tests/workbench.spec.ts`,
  `tests/platform-sync.spec.ts`

All files in this directory are ready for use. Documentation is written in
English; product copy remains in the language used by the surrounding UI.
