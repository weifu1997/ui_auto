# Execution Plan: 前端视觉一致性与 UI 布局重构

## 1. Ordered Checklist

### Step 1: Design Tokens & CSS 基础增强
- [ ] 在 `src/theme.css` 中补全语义化状态浅色/深色背景与资产徽标 CSS 变量。
- [ ] 在 `src/App.css` 中将散落的 hex 色值替换为 CSS 变量引用。
- [ ] 修复 `src/App.css` 中的 `.form-row`，添加 `align-items: start`。
- [ ] 修复 `src/pages/ProjectsPage.tsx` 中的硬编码 `strokeColor`，替换为 theme token。

### Step 2: 共享组件与工具函数扩展 (`src/pages/shared.tsx`)
- [ ] 实现并导出 `FilterBar` 与 `FilterItem` 组件。
- [ ] 实现并导出标准化 `MetricCard` 组件。
- [ ] 规范化导出的常用表格操作列配置。

### Step 3: 各页面表单、筛选栏与操作列重构
- [ ] 重构 `src/pages/RunsPage.tsx` 筛选栏（使用 FilterBar、DatePicker，消除错位）。
- [ ] 重构 `src/pages/AutomationsPage.tsx` 投递记录筛选栏。
- [ ] 重构 `src/pages/GovernancePage.tsx` 审计与趋势筛选栏，统一 Metric 呈现。
- [ ] 标准化 `src/pages/FlowsPage.tsx`, `src/pages/ElementsPage.tsx`, `src/pages/VariablesPage.tsx`, `src/pages/DatasetsPage.tsx`, `src/pages/AgentsPage.tsx` 的表格操作列与工具栏。
- [ ] 统一表格内部空状态为 `Empty.PRESENTED_IMAGE_SIMPLE`。

### Step 4: 验证与质量检查
- [ ] 运行 `npm run lint` 验证 Oxlint 规则。
- [ ] 运行 `npm run build` 验证 TypeScript 类型与 Vite 构建。
- [ ] 运行 `npm run check:bundle` 验证 JS 包体积预算。
- [ ] 运行 `npm run test:unit` 验证前端单元测试。

## 2. Validation Commands
```bash
npm run lint
npm run build
npm run check:bundle
npm run test:unit
```

## 3. Risky Files & Rollback Points
- `src/App.css`: 样式全局影响大，修改时保持类名选择器精确，不修改未关联类。
- `src/pages/shared.tsx`: 多个页面共享的基础模块，保持所有现有导出兼容。
