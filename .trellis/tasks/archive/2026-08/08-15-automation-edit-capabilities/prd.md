# 自动化编辑能力

## Goal

让计划任务、Webhook 和通知通道可以编辑而不是删除重建，并提供密钥轮换与测试通知，降低配置错误时的维护成本。

## Background

- `src/pages/AutomationsPage.tsx:92` 至 `:100` 只有新建、启停和归档。
- 服务端/客户端没有相应更新接口。
- Webhook 单次展示 secret，配置填错时删除重建成本高。

## Requirements

- R4.1 计划任务支持修改名称、Cron、时区、版本、环境和数据集。
- R4.2 Webhook 支持修改名称、版本、环境和数据集，并可显式轮换 signing secret。
- R4.3 通知通道支持修改名称、地址、类型和关键词，并提供“发送测试通知”。
- R4.4 所有修改保留审计事件；密钥和地址仍按现有加密、单次展示与脱敏规则处理。

## Acceptance Criteria

- [x] 已有计划任务/Webhook/通知通道可通过 UI 更新配置并持久化。
- [x] Webhook secret 可显式轮换，新 secret 仅响应一次展示。
- [x] 通知通道测试通知可投递并显示成功/失败结果。
- [x] 每次编辑产生审计记录，响应与审计 detail 不泄露 URL/keyword/signing secret。

## Notes

- 不新增通知渠道类型或重写权限模型。
- 不修改现有加密和脱敏规则。
