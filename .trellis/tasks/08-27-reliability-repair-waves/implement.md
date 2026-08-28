# 执行清单（状态快照 2026-08-27）

约定：[x] 完成 · [~] 完成但有偏离/缓期说明 · [ ] 待办

## Wave 0 正确性 —— 全部完成，出口五连全绿
- [x] W0-1 preview 线程池化 + BoundedSemaphore(1) 并发闸（PREVIEW_BUSY 409）+ 3 个并发回归测试
- [x] W0-2 fullText 全文捕获（DTO 白名单 + 候选）+ runner exact 失败降级子串并打 step.locatorFallback 事件；4+ 项测试
- [x] W0-3 autoflow/sensitive.py 词表单源（中英文），注入脚本与服务端判定共享；前端词表留作双保险；回归测试含中文标签明文拦截
- [x] W0-4 步骤级心跳 touch_run_heartbeat + RUN_WATCHDOG_MINUTES(默认20, 钳制[5,240]) + absorb_late_completed_run 兜底（产物入库、状态不回改）
- [x] W0 出口：build/lint/unit101/py241/e2e28 全绿

## Wave 1 可靠性 —— 全部完成，出口五连全绿
- [x] W1-1 finalize_completed_run 单 BEGIN IMMEDIATE 终态+outputs+事件+审计+投递登记；投递网络发送移到提交后（queue_run_deliveries 加 flush 参数）；崩溃回滚测试
- [x] W1-2 _sweep_orphan_artifact_files 孤儿清扫(>24h 无行引用) 进 retention；preview 截图改 mkdtemp+finally rmtree
- [x] W1-3 recover_interrupted_validations 启动恢复 + reap_stale_element_validations 运行期收割 + POST cancel 端点（幂等+状态守卫防迟到覆盖）；授权矩阵测试同步登记新路由
- [x] W1-4 派生状态 total=0 → failed（契约"派生且不双写"合规），retry 无子项仍 BATCH_NOT_RETRYABLE
- [x] W1-5 request_run_cancel 标记先行修根竞态 + 等待步骤 WAIT_STEP_MAX_MS 硬上限(默认10min)+step.waitCapped 事件
- [x] W1-6 assertion_stats 仅统计 success/failed；前端 previewPlatformRun 接线「运行至此步骤」走 /runs/preview，结果 Modal 展示断言明细
- [x] W1-7 RunDispatchKeyMap：用户分区 localStorage 持久化（TTL 24h）写穿式 Map 子类，5 页面接入，登出清理纳入 account-state-reset
- [x] W1 出口：unit103/py254/e2e28 全绿

## Wave 2 契约治理 —— 4/6 完成
- [x] W2-4 flow-normalize 未知顶层键透传 + variables/secretNames 转正类型化 + 4 组新测试
- [x] W2-5 UNSUPPORTED_ACTION 显式化 + trimCompare 文本空白归一化（默认开，双侧 STEP_KEYS 成对新增 trimCompare）+ 数量断言纯数字输入约束 + 回归测试
- [x] W2-6 导入面板新增文本/属性断言建议草稿（每类上限10条，敏感绑定自动排除），选择模型改按断言 id
- [x] W2-2 git mv mock-data.ts → src/domain/model.ts，原路径保留 `export *` barrel 零调用方改动
- [~] W2-1 动作名 ID 化——**缓期**：完整三段切.write侧需同时动 recorder 归一器输出、revision checksum 去重行为与全部手抄中文 JSON 的 e2e/spec 回归集，半途状态比不动更危险。后端现已具备双读能力（本波 runner 收紧了分发处未知值处理）。建议独立任务按 design.md 三段计划执行。
- [~] W2-3 platform-api 分域拆分——**缓期**：1565 行拆分属纯机械但体量大，宜在本批提交落定后单独成批做，避免与本批正确性修复混在同一 review 面。

## Wave 3 试点 —— 完成
- [x] @xyflow/react@12.11.5 (MIT)；FlowGraphView 只读图（Modal + lazy chunk 独立分包 FlowGraphView-*.js）；点节点回选中；check:bundle 通过

## 收尾
- [x] spec 契约沉淀 → `.trellis/spec/backend/run-batch-recording-contracts.md` 追加三段（敏感单源 / 终态事务化 / 心跳与收割 + 取消标记先行），及 frontend/state-management 增补 dispatch key 持久化契约
- [ ] batched commit 计划已列出，等待用户一次性确认后执行（见会话末尾）
