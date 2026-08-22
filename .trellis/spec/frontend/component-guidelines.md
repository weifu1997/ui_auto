# Component Guidelines

## Component Shape

Route pages are function components with named exports and explicit props.
Project-scoped screens normally receive the current `Project`:

```tsx
export function OverviewPage({ project }: { project: Project }) {
  const storedRuns = useRunStore((state) => state.apiRuns[project.id]);
  // derive view data, then return the page
}
```

This shape is repeated in `src/pages/OverviewPage.tsx`,
`src/pages/ElementsPage.tsx`, and `src/pages/AutomationsPage.tsx`. Use a named
props type when the contract is larger or reused, as `RunDetailPageProps` does
in `src/pages/RunDetailPage.tsx`; otherwise the inline object type is normal here.

Lazy route modules are adapted in `src/App.tsx`. Existing root pages use default
exports while `src/pages/*Page.tsx` uses named exports. Match the module being
edited rather than changing export style as an unrelated cleanup.

## Composition

- Start project screens with `PageHeading` from `src/pages/shared.tsx` and pass
  command controls through its `actions` prop.
- Use `ProjectLayout`/`ProjectShell` for navigation context; pages should not
  rebuild the project sidebar.
- Use fragments for a page's unframed sections. Existing section containers
  use semantic `main`, `header`, and `section` elements plus global classes.
- Keep page-only drawers, modals, and row components below the page component.
  `ElementDrawer` and `ValidationModal` in `src/pages/ElementsPage.tsx` are the
  representative pattern.
- Compute small derived arrays and counts during render. Examples are
  `visibleProjects` in `ProjectsPage.tsx` and `publishedRevisions` in
  `AutomationsPage.tsx`; do not mirror them into state.

## Ant Design and Feedback

Use Ant Design controls and `@ant-design/icons` consistently with surrounding
pages. Tables declare `TableColumnsType<T>` when the columns are nontrivial, use
a stable `rowKey`, and define an explicit empty state. Forms use
`Form.useForm()`, named `Form.Item` fields, and reset or seed fields when a
drawer/modal opens.

Use `message` and `modal` from `src/lib/antd-feedback.tsx`, not a new global feedback
singleton. `AntdFeedbackBridge` in `src/App.tsx` connects those helpers to the
active Ant Design app context.

Async commands expose a visible loading/disabled state and report failure at
the page boundary. The common shape in `DatasetsPage.tsx`,
`GovernancePage.tsx`, and `AutomationsPage.tsx` is:

```tsx
setLoading(true);
try {
  const response = await getPlatformDatasets(session.token, projectId);
  setDatasets(response.datasets);
} catch {
  message.error("Unable to load datasets");
} finally {
  setLoading(false);
}
```

Keep API construction and typed errors in `platform-api.ts`; components
orchestrate calls and render states.

## Styling

Use `className` values backed by `src/App.css` and responsive rules from
`src/responsive.css`. Global Ant Design theme tokens live in `src/App.tsx`.
Reuse those tokens and components rather than hard-coding a second theme in a
page. Inline style objects are not the normal component styling mechanism.

## Accessibility

- Prefer Ant Design's labeled `Form.Item` and semantic controls. Playwright
  flows intentionally locate inputs by label and commands by role in
  `e2e/workbench.spec.ts` and `e2e/platform-run.spec.ts`.
- Give icon-only buttons an `aria-label` that includes the affected item when
  applicable. See the project menu in `src/pages/ProjectsPage.tsx` and element
  actions in `src/pages/ElementsPage.tsx`.
- Wrap unfamiliar icon actions in `Tooltip`; `DatasetsPage.tsx` and
  `DebugSessionsPage.tsx` demonstrate the pattern.
- Use `Popconfirm` or `modal.confirm` for destructive/archive actions.
- Preserve native keyboard and modified-click behavior when implementing
  navigation; `Link` in `src/router.tsx` is the reference.

## Avoid

- Do not fabricate a successful result when Platform calls fail; display or
  propagate the Platform error instead.
- Do not read or render secret values from persisted run data. Secret entry is
  session-only and must be requested again when a run needs it.
- Do not extract a one-off page fragment into a generic component directory.
- Do not mix a broad visual redesign or export conversion into a focused page
  change.

## Layout & Filter Bar Conventions

- Use `FilterBar` and `FilterItem` from `src/pages/shared.tsx` for search, status, and date range filters across list and dashboard views. Avoid mixing raw `<span>` text nodes directly with Ant Design inputs inside `Space`.
- Table action columns should use `Space size={4}` and icon-only `Button type="text" size="small"` wrapped in `Tooltip` with an explicit `aria-label`. Standard action column widths: 56px (1 action), 88px (2 actions), 120px (3 actions).
- Metric summaries use `MetricCard` from `src/pages/shared.tsx` with semantic tones (`default`, `success`, `warning`, `info`).
- Table and drawer interior empty states should consistently use `<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="..." />`.
