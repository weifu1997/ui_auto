# State Management

## State Ownership

The frontend uses several state mechanisms with distinct owners:

| State | Mechanism | References |
| --- | --- | --- |
| Open drawers, filters, loading, selected rows | Component `useState` | `ProjectsPage.tsx`, `ElementsPage.tsx`, `AutomationsPage.tsx` |
| Form values and validation | Ant Design Form | `VariablesPage.tsx`, `EnvironmentsPage.tsx` |
| Cross-page workspace documents | Persisted Zustand | `src/workspace-store.ts` |
| Run summaries | Persisted Zustand with filtering | `src/run-store.ts` |
| Current editor draft | Non-persisted Zustand | `src/flow-store.ts` |
| Secret values for the current browser session | Non-persisted Zustand | `src/secret-store.ts` |
| Server workspace hydration/cache | TanStack Query plus Zustand hydration | `src/ServerWorkspaceSynchronizer.tsx` |
| Route and route parameters | Local router context | `src/router.tsx` |
| Platform session/mappings/document versions | Browser storage helpers | `src/platform-context.ts` |

Keep UI state local unless another route or background synchronizer needs it.
For example, `ElementsPage` keeps validation dialogs local but writes the
updated `ElementAsset[]` through `useWorkspaceStore`.

## Zustand Store Pattern

Each store declares a state/action type and exports a `use<Name>Store` hook.
Updates are immutable and project-scoped maps preserve other projects:

```ts
setVariables: (projectId, variables) =>
  set((state) => ({
    variablesByProject: { ...state.variablesByProject, [projectId]: variables },
  })),
```

See `src/workspace-store.ts`, `src/run-store.ts`, and `src/secret-store.ts`.
Store actions own invariants: `setEnvironments` repairs an invalid active
environment; `archiveProject` removes every project-scoped collection;
`moveStep` rejects out-of-range moves.

Components select individual collections/actions rather than subscribing to
the entire workspace store. Use stable shared empty arrays from
`src/pages/shared.tsx` when a missing collection needs a fallback in a selector
or render path.

## Persistence Boundaries

Persistence is intentional, not the default:

- `workspace-store.ts` persists project documents under
  `autoflow-workspace-projects` and contains migrations for retired demo data
  plus obsolete local-product metadata.
- `sync-outbox.ts` persists recoverable server-workspace drafts under
  `autoflow-sync-outbox-v1`; secret variable values are always blanked before
  storage.
- `run-store.ts` persists run summaries but its `partialize` removes the
  original `request`, preventing run inputs and transient data from being
  stored.
- `flow-store.ts` is an editor draft with an explicit `isDirty` lifecycle and
  is not persisted.
- `secret-store.ts` never uses persistence. Secret values must disappear on
  reload and must not enter run snapshots, events, or browser storage.

When adding persisted state, update the existing migration/normalization path
and cover restore behavior. `tests/workbench.spec.ts` exercises workspace
migration; secret values must remain absent from every persisted shape.

## Server and Synchronization State

API modules return typed promises but do not own UI state. Pages generally load
remote records into local state and show explicit loading/error feedback.
Server-backed workspace documents are different: the synchronizers hydrate the
Zustand workspace, track document versions, debounce writes, retry transient
failures, and surface conflicts. `ServerWorkspaceSynchronizer` restores the
persistent outbox draft before hydration so a refresh cannot overwrite
unsaved local edits. See `src/ServerWorkspaceSynchronizer.tsx` and the
compatibility synchronizer in `src/App.tsx`.

When a conflict action calls `query.refetch()`, the hydration effect must depend
on both `query.data` and `query.dataUpdatedAt`. TanStack Query may retain the
same `data` reference through structural sharing when the remote document is
unchanged; `dataUpdatedAt` is the completion signal that still re-runs refresh
and resubmit actions. A stored `autoflow-sync-outbox-v1` draft wins over the
initial server document, except for an explicit "refresh remote" action.

The run center loads Platform history on first `/runs` entry and merges it into
`run-store` by run id. Non-terminal Platform runs use a short poll; terminal
history refreshes on a slower interval so scheduled/Webhook runs still appear
without manual refresh.

Run and delivery list pagination/filter state is reflected in URL search
parameters, so a page reload restores the same server-side page and filters.

Do not let a page overwrite remote workspace data directly or bypass optimistic
version handling. `tests/platform-sync.spec.ts` covers hydration, local-cache
loss, versioned writes, and retry behavior; `tests/templates-and-conflicts.spec.ts`
covers conflict recovery.

TanStack Query is not a second global domain store. Its current role is loading
and invalidating the server workspace. Domain collections still live in the
workspace store after hydration.

## Browser and URL State

Use `useNavigate` and `useParams` from `src/router.tsx` for navigable identity.
Do not keep a project ID or run ID in duplicated component state.

Browser storage access is concentrated in Zustand persistence and
`src/platform-context.ts`. That module validates legacy mapping shapes and
emits `platformContextChangedEvent` after session changes. Extend its helpers
when adding related storage instead of scattering another unvalidated key
through pages. `AgentsPage.tsx` contains older explicit session writes; treat
those as compatibility code, not a pattern to copy.

### Server-Issued Authorization Projection

`PlatformSession` persists only the server projection: nullable
`user.globalRole`, a selected workspace role, and that workspace's named
capabilities. `platform-context.ts` rejects unknown roles/capabilities before
they reach UI selectors. `canUseCapability` must read the selected workspace
only; it is navigation/command presentation, never an API authorization
decision. When a session contract changes, update the validator, typed API
model, all browser fixtures, and the server negative tests together.

Invitation and password-reset raw tokens are capability values, not session
state. Show a newly issued link from React component state once, then discard
it on close; do not write it to localStorage, sessionStorage, Zustand
persistence, query caches, logs, or rendered audit detail.

## Avoid

- Do not persist secrets, raw run requests, transient loading flags, form
  instances, or open-dialog state.
- Do not mutate arrays or nested project maps in place.
- Do not store values that are cheaply derived from existing collections.
- Do not introduce Redux or another store for an isolated feature.
- Do not update synchronized workspace documents outside store actions and the
  synchronization/versioning flow.
