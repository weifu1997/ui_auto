import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerWorkspaceSynchronizer } from "./ServerWorkspaceSynchronizer";
import { useWorkspaceStore } from "./stores/workspace-store";
import {
  platformCapturedUpdates,
  platformRevisionCount,
  seedPlatformServer,
  updatePlatformProjectMeta,
  updatePlatformResourceData,
} from "./test/server-handlers";

// 反馈桥要求 AntdApp 实例已挂载；同步器仅在异常路径调用，测试直接替身。
vi.mock("./lib/antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

const platformSessionStorageKey = "autoflow-platform-session";
const platformWorkspaceStorageKey = "autoflow-platform-workspace";
const workspaceId = "workspace-1";

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function seedSession() {
  localStorage.setItem(
    platformSessionStorageKey,
    JSON.stringify({
      token: "test-token",
      user: { id: "user-1", email: "tester@example.com", name: "测试员", globalRole: null },
      workspaces: [
        { id: workspaceId, name: "工作区", role: "admin", capabilities: ["project.view", "project.edit", "flow.edit"] },
      ],
    }),
  );
  localStorage.setItem(platformWorkspaceStorageKey, workspaceId);
}

function resetStore() {
  useWorkspaceStore.setState({
    projects: [],
    flowsByProject: {},
    elementsByProject: {},
    variablesByProject: {},
    environmentsByProject: {},
    activeEnvironmentByProject: {},
    platformProjectIdsById: {},
    platformSyncStatusById: {},
    platformSyncErrorById: {},
  });
}

function renderSynchronizer() {
  const client = createQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <ServerWorkspaceSynchronizer />
    </QueryClientProvider>,
  );
  return view;
}

// fake timers 下 testing-library 的 waitFor 会因内部 setTimeout 也被伪造而卡死，
// 这里用「推进虚拟时钟 + 冲刷微任务」的本地轮询代替。
async function waitForState(check: () => boolean, message: string, timeoutMs = 3000) {
  const steps = Math.ceil(timeoutMs / 10);
  for (let i = 0; i < steps; i++) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(10);
  }
  if (!check()) throw new Error(`waitForState 超时：${message}`);
}

const templateFlow = {
  id: "flow-1",
  name: "模板流程",
  description: "",
  tags: [],
  steps: 2,
  definition: [
    { id: "step-1", title: "打开", action: "打开", value: "https://example.com", timeout: 10, failurePolicy: "立即失败", status: "pending" },
    { id: "step-2", title: "文本断言", action: "文本断言", value: "hello", timeout: 10, failurePolicy: "立即失败", status: "pending", assertMatch: "contains" },
  ],
  lastStatus: "queued",
  updatedAt: "2026-01-01T00:00:00.000Z",
  // 模板扩展字段（W2-4）：variables / secretNames / 未知顶层键。
  variables: { "var-1": "v1" },
  secretNames: ["secret-1"],
  customMetadata: { template: "tpl-1" },
};

beforeEach(() => {
  localStorage.clear();
  resetStore();
  seedSession();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ServerWorkspaceSynchronizer", () => {
  it("每 30s 轮询拉取远端项目变更并合并进本地", async () => {
    seedPlatformServer({ projectId: "project-1", workspaceId, name: "旧项目名" });

    const view = renderSynchronizer();
    await waitForState(
      () => useWorkspaceStore.getState().projects.find((p) => p.id === "project-1")?.name === "旧项目名",
      "初次加载未完成",
    );

    // 远端改名；30s 轮询后本地应看到新名（无需本地编辑）。
    updatePlatformProjectMeta("project-1", { name: "新项目名" });
    await vi.advanceTimersByTimeAsync(30_500);
    await waitForState(
      () => useWorkspaceStore.getState().projects.find((p) => p.id === "project-1")?.name === "新项目名",
      "30s 轮询未拉到远端改名",
    );

    view.unmount();
  });

  it("并发加载多项目后刷新合并：只更新被远端改动的项目，其余保持", async () => {
    seedPlatformServer([
      {
        projectId: "project-1",
        workspaceId,
        name: "项目一",
        resources: { flows: [{ ...templateFlow, id: "flow-1", name: "F1" }] },
      },
      {
        projectId: "project-2",
        workspaceId,
        name: "项目二",
        resources: { flows: [{ ...templateFlow, id: "flow-2", name: "F2" }] },
      },
    ]);

    const view = renderSynchronizer();
    await waitForState(
      () => {
        const flows = useWorkspaceStore.getState().flowsByProject;
        return flows["project-1"]?.[0]?.name === "F1" && flows["project-2"]?.[0]?.name === "F2";
      },
      "两个项目并发加载未合并完成",
    );

    // 只改远端项目一；30s 后项目一更新、项目二原样（合并非互相覆盖）。
    updatePlatformResourceData("project-1", "flows", "flow-1", { name: "F1-改" });
    await vi.advanceTimersByTimeAsync(30_500);
    await waitForState(
      () => {
        const flows = useWorkspaceStore.getState().flowsByProject;
        return flows["project-1"]?.[0]?.name === "F1-改" && flows["project-2"]?.[0]?.name === "F2";
      },
      "刷新合并未按项目正确应用",
    );

    view.unmount();
  });

  it("编辑后整体 PUT 不丢模板扩展字段（variables / secretNames / 未知键透传）", async () => {
    seedPlatformServer({
      projectId: "project-1",
      workspaceId,
      name: "测试项目",
      resources: {
        flows: [templateFlow],
        environments: [{ id: "env-1", name: "测试环境" }],
      },
    });

    const view = renderSynchronizer();
    await waitForState(
      () => useWorkspaceStore.getState().flowsByProject["project-1"]?.[0]?.id === "flow-1",
      "流程加载未完成",
    );
    // 等 hydration 微任务完成（store 订阅此时才开始响应编辑）。
    await vi.advanceTimersByTimeAsync(0);

    const current = useWorkspaceStore.getState().flowsByProject["project-1"][0];
    const edited = {
      ...current,
      name: "已编辑流程",
      definition: [
        ...(current.definition ?? []),
        { id: "step-3", title: "点击", action: "点击", value: "#btn", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      ],
    };
    useWorkspaceStore.getState().setFlows("project-1", [edited]);

    // 450ms 去抖后 syncProject 整体 PUT；扩展字段必须随整个 flow 对象回写。
    await vi.advanceTimersByTimeAsync(600);
    await waitForState(
      () => platformCapturedUpdates().some((item) => item.type === "flows" && item.id === "flow-1"),
      "编辑后未触发资源 PUT",
    );

    const update = platformCapturedUpdates().find((item) => item.type === "flows" && item.id === "flow-1");
    expect(update).toBeDefined();
    expect(update!.data.name).toBe("已编辑流程");
    expect(update!.data.variables).toEqual({ "var-1": "v1" });
    expect(update!.data.secretNames).toEqual(["secret-1"]);
    expect(update!.data.customMetadata).toEqual({ template: "tpl-1" });

    // 保存即快照：资源同步完成后自动发布版本（有步骤的流程才创建）。
    await vi.advanceTimersByTimeAsync(600);
    await waitForState(
      () => platformRevisionCount() > 0,
      "资源同步后未自动创建版本快照",
    );

    view.unmount();
  });
});
