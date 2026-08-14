# 审计与治理增强

## Goal

扩展平台审计记录范围（认证、通知投递、运行生命周期、敏感操作），增强治理页审计日志的浏览能力（全量列表、筛选、搜索、详情），并调整治理指标（时间窗口、环比、新指标、失败归类细化、趋势周期）。

## Background

- 现状：`audit_events` 单表（`server/platform-audit.ts`）已有 30+ 类事件埋点（资源增删改、flow_revision 发布/回滚、模板、数据集、定时任务、webhook、密钥轮换、运行创建、元素验证、通知通道），但缺少认证、通知投递结果、运行生命周期结束、敏感操作类事件。
- 审计 API `GET /api/platform/projects/:id/audit-events`（`server/platform-handler.ts:718`）固定 `ORDER BY created_at DESC LIMIT 500`，无分页/筛选/搜索；治理页（`src/pages/GovernancePage.tsx`）只消费 `flow_revision.*` 事件并截取 12 条。
- 指标 `projectAnalytics`（`server/platform.ts:990`）基于最近 500 次运行：summary（运行总数/成功率/失败数）、按日趋势（最近 30 天）、失败归类（仅按 `run.failed` 事件 message 分类）、慢步骤、元素影响。无时间窗口选择、无环比、无周期选项。
- 衔接当前任务 `08-14-fix-webhook-migration-notifications`：其补的 `NOTIFICATION_REJECTED_<code>` 识别（`server/platform.ts:943`）正是通知投递审计的事件来源。

## Requirements

### R1 审计记录范围扩展

- R1.1 认证事件：注册、登录成功、登出、登录失败，detail 含来源 IP（`remoteAddress`，见 `platform-handler.ts:1188` 已有采集）。
- R1.2 通知投递结果：每条通知投递记录成功/失败/业务拒绝（`NOTIFICATION_REJECTED_<code>` / `NOTIFICATION_DELIVERY_FAILED` / 超时等），含通道类型与目标名称（不含密钥/URL 明文）。
- R1.3 运行生命周期：运行结束事件（success/failed/canceled），failed 含失败分类（错误码/阶段），与 `run.created` 形成完整生命周期。
- R1.4 敏感操作留痕：密钥解密用于执行、通知通道配置查看等敏感读操作记录事件（当前只有 `secret.rotated`）。

### R2 审计界面增强

- R2.1 全量事件列表：展示全部事件类型（不再只限 flow_revision），服务端分页（替代固定 LIMIT 500）。
- R2.2 筛选器：按事件类型、操作者（actor_id/actor_type）、时间范围筛选，服务端带参查询。
- R2.3 事件详情展开：行展开查看 detail JSON（目标类型/资源名/错误码等），敏感字段（密钥、URL、凭据）脱敏展示。
- R2.4 关键字搜索：按 action、目标、detail 内容搜索。

### R3 治理指标调整

- R3.1 时间窗口可选：近 7/14/30 天或最近 N 次运行，支持环比（与上一窗口对比成功率/运行数变化）。
- R3.2 新增指标：运行时长趋势、失败率/取消率变化、定时任务调度健康度（调度成功/跳过比例）。
- R3.3 失败归类细化：按错误码、失败阶段、关联元素维度归类（当前仅按 message 文本分类）。
- R3.4 趋势周期选项：按日（现状）/按周汇总可选，支持自定义日期范围。

## Out of Scope

- 平台层其它变更（登录认证行为、密钥管理 UI、API 接入、部署配置）——用户明确本次只谈审计/治理。
- 审计保留策略/清理任务、导出功能。
- 成员/角色体系（已移除，登录即全权限）。
- webhook 迁移修复本身（属当前任务 `08-14-fix-webhook-migration-notifications`，仅消费其 errcode 识别结果）。

## Acceptance Criteria

- [ ] 注册/登录成功/登出/登录失败均有 audit_events 记录，登录相关事件含来源 IP。
- [ ] 通知投递成功/失败/业务拒绝（含 code）产生审计事件，不含密钥与 URL 明文。
- [ ] 运行结束（success/failed/canceled）产生审计事件，failed 含失败分类信息。
- [ ] 密钥解密用于执行、通知配置查看产生审计事件。
- [ ] 审计 API 支持分页参数（page/pageSize）与筛选参数（action 前缀/actor/时间范围/关键字），治理页全量事件列表可用。
- [ ] 治理页审计列表支持类型/操作者/时间筛选与关键字搜索，行展开可见脱敏后的详情。
- [ ] 治理页支持时间窗口选择（7/14/30 天或最近 N 次）与环比展示。
- [ ] 新增指标（运行时长趋势、失败率/取消率、定时任务调度健康度）展示可用。
- [ ] 失败归类支持按错误码/阶段/元素维度查看。
- [ ] 趋势支持按周汇总与自定义日期范围。
- [ ] 项目 lint、type-check、现有测试通过；新增审计/治理相关单元测试与契约冒烟覆盖。
