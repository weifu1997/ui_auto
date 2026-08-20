# Technical Design: 前端视觉一致性与 UI 布局重构

## 1. Architectural Architecture & Boundaries

```
[Design Tokens (theme.css & theme-mode.ts)]
         │
         ├──► [Ant Design ConfigProvider (App.tsx)]
         │          │
         │          └──► Antd Components (Button, Select, Table, DatePicker)
         │
         ├──► [CSS Variables (App.css & responsive.css)]
         │          │
         │          └──► Semantic Classes (.surface, .metric-card, .filter-bar)
         │
         └──► [Shared Components (src/pages/shared.tsx)]
                    ├── PageHeading (Header actions layout)
                    ├── FilterBar & FilterItem (Filter bar alignment)
                    ├── MetricCard (Summary metrics)
                    └── Table Action Helpers (Standardized row actions)
```

## 2. Design Tokens Refinement

### CSS Variables Expansion (`src/theme.css`)
- 新增语义化状态浅色与深色背景色：`--color-success-subtle`, `--color-warning-subtle`, `--color-error-subtle`, `--color-info-subtle`, `--color-accent-subtle`。
- 新增统一资产图标色板：
  - 项目图标：`--badge-project-bg`, `--badge-project-text`
  - 流程图标：`--badge-flow-bg`, `--badge-flow-text`
  - 元素图标：`--badge-element-bg`, `--badge-element-text`
  - 变量图标：`--badge-variable-bg`, `--badge-variable-text`
  - 产物图标：`--badge-artifact-screenshot`, `--badge-artifact-trace`, `--badge-artifact-video`

### Ant Design Token 统一
- 在 `src/theme-mode.ts` 中维护与 `src/theme.css` 完全一致的调色板（Primary, Success, Warning, Error, Info, Separator, Backgrounds）。

## 3. Component Contracts

### 3.1 `FilterBar` & `FilterItem`
在 `src/pages/shared.tsx` 中定义：
```tsx
export function FilterBar({
  children,
  extra,
  className = "",
}: {
  children: React.ReactNode;
  extra?: React.ReactNode;
  className?: string;
});

export function FilterItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
});
```
- **结构**：外层 flex 容器带有 `background: var(--surface)`, `border: 1px solid var(--separator)`, `border-radius: var(--radius-md)`。
- **对齐**：内层 `.filter-item` 采用 `display: inline-flex; align-items: center; gap: var(--space-2)`，使 label 与控件天然垂直居中。

### 3.2 表格操作列标准（Table Action Protocol）
- 统一使用 `<Space size={4}>` 包裹；
- 纯图标操作按钮使用 `<Button type="text" size="small" icon={...} />` + `<Tooltip>`；
- 操作列列宽规范：
  - 单按钮：`width: 56`
  - 双按钮：`width: 88`
  - 三按钮：`width: 120`
  - 包含文字或下拉菜单：`width: 140`
  - `align: "right"` 确保右对齐整洁。

### 3.3 `MetricCard` 组件收敛
```tsx
export function MetricCard({
  label,
  value,
  detail,
  tone = "default",
  icon,
}: {
  label: string;
  value: string | number;
  detail?: React.ReactNode;
  tone?: "default" | "success" | "warning" | "info";
  icon?: React.ReactNode;
});
```

## 4. Migration & Compatibility
- 保持所有现有组件 Props 及导出的向前兼容性，所有新工具组件均在 `src/pages/shared.tsx` 导出。
- 不影响现有 Playwright E2E 定位器（所有的 `aria-label`, `data-testid` 保持原样）。

## 5. Rollback Strategy
- 变更主要集中在 `src/App.css`, `src/theme.css`, `src/pages/shared.tsx` 及相关页面文件，若发生意外回归可通过 git 单独还原页面级别修改。
