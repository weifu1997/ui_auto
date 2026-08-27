// MSW 平台后端内存实现（阶段1-E）。
//
// 与 `src/api/platform-api.ts` 的端点/响应形状对齐，供 vitest 组件测试走真实 fetch
// 管线（不再手写 `vi.mock("../api/platform-api")`）。工作区同步端点（projects /
// resources / settings / revisions）是带版本的有状态实现，能驱动
// `ServerWorkspaceSynchronizer` 的创建/更新/归档/版本冲突路径；其余类别端点返回
// 最小占位形状，方便后续测试按需扩展。
//
// 使用方式：
//   import { platformHandlers, seedPlatformServer, resetPlatformServer } from "./server-handlers";
//   seedPlatformServer({ ... });   // 每个测试前铺数据
//   resetPlatformServer();         // afterEach 清空
import { http, HttpResponse } from "msw";

type StoredResource = {
  data: Record<string, unknown>;
  version: number;
  archivedAt: string | null;
};

type StoredProject = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformSeedInput = {
  projectId: string;
  workspaceId: string;
  name?: string;
  description?: string;
  resources?: Partial<
    Record<"flows" | "elements" | "variables" | "environments", Array<Record<string, unknown>>>
  >;
  settings?: Record<string, unknown>;
};

type PlatformTestStore = {
  workspaceId: string;
  projects: Record<string, StoredProject>;
  resources: Record<string, Record<string, StoredResource>>;
  settings: Record<string, { data: Record<string, unknown>; version: number }>;
  revisions: Array<Record<string, unknown>>;
  /** 每次资源 PUT 都记录 body，供测试断言「整体 PUT 不丢扩展字段」。 */
  capturedUpdates: Array<{
    projectId: string;
    type: string;
    id: string;
    data: Record<string, unknown>;
    expectedVersion: number;
  }>;
};

let store: PlatformTestStore = {
  workspaceId: "workspace-1",
  projects: {},
  resources: {},
  settings: {},
  revisions: [],
  capturedUpdates: [],
};

const resourceKey = (projectId: string, type: string) => `${projectId}:${type}`;

