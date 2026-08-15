# 规范化版本快照语义

## Goal

让 `updatedAt`、元素验证状态、步骤 UI 状态等展示或瞬态字段变化不再制造无意义 revision，并保证真实执行字段变化才创建新版本。

## Background

- `src/mock-data.ts:17`、`:30`、`:56` 表明流程、元素和环境含 `updatedAt`，元素还含 `validation`，步骤含运行/展示状态。
- `src/ServerWorkspaceSynchronizer.tsx:321` 将环境和元素对象直接发送。
- `server-py/autoflow/handler.py:2917` 对完整快照计算 checksum，导致展示时间、验证状态变化也可能 supersede 当前 published 版本。
- 真实记录见 `docs/自测报告-内网部署验证.md:82`。

## Requirements

- R2.1 在单一共享边界构建 revision DTO，只保留影响执行结果的字段。
- R2.2 排除 `updatedAt`、`validation`、步骤 UI 状态等字段，并对数组顺序、缺省值和 JSON 序列化给出明确契约。
- R2.3 相同执行语义重复保存返回同一 published revision；真实执行字段变化才创建新版本。
- R2.4 已绑定计划任务/Webhook 的 revision 不会因无关资源 round-trip 变为不可运行。
- R2.5 保留旧 revision 可执行，不批量重写历史记录。

## Acceptance Criteria

- [ ] 只改变 `updatedAt`、元素验证状态或步骤 UI 状态不会创建新 revision。
- [ ] 改变定位器、步骤动作、变量值或环境执行配置会创建新 revision。
- [ ] revision checksum 契约有单测覆盖，并验证序列化顺序和缺省值。
- [ ] 已发布的旧 revision 仍可被计划任务/Webhook 执行。

## Notes

- 不删除历史 revision 或重写已有快照数据。
- 不新增执行语义字段或改变运行引擎数据模型。
