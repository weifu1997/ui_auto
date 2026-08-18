# Type Safety

## Compiler Contract

The application and tests are TypeScript-only. `tsconfig.app.json` and
`tsconfig.tests.json` enforce unused-symbol checks, erasable syntax, and
fallthrough checks; tests also set `noImplicitAny`. The composite root build
runs all referenced TypeScript projects before Vite:

```bash
npm run build
```

Use syntax compatible with `erasableSyntaxOnly`. Prefer string unions and
object types over TypeScript constructs that emit runtime code.

## Type Placement

- Shared UI domain models live in `src/mock-data.ts` (`Project`, `Flow`,
  `FlowStep`, `Run`, `Environment`, `Variable`, `ElementAsset`).
- Platform request/response models live beside their functions in
  `src/platform-api.ts`.
- Platform request/response models stay in `src/platform-api.ts`; no local
  Worker API model or client is supported.
- Store-only state/action types remain private in their store module; export a
  type only when another module consumes it (`PlatformSyncStatus`, `ApiRun`).
- Component-only form or props types stay in the component file, such as
  `TemplateForm` in `src/pages/TemplatesPage.tsx` and `RunDetailPageProps` in
  `src/RunDetailPage.tsx`.

Use `import type` for type-only dependencies. This is required by the project's
`verbatimModuleSyntax` configuration and is consistently demonstrated by the
API, store, and page modules.

## Model Values Precisely

Use literal unions for closed states:

```ts
export type PlatformSyncStatus = "synced" | "syncing" | "retrying" | "failed";
```

API functions state their response at the boundary, for example
`request<{ schedules: PlatformSchedule[] }>(...)`. Reuse property types when an
input must stay aligned with a model, as Platform member functions use
`PlatformMember["role"]`.

Use `Pick`, `Omit`, `Partial`, `Record`, and `ReturnType` for real relationships
instead of copying shapes. Examples include `NewProjectInput`, `ApiRun`, and
`WorkspaceSnapshot = ReturnType<typeof useWorkspaceStore.getState>`.

Use `satisfies` when an object should be checked without widening its inferred
shape. `workspaceDocumentFor` in `src/App.tsx` checks the synchronized document
against `Record<string, unknown>`, and login/session helpers in
`src/platform-api.ts` check `PlatformSession`.

## Unknown Data and Narrowing

There is no runtime schema library. JSON boundaries use `unknown` or
`Record<string, unknown>` and narrow values before use. Follow the defensive
patterns in `src/platform-context.ts`:

- Wrap browser-storage JSON parsing in `try/catch`.
- Check arrays with `Array.isArray`.
- Check scalar values with `typeof` and numeric versions with
  `Number.isInteger`.
- Return an empty/default value when old storage is malformed.

Event payloads are also narrowed before rendering. `ElementsPage.tsx` checks
that `screenshotId`, `firstMatch`, and `reason` are strings. When filtering an
array also serves as narrowing, use a type-predicate callback, as
`AutomationsPage.tsx` does for environment IDs.

The generic `request<T>` helpers cast decoded JSON to the declared API contract;
that is a transport convention, not runtime validation. Validate any new
untrusted or versioned payload whose fields drive persistence, security, or
control flow.

## Assertions and Nullability

Use optional fields and explicit `undefined`/`null` checks for genuinely absent
data. Pages commonly fall back with `?? []`, return early when session/project
context is absent, and render `PlatformProjectRequired` for unavailable remote
features.

Keep assertions at established boundaries. The root element non-null assertion
in `src/main.tsx` is backed by the Vite HTML template. Browser JSON uses an
assertion only before subsequent validation. Avoid assertions in ordinary
component logic merely to silence a missing state check.

## Avoid

- Do not add `any`; use `unknown` and narrow it.
- Do not duplicate API/domain shapes inside a page.
- Do not use a broad `as` assertion in place of checking browser, event, or
  server data.
- Do not weaken compiler options or add unused parameters. Prefix an
  intentionally discarded destructured value with `_`, as in store helpers.
- Do not convert existing product-string unions or persisted values without a
  migration and regression coverage.
