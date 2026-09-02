import { describe, expect, it } from "vitest";
import type { PlatformRun, PlatformRunSummary } from "../api/platform-api";
import {
  platformRunAsRun,
  platformRunAsStoreRun,
  platformRunSummaryAsRun,
} from "./shared";

/** P1-5：列表 / 派发收到的轻量摘要字段（服务端 run_summaries 计算）应被
 *  无损映射到前端 Run 行 —— 与后端摘要契约保持同语义。 */
function summary(overrides: Partial<PlatformRunSummary> = {}): PlatformRunSummary {
  return {
    id: "run-1",
    projectId: "proj-1",
    environmentId: "env-1",
    status: "running",
    retryOfRunId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    flowName: "流程1",
    environmentName: "测试环境",
    totalSteps: 3,
    completedSteps: 1,
    progress: 33,
    screenshotCount: 0,
    ...overrides,
  };
}

/** 全量 PlatformRun：单 run 详情 / 重试 / 取消接口仍返回此形态。 */
function fullRun(overrides: Partial<PlatformRun> = {}): PlatformRun {
  return {
    id: "run-9",
    projectId: "proj-1",
    revisionId: "rev-1",
    environmentId: "env-1",
    agentId: "ag-1",
    executorType: "managed",
    status: "running",
    retryOfRunId: null,
    cancellationRequested: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    snapshot: {
      flow: { id: "flow-1", name: "流程1", steps: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] },
      environment: { id: "env-1", name: "测试环境" },
    },
    events: [
      { id: 1, kind: "step.completed", data: {}, at: "2026-01-01T00:00:30Z" },
    ],
    artifacts: [
      { id: "a1", name: "shot.png", contentType: "image/png", createdAt: "2026-01-01T00:00:45Z" },
    ],
    flowOutputs: [],
    ...overrides,
  };
}

describe("P1-5 摘要→Run 行映射", () => {
  it("摘要：running 计服务端 progress/completedSteps，screenshotCount 映射到 screenshots", () => {
    const run = platformRunSummaryAsRun(summary());
    expect(run.flowName).toBe("流程1");
    expect(run.environment).toBe("测试环境");
    expect(run.status).toBe("running");
    expect(run.totalSteps).toBe(3);
    expect(run.completedSteps).toBe(1);
    expect(run.progress).toBe(33);
    expect(run.screenshots).toBe(0);
    expect(run.duration).toBe("进行中");
  });

  it("摘要：success 终态固定 progress 100 且 duration 已完成", () => {
    const run = platformRunSummaryAsRun(
      summary({ status: "success", completedSteps: 3, progress: 100, screenshotCount: 2 }),
    );
    expect(run.progress).toBe(100);
    expect(run.completedSteps).toBe(3);
    expect(run.screenshots).toBe(2);
    expect(run.duration).toBe("已完成");
  });

  it("摘要：dispatched 归一为 running；queued 终态保持 duration 已完成/失败", () => {
    const dispatched = platformRunSummaryAsRun(summary({ status: "dispatched", completedSteps: 0, progress: 0 }));
    expect(dispatched.status).toBe("running");
    expect(dispatched.duration).toBe("进行中");
    const failed = platformRunSummaryAsRun(summary({ status: "failed", completedSteps: 1, progress: 33 }));
    expect(failed.status).toBe("failed");
    expect(failed.duration).toBe("已完成");
  });

  it("统一入口：全量 PlatformRun 走 platformRunAsRun，摘要走 summary 分支", () => {
    const full = fullRun();
    const fromFull = platformRunAsStoreRun(full);
    expect(fromFull.flowName).toBe("流程1");
    expect(fromFull.totalSteps).toBe(3);
    // 1 个 step.completed 事件 + 1 张截图，从全量数据派生
    expect(fromFull.completedSteps).toBe(1);
    expect(fromFull.progress).toBe(33);
    expect(fromFull.screenshots).toBe(1);

    const fromSummary = platformRunAsStoreRun(summary());
    expect(fromSummary.flowName).toBe("流程1");
    expect(fromSummary.completedSteps).toBe(1);
    expect(fromSummary.screenshots).toBe(0);
  });

  it("全量映射：success 时 completedSteps 按总步数计（与后端同语义）", () => {
    const full = fullRun({ status: "success" });
    const run = platformRunAsRun(full);
    expect(run.progress).toBe(100);
    expect(run.completedSteps).toBe(3);
    expect(run.duration).toBe("已完成");
  });
});