function projectShape(id: string, seed: { name?: string; description?: string }): StoredProject {
  return {
    id,
    workspaceId: store.workspaceId,
    slug: id,
    name: seed.name ?? id,
    description: seed.description ?? "",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function seedPlatformServer(input: PlatformSeedInput | PlatformSeedInput[]) {
  const inputs = Array.isArray(input) ? input : [input];
  for (const item of inputs) {
    const project = store.projects[item.projectId] ?? projectShape(item.projectId, item);
    store.projects[item.projectId] = project;
    store.settings[item.projectId] = {
      data: item.settings ?? {},
      version: store.settings[item.projectId]?.version ?? 1,
    };
    for (const type of ["flows", "elements", "variables", "environments"] as const) {
      const entries = item.resources?.[type];
      if (!entries) continue;
      const key = resourceKey(item.projectId, type);
      store.resources[key] = Object.fromEntries(
        entries.map((data) => {
          const id = typeof data.id === "string" ? data.id : `res-${Math.random().toString(36).slice(2)}`;
          return [id, { data, version: 1, archivedAt: null }];
        }),
      );
    }
  }
}

export function resetPlatformServer() {
  store = {
    workspaceId: "workspace-1",
    projects: {},
    resources: {},
    settings: {},
    revisions: [],
    capturedUpdates: [],
  };
}

/** 直接设置工作区 id，供与 localStorage 中的会话对齐。 */
export function setPlatformWorkspaceId(workspaceId: string) {
  store.workspaceId = workspaceId;
}

export function platformCapturedUpdates() {
  return store.capturedUpdates;
}

export function platformRevisionCount() {
  return store.revisions.length;
}

/** 模拟远端项目元数据变更（供轮询/合并测试观察下一次拉取）。 */
export function updatePlatformProjectMeta(projectId: string, patch: { name?: string; description?: string }) {
  const project = store.projects[projectId];
  if (!project) return;
  if (patch.name !== undefined) project.name = patch.name;
  if (patch.description !== undefined) project.description = patch.description;
}

/** 模拟远端资源数据变更（浅合并进 data，版本不变）。 */
export function updatePlatformResourceData(projectId: string, type: string, id: string, patch: Record<string, unknown>) {
  const resource = store.resources[resourceKey(projectId, type)]?.[id];
  if (!resource) return;
  resource.data = { ...resource.data, ...patch };
}

function resourceList(projectId: string, type: string) {
  const bucket = store.resources[resourceKey(projectId, type)] ?? {};
  return Object.entries(bucket)
    .filter(([, resource]) => resource.archivedAt === null)
    .map(([id, resource]) => ({
      id,
      data: resource.data,
      version: resource.version,
      archivedAt: resource.archivedAt,
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "test-agent",
    }));
}

function conflict() {
  return HttpResponse.json({ error: "RESOURCE_VERSION_CONFLICT" }, { status: 409 });
}

function alreadyExists() {
  return HttpResponse.json({ error: "RESOURCE_ALREADY_EXISTS" }, { status: 409 });
}

export const platformHandlers = [
  // ---- 工作区同步 ----
  http.get("/api/workspaces/:workspaceId/projects", () => {
    return HttpResponse.json({
      projects: Object.values(store.projects).map((project) => ({
        ...project,
        workspaceId: store.workspaceId,
      })),
    });
  }),

  http.get("/api/platform/projects/:projectId/resources/:type", ({ params }) => {
    const projectId = String(params.projectId);
    const type = String(params.type);
    return HttpResponse.json({ resources: resourceList(projectId, type) });
  }),

  http.post("/api/platform/projects/:projectId/resources/:type", async ({ params, request }) => {
    const projectId = String(params.projectId);
    const type = String(params.type);
    const body = (await request.json()) as { id: string; data: Record<string, unknown> };
    const key = resourceKey(projectId, type);
    const bucket = store.resources[key] ?? (store.resources[key] = {});
    if (bucket[body.id]) return alreadyExists();
    const resource: StoredResource = { data: body.data, version: 1, archivedAt: null };
    bucket[body.id] = resource;
    return HttpResponse.json({
      resource: {
        id: body.id,
        data: resource.data,
        version: resource.version,
        archivedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "test-agent",
      },
    });
  }),

  http.put("/api/platform/projects/:projectId/resources/:type/:id", async ({ params, request }) => {
    const projectId = String(params.projectId);
    const type = String(params.type);
    const id = String(params.id);
    const body = (await request.json()) as { data: Record<string, unknown>; expectedVersion: number };
    const existing = store.resources[resourceKey(projectId, type)]?.[id];
    if (!existing) return HttpResponse.json({ error: "RESOURCE_NOT_FOUND" }, { status: 404 });
    if (existing.version !== body.expectedVersion) return conflict();
    existing.data = body.data;
    existing.version += 1;
    store.capturedUpdates.push({ projectId, type, id, data: body.data, expectedVersion: body.expectedVersion });
    return HttpResponse.json({
      resource: {
        id,
        data: existing.data,
        version: existing.version,
        archivedAt: existing.archivedAt,
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "test-agent",
      },
    });
  }),

  http.delete("/api/platform/projects/:projectId/resources/:type/:id", ({ params, request }) => {
    const projectId = String(params.projectId);
    const type = String(params.type);
    const id = String(params.id);
    const url = new URL(request.url);
    const expectedVersion = Number(url.searchParams.get("expectedVersion"));
    const existing = store.resources[resourceKey(projectId, type)]?.[id];
    if (!existing) return HttpResponse.json({ error: "RESOURCE_NOT_FOUND" }, { status: 404 });
    if (existing.version !== expectedVersion) return conflict();
    existing.archivedAt = "2026-01-01T00:00:00.000Z";
    existing.version += 1;
    return HttpResponse.json({ id, archived: true, version: existing.version });
  }),

  http.get("/api/platform/projects/:projectId/settings", ({ params }) => {
    const projectId = String(params.projectId);
    const settings = store.settings[projectId] ?? { data: {}, version: 1 };
    return HttpResponse.json({
      settings: { data: settings.data, version: settings.version, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "test-agent" },
    });
  }),

  http.put("/api/platform/projects/:projectId/settings", async ({ params, request }) => {
    const projectId = String(params.projectId);
    const body = (await request.json()) as { data: Record<string, unknown>; expectedVersion: number };
    const current = store.settings[projectId] ?? { data: {}, version: 1 };
    if (current.version !== body.expectedVersion) return conflict();
    current.data = body.data;
    current.version += 1;
    store.settings[projectId] = current;
    return HttpResponse.json({
      settings: { data: current.data, version: current.version, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "test-agent" },
    });
  }),

  http.patch("/api/platform/projects/:projectId", async ({ params, request }) => {
    const projectId = String(params.projectId);
    const body = (await request.json()) as { name?: string; description?: string; archived?: boolean };
    const project = store.projects[projectId];
    if (!project) return HttpResponse.json({ error: "RESOURCE_NOT_FOUND" }, { status: 404 });
    if (body.name !== undefined) project.name = body.name;
    if (body.description !== undefined) project.description = body.description;
    project.updatedAt = "2026-01-01T00:00:00.000Z";
    return HttpResponse.json({ project });
  }),

  http.post("/api/platform/projects/:projectId/revisions", async ({ params, request }) => {
    const projectId = String(params.projectId);
    const body = (await request.json()) as { flow?: Record<string, unknown> };
    const revision = {
      id: `rev-${store.revisions.length + 1}`,
      flowId: typeof body.flow?.id === "string" ? body.flow.id : undefined,
      flowName: typeof body.flow?.name === "string" ? body.flow.name : undefined,
      revisionNumber: store.revisions.length + 1,
      status: "published",
      checksum: `checksum-${store.revisions.length + 1}`,
      createdBy: "test-agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      publishedAt: "2026-01-01T00:00:00.000Z",
      stepCount: Array.isArray(body.flow?.definition) ? body.flow.definition.length : 0,
      projectId,
    };
    store.revisions.push(revision);
    return HttpResponse.json({ revision });
  }),

  // ---- 占位形状：供后续组件测试按需扩展 ----
  http.get("/api/platform/projects/:projectId/secrets", () => HttpResponse.json({ secrets: [] })),
  http.get("/api/platform/projects/:projectId/runs", () => HttpResponse.json({ runs: [], total: 0 })),
  http.get("/api/platform/projects/:projectId/run-batches", () => HttpResponse.json({ batches: [], total: 0 })),
  http.get("/api/platform/projects/:projectId/run-batches/:batchId", () =>
    HttpResponse.json({
      batch: { id: "batch-1", status: "success", runs: [], totalRuns: 0 },
    }),
  ),
  http.get("/api/platform/projects/:projectId/assertion-stats", () =>
    HttpResponse.json({
      stats: { total: 0, passed: 0, failed: 0, flaky: 0, passRate: 1 },
    }),
  ),
  http.post("/api/platform/projects/:projectId/recording-sessions", ({ params }) =>
    HttpResponse.json({
      session: { id: "session-1", status: "recording", projectId: String(params.projectId), events: [] },
    }),
  ),
  http.get("/api/platform/projects/:projectId/recording-sessions/:sessionId", () =>
    HttpResponse.json({ session: { id: "session-1", status: "recording" } }),
  ),
  http.get("/api/platform/projects/:projectId/recording-sessions/:sessionId/events", () =>
    HttpResponse.json({ events: [] }),
  ),
  http.post("/api/platform/projects/:projectId/element-validations", () =>
    HttpResponse.json({
      validation: { id: "validation-1", status: "queued" },
    }),
  ),
  http.get("/api/platform/projects/:projectId/element-validations/:validationId", () =>
    HttpResponse.json({ validation: { id: "validation-1", status: "success" } }),
  ),
];
