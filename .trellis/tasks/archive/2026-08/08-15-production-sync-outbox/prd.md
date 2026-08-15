# 生产同步持久化与自动重试

## Goal

修复 `ServerWorkspaceSynchronizer` 在快速导航、刷新、浏览器重启和网络异常时丢数据且不重试的问题，建立可恢复、状态可见的生产同步链路。

## Background

- `src/ServerWorkspaceSynchronizer.tsx:352` 使用 450 ms 定时器，`:386` 在 effect 清理时取消全部定时器。
- `src/ServerWorkspaceSynchronizer.tsx:250` 失败分支只更新状态和提示，没有退避重试。
- 普通待同步修改没有持久 outbox，冲突草稿只在收到 `RESOURCE_VERSION_CONFLICT` 后写入 `sessionStorage`。
- 真实复现见 `docs/自测报告-内网部署验证.md:75`。

## Requirements

- R1.1 本地变更先写入可恢复 outbox，再执行防抖网络同步；成功后按项目、资源类型和版本精确确认。
- R1.2 对网络错误和 5xx 使用有上限的指数退避；409 保留显式冲突处理，不盲目覆盖。
- R1.3 同步状态区分等待同步、同步中、重试中、冲突、已同步，离开页面前仍能判断数据是否安全。
- R1.4 覆盖 `src/App.tsx:117` 的 production/auth-required 真实同步器，包括保存后立即导航、立即刷新、5xx 恢复、409 冲突和进程重启重放。
- R1.5 敏感变量明文不落盘；outbox 只保存资源引用和非敏感草稿，密钥运行时再获取。

## Acceptance Criteria

- [x] 保存任一资源后立即导航、刷新或关闭再打开，outbox 可回灌草稿并最终同步到服务端。
- [x] 断网/5xx 恢复后无需再次编辑即可自动同步，指数退避上限 30s。
- [x] 并发 409 时本地草稿可恢复且不会静默覆盖远端；用户能选择刷新远端或重新提交。
- [x] production/auth-required 场景下新增自动化测试，覆盖刷新恢复、5xx 重试、409 刷新与重提。

## Notes

- 不统一开发模式与生产模式两套同步器的 UI 重构。
- 不新增云端或 Redis 类外部队列基础设施。
- 沙箱限制：production-auth E2E 已加入配置并通过 `--list` 校验，实际浏览器运行受 localhost 隔离限制，需在非沙箱环境补跑。
