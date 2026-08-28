# 平台完整性修复 Wave0–W2（+W3 试点）设计

来源：2026-08-27 三子代理审查结论 + 用户确认的修复方案。父任务：08-24-reference-ui-auto-new-architecture。

## 背景事实（已核实）

- 录制链路成熟度 6/10，断言链路 7.5/10；执行账面层扎实但异常路径有洞。
- 核心缺陷：preview 同步阻塞事件循环；text 定位采集截断×重放 exact 必失配；敏感规则三份不一致致中文标签明文外泄；watchdog 无心跳误杀长跑 run 且丢全部产物。
- 次级：completed 半事务、孤儿文件、validation 卡死无取消、僵尸 batch、cancel-vs-start 竞态标签错、dispatchKey 仅内存、断言统计混入试跑且 /runs/preview 前端零消费。
- 结构债：中文动作名即线协议；mock-data.ts 实为领域模型层被 25 文件引用；platform-api.ts 1565 行单文件；normalizeFlow 白名单剥顶层未知键 + 整对象 PUT 回写造成静默字段漂移。

## 波次与依赖

```
W0（正确性4项，互相独立）→ W1（可靠性7项）→ W2（契约治理6项）→ W3（React Flow 只读试点）
```

## 关键设计决定

1. **W0-1** preview 路由改 `run_in_threadpool` + `anyio.CapacityLimiter(1)` 并发闸（超限 409）。
2. **W0-2** 存全文、截断只在展示层：recorder 归一化拆 `_display_label()`（仅候选标题）与原值直通；runner 保持 exact=True（Playwright 对参数做空白归一化），失败自动 exact=False 重试一次并记 `locatorFallback=true`。旧行截断值不可追溯，接受。
3. **W0-3** 新建 `server-py/autoflow/sensitive.py` 单源词表（英文词 + 密码|口令|秘钥|密钥|令牌|凭证），掩码点前移到事件 append 前（value→"•••"，打 `inputMasked:true`）；前端逻辑退化为双保险暂留。
   ⚠️ 本项是强化 spec《Run Batch & Recording Contracts》既定契约 "Sensitive inputs carry binding metadata only, never their typed value"——现实现对该契约在中文标签场景是违反的。
4. **W0-4** ManagedRunner 新增每步 `on_progress(run_id)` 回调 → PlatformServices `UPDATE platform_runs SET updated_at WHERE status='running'`；watchdog 阈值环境变量 `RUN_WATCHDOG_MINUTES` 默认 20；completed 回调遇已被误杀置 failed 时不再静默 return——success 结果追加「late completion detected」事件且产物照常入库（状态不改回）。
5. **W1 系**按方案文本逐项实施（事务化 completed：文件先行→单 BEGIN IMMEDIATE 包状态终写+outputs+events+deliveries+artifacts 登记，事务失败尽力删孤儿文件；retention 加磁盘孤儿清扫(>24h 无行引用)；validations 补恢复/收割/取消端点；batch total=0 判 failed/expired；cancel 改无条件先 SET cancellation_requested=1 再看影响行数，completed 映射尊重该标记；wait 步骤上限 WAIT_STEP_MAX_MS 默认 10min；assertion_stats 仅统计正式终态 run 且前端试跑切 /runs/preview；dispatchKey 落 user-scoped localStorage TTL 24h）。
6. **W2 系**动作名 ID 化走三段独立 commit（后端双读 → v15 迁移数据 → 前端/e2e 切 ID）；STEP_KEYS 若新增 trimCompare 必须前后端同批成对加（checksum 一次性噪音已获方案确认接受）。
7. **W3** @xyflow/react 只读流程图 Tab，lazy chunk，过 `check:bundle` 500kB 门限。

## 验证准绳

```
npm run build && npm run lint && npm run test:unit && npm run test:py && npm run test:e2e
```
每波出口跑全量。

## Out of Scope

asyncio Playwright 迁移与进程组强杀；MySQL/Redis/Celery/AI 定位服务（D1 否决）；react-diff-viewer 第三方 diff；AI 自愈。
