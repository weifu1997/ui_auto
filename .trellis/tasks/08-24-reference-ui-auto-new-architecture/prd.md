# 参考 ui_auto_new 整体架构改造

## Goal

参考 `hanwenlu2016/ui_auto_new` 的产品与架构思路，评估并改造本项目的整体架构、录制/执行流程、断言体系和 UI，使自动化用例更易维护、执行更稳定、结果更可解释。

## Background

### 当前项目事实

- 前端为 React 19 + TypeScript + Vite + Ant Design + Zustand/TanStack Query；后端为 Python FastAPI + SQLite + Playwright。
- 生产入口由 `npm run start` 托管；运行由 Platform ManagedRunner 调度，支持取消、重试、事件、截图、Trace 和批量执行。
- 已有三栏流程编辑器、元素库、变量/环境、模板库、运行中心和运行详情。
- 录制已有浏览器会话生命周期、暂停/恢复、停止、事件分页和导入候选；`src/lib/recording-editor-state.ts` 会把部分录制结果转换为步骤。
- 断言已有 `assertMatch`、`assertVisibility`、`assertOperator`、`assertAttribute` 字段；后端可生成断言报告、项目级统计和失败汇总。

### 参考项目公开信息

网络克隆不可用，以下来自 GitHub 搜索摘要：

- 技术栈为 FastAPI、Vue3、Vite、Pinia、Element Plus、Playwright、Celery、Redis、MySQL/SQLite。
- 产品强调 Page-Agent 智能定位、AI 自愈、智能录制、可视化编排、异步任务、HTML/Excel 报告和多环境管理。
- 该仓库描述为“新一代 Web UI 自动化测试平台”。

## Requirements

### R1 整体架构

采用渐进增强路线：保留 React + FastAPI + SQLite + ManagedRunner 主架构，只吸收参考项目的可维护领域模型、录制/执行语义、报告能力和编排体验。

### R2 录制/执行流程

对比并吸收参考项目中智能录制、候选元素生成、异步任务调度、重试/恢复和执行反馈的可落地能力；不引入未经确认的外部 AI 服务依赖。

### R3 断言体系

统一录制断言、编辑器断言配置、执行断言和报告语义；补齐缺失的断言类型时必须保持旧流程快照兼容。

### R4 UI

对齐参考项目的可视化编排体验，但保留本项目 Ant Design 视觉与无障碍约定；重点提升录制候选、步骤编辑、断言配置、执行状态和报告的可读性。

- 保持现有登录、工作区、项目隔离、审计和密钥安全边界。
- 改造范围分为整体架构、录制/执行、断言、UI 四个可验收模块。
- 参考仓库代码未能完整获取前，不得直接照搬未验证实现。

## Acceptance Criteria

- [ ] 已产出当前项目与参考项目的能力/架构差距矩阵。
- [ ] 用户已确认技术路线：渐进增强或技术栈迁移。
- [ ] 每个模块有明确的 MVP 范围、非目标和验收标准。
- [ ] 改造方案说明数据模型、API、前端状态和执行链路变化。
- [ ] 方案包含兼容性、回滚和验证策略。

## Out of Scope（初稿）

- 不在规划完成前修改业务代码。
- 不默认引入 MySQL、Redis 或 Celery；是否引入取决于用户选择的技术路线。
- 不默认接入外部商业 AI 服务。

## Key Decisions

- D1 技术路线：渐进增强现有 React/FastAPI/SQLite/ManagedRunner 架构；不迁移到 Vue3/Pinia/Element Plus，不默认引入 Celery/Redis/MySQL。
- D2 交付形态：先形成一次性整体改造方案，覆盖架构、录制/执行、断言与 UI；实现按依赖关系分阶段交付，保证每阶段可验证、可回滚。
