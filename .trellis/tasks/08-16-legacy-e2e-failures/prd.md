# 排查 11 个遗留 E2E 失败

## Goal

让 `npm run test:e2e` 全量通过，消除当前 11 个与任何近期改动无关的遗留失败，恢复 E2E 作为发布门禁的可信度。

## Background And Evidence

2026-08-16 在 P0 任务（`08-15-flow-revision-selection-correctness`，提交 `ad8b061`）验证时发现 11 个 E2E 失败。已用 `git stash` 在**未改动基线**上复现为完全相同的 11 个，确认与 P0 改动无关，属遗留缺陷。当时 24 个通过，与本任务相关的 5 个 spec（management-and-run、full-user-journey、worker-run、saucedemo-import-run）全部通过。

失败清单（均为 `[chromium]`，最后一组为 `[production-auth]` 项目）：

- `tests/automation-edit.spec.ts:98` edits an existing schedule
- `tests/automation-edit.spec.ts:122` rotates a webhook signing secret and shows it once
- `tests/automation-edit.spec.ts:139` sends a test notification
- `tests/data-automations.spec.ts:9` renders versioned data and creates a published-version schedule
- `tests/history-pagination.spec.ts:78` restores run filters and page from URL
- `tests/history-pagination.spec.ts:104` restores delivery filters and page
- `tests/runs-history.spec.ts:102` loads platform run history on first entry with an empty run store
- `tests/runs-history.spec.ts:113` shows scheduled or webhook runs without manual refresh while an active run is polling
- `tests/production-sync.spec.ts:119`（production-auth）restores and retries a saved edit after reload
- `tests/production-sync.spec.ts:149`（production-auth）keeps the draft on conflict and resubmits against the latest version
- `tests/production-sync.spec.ts:203`（production-auth）refreshing after conflict drops the local draft and restores the server element

复现命令与错误上下文样例：`npm run test:e2e`；error-context 位于 `tmp/autoflow-e2e-*/test-results/`。

## Requirements

- R1：逐个定位根因（测试过期 / 环境依赖 / 真实产品缺陷），按 spec 分组归因；不通过放宽断言或删除测试制造通过。
- R2：修复测试或产品缺陷；若个别用例确已失效（功能已裁剪），必须提供证据并显式移除，不允许静默 skip。
- R3：失败聚焦在三组能力——自动化配置编辑（schedule/webhook/通知）、历史分页 URL 恢复、运行中心平台历史；排查时优先检查这三组对应的近期改动（服务端分页、自动化配置编辑、通知改造提交）。
- R4：`production-auth` 项目的三个失败需要按 Playwright 配置的生产鉴权环境复现，确认是环境问题还是代码问题。

## Acceptance Criteria

- [ ] AC1：`npm run test:e2e` 在干净环境全量通过（35/35），Windows 门禁另行验证。
- [ ] AC2：每个失败项有归因记录（根因 + 修复方式或移除理由）写入本 PRD 或 research 文件。
- [ ] AC3：修复过程不修改与失败无关的断言；被修复的产品缺陷有对应回归测试。

## Out Of Scope

- Windows 门禁（`npm run test:windows`）的修复与执行。
- 新增 E2E 覆盖；本任务只恢复既有套件健康。

## Notes

- 轻量任务：PRD-only。开始实现前仍需用户批准本 PRD 的 planning summary。
