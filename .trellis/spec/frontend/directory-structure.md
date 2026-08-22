# Directory Structure

## Current Layout

```text
src/
|-- main.tsx                     # React root and top-level providers
|-- App.tsx                      # Theme, authentication gate, lazy routes
|-- pages/
|   |-- ProjectShell.tsx         # Resolves the project and active section
|   |-- *Page.tsx                # Route-level product screens
|   `-- shared.tsx               # Shared page layout and workflow helpers
|-- *-store.ts                   # Zustand stores
|-- platform-api.ts              # Platform HTTP contracts and functions
|-- platform-context.ts          # Platform browser-persistence helpers
|-- App.css                      # Shared application component styles
|-- responsive.css               # Responsive overrides
|-- index.css                    # Document-level reset
|-- assets/                      # Imported static assets
`-- *.test.ts                    # Colocated Vitest tests

tests/
|-- *.spec.ts                    # Playwright user journeys and regressions
`-- platform-ui-fixtures.ts      # Shared network fixtures for UI-only tests
```

`src/main.tsx` owns the React root, query provider, and router provider.
`src/App.tsx` owns global Ant Design configuration, authentication, background
synchronization, and lazy route registration. Do not recreate those providers
inside a page.

## Page and Feature Placement

Add route-level screens to `src/pages/` and name them `PascalCasePage.tsx`.
Current examples include `src/pages/DatasetsPage.tsx`,
`src/pages/GovernancePage.tsx`, and `src/pages/RunsPage.tsx`. Register or expose
them through the existing `src/App.tsx` and `src/pages/ProjectShell.tsx` route
flow as appropriate.

Keep a component used by only one page in that page file. The drawers in
`src/pages/FlowsPage.tsx`, `src/pages/VariablesPage.tsx`, and
`src/pages/ElementsPage.tsx` are declared after their parent page. Move code to
`src/pages/shared.tsx` only when multiple pages use the same layout, conversion,
or run helper.

All route-level screens live in `src/pages/` and are named `PascalCasePage.tsx`,
including the flow editor, login, password reset, run detail, and invitation
accept pages (migrated from the former root-level placement).

## Data and Service Modules

- Put shared UI domain shapes in `src/mock-data.ts`. Despite its historical
  name, `Project`, `Flow`, `Environment`, and related types are used throughout
  the live UI.
- Put Platform HTTP calls and response types in `src/platform-api.ts`.
- Put cross-page mutable state in a focused `*-store.ts` Zustand module, as in
  `workspace-store.ts`, `run-store.ts`, and `secret-store.ts`.
- Keep localStorage compatibility and project/session mapping in
  `platform-context.ts` or the existing persisted store rather than in a new
  utility layer.

Imports use relative paths; the project has no path-alias configuration. Page
modules import root modules with `../` and neighboring page utilities with
`./`, as shown in `src/pages/ElementsPage.tsx`.

## Styles and Assets

The project uses global CSS class names, not CSS Modules, CSS-in-JS, or
Tailwind. Add component rules to `src/App.css`, responsive overrides to
`src/responsive.css`, and document-wide rules only to `src/index.css`. Reuse
existing structural classes such as `surface`, `panel-heading`, and
`table-toolbar` before adding a variant. Imported images belong in
`src/assets/`.

## Naming and Tests

- React components and component files: PascalCase (`ProjectsPage`,
  `ServerWorkspaceSynchronizer`).
- Services, stores, and plain utilities: kebab-case files
  (`platform-api.ts`, `recording-editor-state.ts`).
- Hooks: `use` prefix; existing shared hook API lives in `src/router.tsx`.
- Vitest: `*.test.ts` or `*.test.tsx` beside source.
- Playwright: behavior-focused `*.spec.ts` under `tests/`.

Avoid creating generic `components/`, `hooks/`, or `utils/` directories for a
single use. The current repository favors page colocation and narrowly named
root modules.
