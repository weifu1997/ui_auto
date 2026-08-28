# 审查 WARNING 修复

## Goal

把 2026-08-28 全库复审确认的 5 项 WARNING 修到可验证：功能分支有 CI、restore 预快照可恢复、开始录制不再占满请求线程、`started()` 异常不再把 run 卡在 queued、本机/CI 的 Chromium 安装路径与跳过判断一致。

## Background

- 审查报告（会话内，对照 HEAD `8c7c0b2` 一带）未发现新的 CRITICAL。历史 C-1/C-2/C-3、R-C1、N-C1/N-C2 与 planning-tier 跟进均未复现。
- 本任务只修审查列出的 WARNING，不顺手做 INFO，不改断言契约或 RBAC。
- 前端 `request()` 已有 15s abort（`src/api/platform-api.ts:407`）。录制 create 若在服务端 `wait(120)`，用户侧会先超时。前端已认识 `starting` 状态并轮询。

## Confirmed facts

| ID | 问题 | 锚点 |
| --- | --- | --- |
| P-W1 | CI 只监听 `python_3.1` | `.github/workflows/phase0-ci.yml:3-9`；`docs/生产基线发布与分支保护.md:7` 仍写集成分支是 `python_3.1` |
| P-W2 | restore 预快照只拷 `platform.sqlite` | `scripts/ops/restore.ps1:27-32`；规范要求 sqlite+wal+shm 三文件 |
| P-W3 | create 在线程池里 `browserReady.wait(120)`，且就绪在 `goto` 之后 | `handler/recordings.py:60`、`recorder.py:195,288-307` |
| P-W4 | `started()` 抛错被当成 `False`，不调 `completed()` | `server-py/autoflow/managed_runner.py` `_execute` |
| P-W5 | `setup:py` 用 `server-py/.browsers` 是否存在决定跳过安装，真正的 `playwright install` 未写入该路径 | `scripts/setup-py.mjs:57-67` |

## Requirements

- **R1 / P-W1**：仓库内 `Phase 0 CI` 必须在当前功能分支的 push 与以其为目标的 PR 上运行，同时保留对集成分支 `python_3.1` 的现有触发。文档写明：集成分支仍是 `python_3.1`；CI 额外覆盖 `master` 与 `v3.2_flow_assertion`，避免功能分支无门禁。不在本任务里配置 GitHub 分支保护（那是管理员外部证据）。
- **R2 / P-W2**：`restore.ps1` 在覆盖活库前，把现网 `platform.sqlite` 及其存在的 `-wal`/`-shm` 一并拷到 `pre-restore-<stamp>/`。服务已停仍缺 wal 时只拷主文件即可。不改变 backup 主路径的 checkpoint 语义。
- **R3 / P-W3**：`POST .../recording-sessions` 在占住录制槽并提交浏览器任务后立即 201，session 可为 `starting`。浏览器 launch/`goto` 留在录制执行器线程。槽满仍立即 `RECORDING_BUSY`。前端已有轮询，不把 15s 客户端超时拉长。
- **R4 / P-W4**：`started()` 返回 `False`：视为取消/watchdog 已终态，不执行、不调 `completed()`，但必须释放 `_active` 槽。`started()` 抛错：走 failed `completed()` 并释放槽，不得把 run 留在 queued。
- **R5 / P-W5**：`setup:py` 安装 Chromium 时设置与跳过判断相同的 `PLAYWRIGHT_BROWSERS_PATH`。仅当该缓存里已有可用 Chromium 才跳过；空目录不得跳过。

## Acceptance Criteria

- [ ] AC1：改 `.github/workflows/phase0-ci.yml` 后，`on.push.branches` 与 `on.pull_request.branches` 含 `python_3.1`、`master`、`v3.2_flow_assertion`。`docs/生产基线发布与分支保护.md` 同步说明，且仍把 `python_3.1` 写成受保护集成分支。
- [ ] AC2：restore 在活库存在时，预快照目录含 `platform.sqlite`；若停服务后仍有 `-wal`/`-shm`，它们也在同一目录。WhatIf 路径不写盘。
- [ ] AC3：录制 create 的单测在 launch 被卡住时仍能在远小于 120s 内返回 201/`starting`（或等价 session 载荷）；`RECORDING_BUSY` 与同项目 `RECORDING_SESSION_ACTIVE` 行为不变。前端 `starting` 仍可进入轮询，不把 create 的 15s abort 改掉。
- [ ] AC4：`test_started_false_skips_browser_execution` 仍通过；新增用例：`started()` 抛错时执行器不跑、`completed` 收到 failed、槽位释放后下一 run 能启动。
- [ ] AC5：`setup-py.mjs` 在安装时带 `PLAYWRIGHT_BROWSERS_PATH`；对空缓存目录会执行 install。可用定向测试或脚本级断言覆盖，不要求真下 Chromium。
- [ ] AC6：`npm run lint`、`npm run test:unit`、`npm run test:py`、`npm run test:startup` 通过。

## Out of Scope

- 审查 INFO：LIKE 通配符、`/metrics` 鉴权、`windowDays` vs `window_days`、HTML `@@TOKEN@@` 顺序替换、`test:all` 在 Linux 上跑 `test:windows`、Ant Design 弃用警告、SQLite `check_same_thread=False`。
- 新断言类型、RBAC、通知投递模型、E2E/Windows smoke（除非某条 WARNING 的回归必须用到）。
- 更改 GitHub 分支保护、required checks、审批人（文档只描述仓库内 workflow 触发）。
- 把录制 create 的客户端 15s 超时改成 120s 来迁就服务端阻塞。

## Open Questions

无。P-W1 已确认：workflow 覆盖 `python_3.1`、`master`、`v3.2_flow_assertion`；集成分支文档仍写 `python_3.1`。

## Technical Notes

- 录制 create 属于可重构区：对外仍是 POST 201 + session 对象；允许 `status=starting`（前端类型已包含）。
- restore 三文件拷贝对齐 `.trellis/spec/guides/index.md` 的 SQLite 备份规则。
- ManagedRunner 的 `started()` 语义保持：`False` = 不要执行。
