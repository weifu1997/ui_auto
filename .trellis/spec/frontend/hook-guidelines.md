# Hook Guidelines

## Existing Hook Surface

There is no general-purpose custom-hooks directory. The shared custom hooks are
the router hooks in `src/router.tsx`: `useLocation`, `useNavigate`, and
`useParams`. They read a guarded context and keep navigation behavior behind
the local router API. Page code should use these hooks rather than reading or
mutating browser history directly.

Create a new custom hook only when stateful behavior is reused across multiple
components. Name it with `use`, keep its dependencies explicit, and colocate it
with its owning module unless the repository gains several consumers that need
a dedicated file.

## Zustand Hooks

Select the smallest store slice a component needs:

```tsx
const environments = useWorkspaceStore(
  (state) => state.environmentsByProject[project.id] ?? [],
);
const setEnvironments = useWorkspaceStore((state) => state.setEnvironments);
```

This is the pattern in `src/pages/AgentsPage.tsx`,
`src/pages/ElementsPage.tsx`, and `src/pages/RunsPage.tsx`. Use
`useWorkspaceStore.getState()` only in non-rendering orchestration such as the
synchronizers in `src/App.tsx` and `src/ServerWorkspaceSynchronizer.tsx`.

## Effects and Async Work

- Effects synchronize with external systems: authentication, storage/context
  events, network loading, timers, SSE, and store subscriptions. Derived view
  values remain in render.
- Do not make the effect callback `async`. Define/call an async function and
  explicitly discard its promise: `useEffect(() => { void load(); }, [load])`.
  This pattern appears in `AutomationsPage.tsx`, `DatasetsPage.tsx`, and
  `GovernancePage.tsx`.
- Wrap a loader in `useCallback` when it is called by both an effect and user
  actions. Include every session/project identifier it closes over.
- Guard state updates after long-lived async work. `ApplicationSessionGate` in
  `src/App.tsx` uses an `active` flag during session restoration.
- Always return cleanup for event listeners and subscriptions. The router
  removes `popstate`; polling and synchronization effects clear their timers
  and subscriptions.
- Use functional state updates when the next value depends on the previous
  value, as in `setContextRevision((value) => value + 1)`.

React hook rules are an Oxlint error via `.oxlintrc.json`. Do not disable them
to make an effect run conditionally; put the condition inside the hook.

## Server Data

HTTP calls live in `src/platform-api.ts` and use same-origin `/api`. Most pages
use local loading/data state and an explicit loader. TanStack Query is currently
reserved for the server workspace synchronizer (`useQuery` in
`src/ServerWorkspaceSynchronizer.tsx`) and related invalidation
(`useQueryClient` in `src/pages/ProjectsPage.tsx`). Follow the surrounding data
owner instead of converting one page to a different fetching model in
isolation.

The query client is provided above pages. Query keys must include the identity
that scopes the data; the server workspace query uses the workspace identity,
and project mutations invalidate the matching server-workspace cache.

## Ant Design Hooks

Keep Ant Design form instances local with `Form.useForm()` and watch dependent
fields with `Form.useWatch()`. `src/pages/AutomationsPage.tsx` uses watched
revision IDs to constrain environment choices, while `VariablesPage.tsx` uses a
watched secret flag to change form behavior.

## Avoid

- Do not add a custom hook that merely renames one `useState` or store selector.
- Do not duplicate fetch/error parsing in a hook; extend the API modules.
- Do not omit cleanup for timers, events, SSE, or store subscriptions.
- Do not suppress exhaustive dependencies by capturing stale project/session
  state. Rework the callback or effect boundary instead.
