# PRD: 前端视觉一致性与 UI 布局重构优化

## 1. Goal & Background
在 `AutoFlow` 前端项目中，多个核心页面（`ProjectsPage`, `FlowsPage`, `ElementsPage`, `VariablesPage`, `EnvironmentsPage`, `DatasetsPage`, `AgentsPage`, `AutomationsPage`, `GovernancePage`, `RunsPage` 等）存在由于历史演进带来的视觉不一致、排版失齐与深色模式适配缺陷。
本任务旨在通过建立系统级 Design Tokens、统一表单筛选栏布局规范（FilterBar）、标准化表格操作列按钮体系、收敛指标与空状态组件，实现全站视觉一致性并提升整体交互质感。

## 2. Confirmed Facts & File Anchors
- **色彩 Token 脱节与硬编码**：
  - `src/pages/ProjectsPage.tsx#L128`: `<Progress strokeColor={value > 90 ? "#227a52" : "#c68418"} />` 硬编码色值；
  - `src/App.css#L11-L200`, `src/App.css#L990-L1000`, `src/App.css#L1644-L1653`: 大量散落 hex 色值（如 `--navy: #223734`, `#8ce0bc`, `#45ab83`, `#568fbd`, `#d6a23c` 等），深色模式未全量覆盖；
  - `src/theme-mode.ts` 与 `src/theme.css`: 存在色值与变量定义脱节。
- **表单与筛选栏基线错位**：
  - `src/pages/RunsPage.tsx#L428-L460`: `<span>` 标签与 `<Input type="date">`、`<Select>` 混排，导致基线与高度不齐；
  - `src/pages/AutomationsPage.tsx#L126-L140`: 投递记录筛选栏与 RunsPage 存在同样问题；
  - `src/pages/GovernancePage.tsx#L104-L132`: `.audit-filters` 使用写死宽度的 flex 项，混入 `RangePicker` 后换行与高度参差；
  - `src/App.css#L927` (`.form-row`): `grid-template-columns: 1fr 1fr` 缺失 `align-items: start`，单侧校验错误导致对侧控件拉伸。
- **按钮与操作栏规格混乱**：
  - 表格操作列在各页面大小随意（`size="small"` vs `type="text"` vs 默认高度），间距随意（`size={0}` / `size={2}` / `size={4}`），列宽随意（66px / 140px / 150px）；
  - `src/pages/ProjectsPage.tsx` 和 `src/pages/TemplatesPage.tsx` 未使用 `PageHeading` 统一规范。
- **卡片与空状态层级分裂**：
  - 指标卡片存在 `.workspace-summary`、`<Metric>` 和手写 `.metric-card` 三种实现；
  - 表格与列表空状态在 `<Empty description="..." />` 和 `<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />` 之间随意混用。

## 3. Requirements

### REQ-1: 全局色彩体系与深浅模式统一 (Color System & Tokens)
- 消除 `src/App.css` 与 TSX 组件中的所有硬编码非标准 Hex 颜色，统一引用 `src/theme.css` 的 CSS 语义变量或 Antd `theme.useToken()`。
- 同步 `src/theme.css` 与 `src/theme-mode.ts` 的色板，确保浅色与深色模式下所有标签、状态胶囊、图表、资产图标对比度达标（WCAG AA）。

### REQ-2: 筛选栏与表单控件对齐标准化 (Filter Bar & Form Rows)
- 抽象统一的 `FilterBar` 和 `FilterItem` 容器，彻底替代散落的裸 `<span>` 标签。
- 将页面内原生 `<Input type="date">` 统一替换为 Antd `DatePicker`，确保统一的高度（34px/36px）和圆角规范。
- 修复 `.form-row` 两列栅格布局，设置 `align-items: start`，避免单列错误提示拉伸对侧。

### REQ-3: 按钮规格与表格操作列标准化 (Button & Action Column Standards)
- 标准化表格操作列：统一采用 `Space size={4}` 包裹，图标按钮采用 `type="text" size="small"` 配备 `<Tooltip>`；根据按钮数量标准化列宽（56px / 88px / 120px）。
- 规范页面 Header 操作按钮间距，全面统一采用 `PageHeading` actions 规范。

### REQ-4: 指标卡片与空状态展示标准化 (Metric Cards & Empty States)
- 统一指标卡片展示样式，收敛为标准 `MetricCard` 组件。
- 规范空状态：表格和嵌入式面板统一使用 `Empty.PRESENTED_IMAGE_SIMPLE` 紧凑型空状态，全屏初始引导使用完整插画。

## 4. Acceptance Criteria
- [ ] `npm run lint` 检查通过，无新增 warning 或 error。
- [ ] `npm run build` 和 `npm run check:bundle` 构建通过，JS chunk 预算不超标。
- [ ] `npm run test:unit` 全部单元测试通过。
- [ ] 浅色模式与深色模式下，各页面资产图标、状态 Tag、统计数字背景与文字对比度正常，无硬编码刺眼色块。
- [ ] `RunsPage`、`AutomationsPage`、`GovernancePage` 筛选栏在各种视口宽度下文本与输入框严格垂直居中对齐，无错位换行。
- [ ] 各页面表格操作列按钮大小、hover 态、间距整齐统一。

## 5. Out of Scope
- 不重构后端 API 接口或改变数据流向契约。
- 不重写现有业务逻辑或变更路由层级。
- 不引入 Tailwind CSS 等额外大型 CSS 框架，保持 Ant Design 6 + 原生 CSS Variables 架构。
