import type { Page } from "@playwright/test";

export type PlatformUiCalls = {
  revisions: Record<string, unknown>[];
  secrets: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  retryRunIds?: string[];
  createdRuns?: Record<string, unknown>[];
  batches: Record<string, unknown>[];
};

export type RecordingUiCalls = {
  sessions: Record<string, unknown>[];
  validations: Record<string, unknown>[];
  eventCursors: number[];
};

type FixtureRevision = {
  id: string;
  response: Record<string, unknown>;
  flow: Record<string, unknown>;
  environment: Record<string, unknown>;
  elements: unknown[];
};

type MockRun = {
  id: string;
  projectId: string;
  revisionId: string;
  environmentId: unknown;
  agentId: string;
  status: string;
  snapshot: Record<string, unknown>;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
  artifacts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  flowOutputs: Array<Record<string, unknown>>;
  retryOfRunId?: string | null;
};

type MockBatch = {
  id: string;
  clientRequestId: string;
  environmentId: string;
  flowIds: string[];
  childRunIds: string[];
  cancellationRequested: boolean;
  retryOfBatchId: string | null;
};

type PlatformRunUiMockOptions = {
  batchRunStatus?: "queued" | "running" | "success" | "failed" | "canceled";
};

const session = {
  token: "platform-ui-token",
  user: { id: "platform-ui-user", email: "platform-ui@example.test", name: "Platform UI user" },
  workspaces: [{ id: "platform-ui-workspace", name: "Platform UI workspace", role: "owner" }],
};

async function configurePlatformSession(
  page: Page,
  localProjectId: string,
  platformProjectId: string,
) {
  await page.evaluate(({ value, localId, remoteId }) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value));
    localStorage.setItem("autoflow-platform-workspace", value.workspaces[0].id);
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ [value.workspaces[0].id]: { [localId]: remoteId } }));
  }, { value: session, localId: localProjectId, remoteId: platformProjectId });
}

// These routes validate UI request composition only. They do not execute a browser flow.
export async function configurePlatformRunUiMocks(
  page: Page,
  localProjectId: string,
  { batchRunStatus = "success" }: PlatformRunUiMockOptions = {},
) {
  const platformProjectId = localProjectId;
  const calls: PlatformUiCalls = { revisions: [], secrets: [], runs: [], batches: [] };
  const runs: MockRun[] = [];

  await configurePlatformSession(page, localProjectId, platformProjectId);

  const revisions = await page.evaluate((localId) => {
    const persisted = JSON.parse(localStorage.getItem("autoflow-workspace-projects") ?? "{}") as { state?: Record<string, unknown> };
    const state = persisted.state ?? {};
    const flows = Array.isArray((state.flowsByProject as Record<string, unknown[] | undefined> | undefined)?.[localId])
      ? (state.flowsByProject as Record<string, Array<Record<string, unknown>>>)[localId]
      : [];
    const environments = Array.isArray((state.environmentsByProject as Record<string, unknown[] | undefined> | undefined)?.[localId])
      ? (state.environmentsByProject as Record<string, Array<Record<string, unknown>>>)[localId]
      : [];
    const activeEnvironmentId = (state.activeEnvironmentByProject as Record<string, string | undefined> | undefined)?.[localId];
    const environment = environments.find((item) => item.id === activeEnvironmentId) ?? environments[0];
    const elements = Array.isArray((state.elementsByProject as Record<string, unknown[] | undefined> | undefined)?.[localId])
      ? (state.elementsByProject as Record<string, unknown[]>)[localId]
      : [];
    const variables = Array.isArray((state.variablesByProject as Record<string, unknown[] | undefined> | undefined)?.[localId])
      ? (state.variablesByProject as Record<string, Array<Record<string, unknown>>>)[localId]
      : [];
    if (!environment) return [];
    return flows.map((flow, index) => {
      const values = Object.fromEntries(
        variables.flatMap((variable) => (
          !variable.secret && (variable.scope === "项目" || variable.scope === "环境") && typeof variable.name === "string"
            ? [[`${variable.scope === "环境" ? "env" : "project"}.${variable.name}`, variable.value ?? ""]]
            : []
        )),
      );
      const definition = Array.isArray(flow.definition) ? flow.definition : [];
      return {
        id: `revision-ui-${String(flow.id ?? index)}`,
        response: {
          id: `revision-ui-${String(flow.id ?? index)}`,
          flowId: flow.id,
          flowName: flow.name,
          revisionNumber: index + 1,
          status: "published",
          checksum: "ui-checksum",
          createdBy: "platform-ui-user",
          createdAt: "2030-01-01T00:00:00.000Z",
          publishedAt: "2030-01-01T00:00:00.000Z",
          environmentId: environment.id,
          stepCount: definition.length,
        },
        flow: { ...flow, steps: definition, variables: values },
        environment,
        elements,
      };
    });
  }, localProjectId) as FixtureRevision[];
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
  const workspaceSeed = await page.evaluate((localId) => {
    const persisted = JSON.parse(localStorage.getItem("autoflow-workspace-projects") ?? "{}") as { state?: Record<string, unknown> };
    const state = persisted.state ?? {};
    const collections = <T>(key: string) => {
      const value = (state[key] as Record<string, T[] | undefined> | undefined)?.[localId];
      return Array.isArray(value) ? value : [];
    };
    return {
      project: ((state.projects as Array<Record<string, unknown>> | undefined) ?? []).find((item) => item.id === localId),
      flows: collections<Record<string, unknown>>("flowsByProject"),
      elements: collections<Record<string, unknown>>("elementsByProject"),
      variables: collections<Record<string, unknown>>("variablesByProject"),
      environments: collections<Record<string, unknown>>("environmentsByProject"),
      activeEnvironmentId: (state.activeEnvironmentByProject as Record<string, string | undefined> | undefined)?.[localId] ?? "",
    };
  }, localProjectId);
  const platformResourceResponse = (items: Array<Record<string, unknown>>) => ({
    resources: items.map((data) => ({
      id: String(data.id),
      data,
      version: 1,
      archivedAt: null,
      updatedAt: "2030-01-01T00:00:00.000Z",
      updatedBy: "platform-ui-user",
    })),
  });

  await page.route(`**/api/workspaces/${session.workspaces[0].id}/projects`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      projects: [{
        id: platformProjectId,
        workspaceId: session.workspaces[0].id,
        slug: platformProjectId,
        name: typeof workspaceSeed.project?.name === "string" ? workspaceSeed.project.name : platformProjectId,
        description: typeof workspaceSeed.project?.description === "string" ? workspaceSeed.project.description : "",
        archivedAt: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route(`**/api/platform/projects/${platformProjectId}/resources/**`, (route) => {
    const type = new URL(route.request().url()).pathname.split("/").at(-1);
    const items = type === "flows" ? workspaceSeed.flows
      : type === "elements" ? workspaceSeed.elements
        : type === "variables" ? workspaceSeed.variables
          : type === "environments" ? workspaceSeed.environments : [];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(platformResourceResponse(items)) });
  });
  await page.route(`**/api/platform/projects/${platformProjectId}/settings`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ settings: { data: { activeEnvironmentId: workspaceSeed.activeEnvironmentId }, version: 1 } }),
  }));

  await page.route(`**/api/platform/projects/${platformProjectId}/secrets`, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.secrets.push(body);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ secret: { id: `secret-${calls.secrets.length}`, name: body.name, keyVersion: 1 } }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ secrets: [] }) });
  });

  await page.route(`**/api/platform/projects/${platformProjectId}/revisions**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.revisions.push(body);
      // 保存即快照：返回新建的 published 版本（测试不校验幂等，每次都返回新版本）。
      const flow = body.flow as Record<string, unknown> | undefined;
      const environment = body.environment as Record<string, unknown> | undefined;
      const saved = {
        id: `revision-saved-${calls.revisions.length}`,
        flowId: typeof flow?.id === "string" ? flow.id : undefined,
        flowName: typeof flow?.name === "string" ? flow.name : undefined,
        revisionNumber: revisions.length + calls.revisions.length,
        status: "published",
        checksum: `ui-checksum-${calls.revisions.length}`,
        createdBy: "platform-ui-user",
        createdAt: "2030-01-01T00:00:00.000Z",
        publishedAt: "2030-01-01T00:00:00.000Z",
        environmentId: typeof environment?.id === "string" ? environment.id : undefined,
        stepCount: Array.isArray(flow?.steps) ? (flow.steps as unknown[]).length : 0,
      };
      revisions.push({ id: saved.id, response: saved, flow: flow ?? {}, environment: environment ?? {}, elements: Array.isArray(body.elements) ? body.elements : [] });
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ revision: saved }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ revisions: revisions.map((revision) => revision.response) }) });
  });

  const resolveRevision = (body: Record<string, unknown>) => {
    const flowId = typeof body.flowId === "string" ? body.flowId : undefined;
    return body.revisionId
      ? revisionById.get(String(body.revisionId))
      : flowId
        ? revisions.find((revision) => revision.flow.id === flowId)
        : revisions[0];
  };
  const buildRun = (
    revision: FixtureRevision,
    environmentId: unknown,
    runKey: string,
    status = "success",
  ): MockRun => {
    const flow = revision.flow as { steps?: Array<Record<string, unknown>> };
    return {
      id: `platform-run-${runKey}`,
      projectId: platformProjectId,
      revisionId: revision.id,
      environmentId,
      agentId: "platform-ui-agent",
      status,
      snapshot: { flow: revision.flow, environment: revision.environment, elements: revision.elements },
      cancellationRequested: false,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:01.000Z",
      artifacts: [{ id: "trace-ui", name: "trace.zip", contentType: "application/zip", createdAt: "2030-01-01T00:00:01.000Z" }],
      events: (flow?.steps ?? []).map((step, index) => ({ id: index + 1, kind: "step.completed", data: { index, title: step.title ?? "Step", durationMs: 100 }, at: "2030-01-01T00:00:01.000Z" })),
      flowOutputs: [],
    };
  };

  await page.route(`**/api/platform/projects/${platformProjectId}/runs**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/runs")) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.runs.push(body);
      // 运行按 flowId 解析该流程最新 published 版本，与服务端 flow-scoped resolver 契约一致。
      const revision = resolveRevision(body);
      if (!revision) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "PUBLISHED_REVISION_REQUIRED" }) });
        return;
      }
      const run = buildRun(revision, body.environmentId, String(calls.runs.length));
      runs.unshift(run);
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run, runs: [run], runIds: [run.id] }) });
      return;
    }
    if (request.method() === "GET" && /\/runs\/[^/]+$/.test(url.pathname)) {
      const runId = url.pathname.split("/").at(-1);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ run: runs.find((item) => item.id === runId) }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runs }) });
  });

  const batches: MockBatch[] = [];
  const batchCounts = (batch: MockBatch) => {
    const children = runs.filter((run) => batch.childRunIds.includes(run.id));
    const byStatus = (status: string) => children.filter((run) => run.status === status).length;
    const total = children.length;
    const completed = byStatus("success") + byStatus("failed") + byStatus("canceled");
    const status = byStatus("queued") === total && total > 0 ? "queued"
      : byStatus("running") > 0 || (byStatus("queued") > 0 && completed > 0) ? "running"
        : byStatus("success") === total ? "success"
          : byStatus("canceled") === total ? "canceled"
            : completed === total && byStatus("success") > 0 ? "partial_failed"
              : completed === total && byStatus("failed") > 0 ? "failed" : "queued";
    return {
      status,
      counts: {
        total,
        queued: byStatus("queued"),
        running: byStatus("running"),
        success: byStatus("success"),
        failed: byStatus("failed"),
        canceled: byStatus("canceled"),
        completed,
      },
    };
  };
  const batchResponse = (batch: MockBatch) => ({
    id: batch.id,
    projectId: platformProjectId,
    environmentId: batch.environmentId,
    clientRequestId: batch.clientRequestId,
    source: "manual",
    retryOfBatchId: batch.retryOfBatchId,
    flowIds: batch.flowIds,
    cancellationRequested: Boolean(batch.cancellationRequested),
    createdBy: "platform-ui-user",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:01.000Z",
    ...batchCounts(batch),
  });
  const batchRunSummaries = (batch: MockBatch) =>
    runs
      .filter((run) => batch.childRunIds.includes(run.id))
      .map((run) => ({
        id: run.id,
        status: run.status,
        revisionId: run.revisionId,
        environmentId: run.environmentId,
        flowName: (run.snapshot as { flow?: { name?: string } }).flow?.name ?? null,
        cancellationRequested: run.cancellationRequested,
        retryOfRunId: null,
        batchItemIndex: batch.childRunIds.indexOf(run.id),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }));

  await page.route(`**/api/platform/projects/${platformProjectId}/run-batches**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/run-batches")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.batches.push(body);
      const flowIds = Array.isArray(body.flowIds) ? body.flowIds.map(String) : [];
      const clientRequestId = String(body.clientRequestId ?? "");
      const environmentId = String(body.environmentId ?? "");
      const existing = batches.find((batch) => batch.clientRequestId === clientRequestId);
      if (existing) {
        if (existing.environmentId !== environmentId || existing.flowIds.join("|") !== flowIds.join("|")) {
          await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "IDEMPOTENCY_KEY_REUSED" }) });
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ batch: batchResponse(existing), runs: batchRunSummaries(existing) }) });
        return;
      }
      const specs = flowIds.map((flowId) => revisions.find((revision) => revision.flow.id === flowId));
      if (specs.some((spec) => !spec) || flowIds.length < 2) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "BATCH_PREFLIGHT_FAILED",
            items: specs.map((spec, index) => ({ flowId: flowIds[index], code: spec ? "FLOW_HAS_NO_STEPS" : "PUBLISHED_REVISION_REQUIRED" })),
          }),
        });
        return;
      }
      const batch: MockBatch = {
        id: `platform-batch-${batches.length + 1}`,
        clientRequestId,
        environmentId,
        flowIds,
        childRunIds: [],
        cancellationRequested: false,
        retryOfBatchId: null,
      };
      specs.forEach((spec) => {
        const run = buildRun(
          spec as FixtureRevision,
          environmentId,
          `batch-${batches.length + 1}-${batch.childRunIds.length}`,
          batchRunStatus,
        );
        runs.unshift(run);
        batch.childRunIds.push(run.id);
      });
      batches.unshift(batch);
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ batch: batchResponse(batch), runs: batchRunSummaries(batch) }) });
      return;
    }
    const batchMatch = /\/run-batches\/([^/?]+)$/.exec(url.pathname);
    if (request.method() === "GET" && batchMatch) {
      const batch = batches.find((item) => item.id === batchMatch[1]);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ batch: batch ? batchResponse(batch) : null, runs: batch ? batchRunSummaries(batch) : [] }) });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/cancel")) {
      const batchId = url.pathname.split("/").at(-2);
      const batch = batches.find((item) => item.id === batchId);
      if (batch) {
        batch.cancellationRequested = true;
        for (const run of runs.filter((item) => batch.childRunIds.includes(item.id))) {
          if (run.status === "queued") run.status = "canceled";
          else if (run.status === "running") run.cancellationRequested = true;
        }
      }
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ batch: batch ? batchResponse(batch) : null, runs: batch ? batchRunSummaries(batch) : [] }) });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/retry-failed")) {
      const batchId = url.pathname.split("/").at(-2);
      const source = batches.find((item) => item.id === batchId);
      const retryItems = source
        ? runs.filter((item) => source.childRunIds.includes(item.id) && (item.status === "failed" || item.status === "canceled"))
        : [];
      if (!source || retryItems.length === 0) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "BATCH_NOT_RETRYABLE" }) });
        return;
      }
      const retry: MockBatch = {
        id: `platform-batch-${batches.length + 1}`,
        clientRequestId: String((request.postDataJSON() as Record<string, unknown>).clientRequestId ?? ""),
        environmentId: source.environmentId,
        flowIds: retryItems.map((run) => String((run.snapshot as { flow?: { id?: string } }).flow?.id ?? run.revisionId)),
        childRunIds: [],
        cancellationRequested: false,
        retryOfBatchId: source.id,
      };
      retryItems.forEach((prior) => {
        const revision = revisionById.get(String(prior.revisionId)) ?? revisions[0];
        const run = buildRun(
          revision,
          source.environmentId,
          `batch-${batches.length + 1}-${retry.childRunIds.length}`,
          batchRunStatus,
        );
        runs.unshift(run);
        retry.childRunIds.push(run.id);
      });
      batches.unshift(retry);
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ batch: batchResponse(retry), runs: batchRunSummaries(retry) }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ batches: batches.map(batchResponse), total: batches.length, page: 1, pageSize: 20 }) });
  });

  return calls;
}

// This fixture models the retry boundary with two published revisions of the same flow.
// It intentionally keeps the old A snapshots after B becomes current so UI tests can
// prove fresh-runs resolve B while retries clone A exactly once.
export async function configureRetryReproductionUiMocks(page: Page, localProjectId: string) {
  const platformProjectId = localProjectId;
  const calls: PlatformUiCalls = {
    revisions: [],
    secrets: [],
    runs: [],
    retryRunIds: [],
    createdRuns: [],
    batches: [],
  };
  await configurePlatformSession(page, localProjectId, platformProjectId);

  const source = await page.evaluate((localId) => {
    const persisted = JSON.parse(localStorage.getItem("autoflow-workspace-projects") ?? "{}") as { state?: Record<string, unknown> };
    const state = persisted.state ?? {};
    const flows = Array.isArray((state.flowsByProject as Record<string, unknown[] | undefined> | undefined)?.[localId])
      ? (state.flowsByProject as Record<string, Array<Record<string, unknown>>>)[localId]
      : [];
    const environments = Array.isArray((state.environmentsByProject as Record<string, unknown[] | undefined> | undefined)?.[localId])
      ? (state.environmentsByProject as Record<string, Array<Record<string, unknown>>>)[localId]
      : [];
    const activeEnvironmentId = (state.activeEnvironmentByProject as Record<string, string | undefined> | undefined)?.[localId];
    return {
      flow: flows[0],
      environment: environments.find((item) => item.id === activeEnvironmentId) ?? environments[0],
      elements: Array.isArray((state.elementsByProject as Record<string, unknown[] | undefined> | undefined)?.[localId])
        ? (state.elementsByProject as Record<string, unknown[]>)[localId]
        : [],
    };
  }, localProjectId) as { flow?: Record<string, unknown>; environment?: Record<string, unknown>; elements: unknown[] };
  if (!source.flow || !source.environment || typeof source.flow.id !== "string" || typeof source.environment.id !== "string") {
    throw new Error("retry reproduction fixture requires one flow and one environment");
  }

  const baseFlow = {
    ...source.flow,
    name: "重现流程",
    steps: Array.isArray(source.flow.definition) ? source.flow.definition : [],
  };
  const revisionA = {
    id: "revision-retry-a",
    checksum: "checksum-retry-a",
    response: {
      id: "revision-retry-a",
      flowId: source.flow.id,
      flowName: "重现流程",
      revisionNumber: 1,
      status: "superseded",
      checksum: "checksum-retry-a",
      createdBy: "platform-ui-user",
      createdAt: "2030-01-01T00:00:00.000Z",
      publishedAt: "2030-01-01T00:00:00.000Z",
      environmentId: source.environment.id,
      stepCount: baseFlow.steps.length,
    },
    flow: baseFlow,
  };
  const revisionB = {
    id: "revision-retry-b",
    checksum: "checksum-retry-b",
    response: {
      id: "revision-retry-b",
      flowId: source.flow.id,
      flowName: "重现流程",
      revisionNumber: 2,
      status: "published",
      checksum: "checksum-retry-b",
      createdBy: "platform-ui-user",
      createdAt: "2030-01-02T00:00:00.000Z",
      publishedAt: "2030-01-02T00:00:00.000Z",
      environmentId: source.environment.id,
      stepCount: baseFlow.steps.length,
    },
    flow: baseFlow,
    rows: [
      { number: 1, data: { account: "current-1" } },
      { number: 2, data: { account: "current-2" } },
    ],
  };
  const makeRun = (
    id: string,
    revision: typeof revisionA | typeof revisionB,
    status: string,
    options: { retryOfRunId?: string | null; flow?: Record<string, unknown>; row?: Record<string, unknown> } = {},
  ): MockRun => ({
    id,
    projectId: platformProjectId,
    revisionId: revision.id,
    environmentId: source.environment!.id,
    agentId: "platform-ui-agent",
    status,
    snapshot: {
      flow: options.flow ?? revision.flow,
      environment: source.environment,
      elements: source.elements,
      flowRevisionChecksum: revision.checksum,
      datasetVersion: revision.id === revisionB.id ? { id: "dataset-version-b", checksum: "dataset-checksum-b" } : { id: "dataset-version-a", checksum: "dataset-checksum-a" },
      datasetRow: options.row ?? null,
    },
    cancellationRequested: false,
    retryOfRunId: options.retryOfRunId ?? null,
    createdAt: "2030-01-03T00:00:00.000Z",
    updatedAt: "2030-01-03T00:00:01.000Z",
    artifacts: [],
    events: status === "success" ? [{ id: 1, kind: "step.completed", data: { index: 0, title: "打开页面", durationMs: 100 }, at: "2030-01-03T00:00:01.000Z" }] : [],
    flowOutputs: [],
  });
  const sourceSuccess = makeRun("source-success-a", revisionA, "success", { row: { number: 1, data: { account: "historical-a" } } });
  const sourceFailed = makeRun("source-failed-a", revisionA, "failed", { row: { number: 2, data: { account: "historical-failed-a" } } });
  const active = makeRun("source-running-a", revisionA, "running");
  const missingFlow = makeRun("source-missing-flow", revisionA, "success", { flow: { name: "缺少流程标识" } });
  const noPublished = makeRun("source-no-published", revisionA, "success", { flow: { ...baseFlow, id: "flow-without-published" } });
  const runs: MockRun[] = [sourceSuccess, sourceFailed, active, missingFlow, noPublished];

  await page.route(`**/api/platform/projects/${platformProjectId}/revisions**`, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ revisions: [revisionB.response, revisionA.response] }) });
  });
  await page.route(`**/api/platform/projects/${platformProjectId}/run-batches**`, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ batches: [], total: 0, page: 1, pageSize: 20 }) });
  });
  await page.route(`**/api/platform/projects/${platformProjectId}/runs**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const retryMatch = /\/runs\/([^/]+)\/retry$/.exec(url.pathname);
    if (request.method() === "POST" && retryMatch) {
      const prior = runs.find((run) => run.id === retryMatch[1]);
      calls.retryRunIds!.push(retryMatch[1]);
      if (!prior || (prior.status !== "failed" && prior.status !== "canceled")) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "RUN_NOT_RETRYABLE" }) });
        return;
      }
      const clone = makeRun("retry-failed-a", revisionA, "queued", {
        retryOfRunId: prior.id,
        row: (prior.snapshot.datasetRow as Record<string, unknown> | null) ?? undefined,
      });
      runs.unshift(clone);
      calls.createdRuns!.push(clone);
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ runIds: [clone.id], runs: [clone] }) });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/runs")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.runs.push(body);
      if (body.flowId !== source.flow!.id || Object.hasOwn(body, "revisionId")) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "PUBLISHED_REVISION_REQUIRED" }) });
        return;
      }
      const freshRuns = revisionB.rows.map((row) => makeRun(
        `fresh-b-${row.number}`,
        revisionB,
        "queued",
        { row },
      ));
      runs.unshift(...freshRuns);
      calls.createdRuns!.push(...freshRuns);
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ runIds: freshRuns.map((run) => run.id), runs: freshRuns }) });
      return;
    }
    if (request.method() === "GET" && /\/runs\/[^/]+$/.test(url.pathname)) {
      const runId = url.pathname.split("/").at(-1);
      const run = runs.find((item) => item.id === runId);
      await route.fulfill({ status: run ? 200 : 404, contentType: "application/json", body: JSON.stringify({ run }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runs, total: runs.length, page: 1, pageSize: 8 }) });
  });

  return calls;
}

export async function configurePlatformRecordingUiMocks(
  page: Page,
  localProjectId: string,
  platformProjectId = localProjectId,
) {
  const calls: RecordingUiCalls = { sessions: [], validations: [], eventCursors: [] };
  await configurePlatformSession(page, localProjectId, platformProjectId);

  const sessionState = {
    id: "recording-session-1",
    projectId: platformProjectId,
    flowId: "",
    environmentId: "",
    status: "recording",
    currentUrl: "https://default.example.test/login",
    lastSeq: 101,
    recordedStepCount: 2,
    startedAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
  };
  const events = Array.from({ length: 101 }, (_, index) => ({
    seq: index + 1,
    kind: "click",
    url: "https://default.example.test/login",
  }));
  const result = {
    steps: [
      { id: "recording-open", title: "录制打开页面", action: "打开页面", value: "/login" },
      { id: "recording-click", title: "录制点击登录", action: "点击", element: "录制登录按钮" },
    ],
    elements: [
      {
        id: "recording-login-button",
        name: "录制登录按钮",
        path: "/login",
        method: "testid",
        value: "login-submit",
      },
    ],
    requiredBindings: [],
    warnings: ["检测到不支持的 iframe 行为，未生成可执行步骤"],
    lastSeq: 101,
  };

  await page.route(`**/api/platform/projects/${platformProjectId}/recording-sessions**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/recording-sessions")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.sessions.push(body);
      sessionState.flowId = String(body.flowId ?? "");
      sessionState.environmentId = String(body.environmentId ?? "");
      sessionState.currentUrl = String(body.startUrl ?? sessionState.currentUrl).replace(/[?#].*$/, "");
      sessionState.status = "recording";
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: { ...sessionState, lastSeq: 0 } }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/events")) {
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
      calls.eventCursors.push(afterSeq);
      const pageEvents = events.filter((event) => event.seq > afterSeq).slice(0, 100);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events: pageEvents,
          lastSeq: sessionState.lastSeq,
          hasMore: events.some((event) => event.seq > (pageEvents.at(-1)?.seq ?? afterSeq)),
        }),
      });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/pause")) {
      sessionState.status = "paused";
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: sessionState }) });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/resume")) {
      sessionState.status = "recording";
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: sessionState }) });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/stop")) {
      sessionState.status = "stopped";
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: sessionState, result }) });
      return;
    }
    if (request.method() === "DELETE") {
      sessionState.status = "canceled";
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: sessionState }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ session: sessionState }) });
  });

  await page.route(`**/api/platform/projects/${platformProjectId}/element-validations**`, async (route) => {
    if (route.request().method() === "POST") {
      calls.validations.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ validation: { id: "recording-validation-1", status: "success", result: { count: 1 } } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        validation: { id: "recording-validation-1", status: "success", result: { count: 1 } },
      }),
    });
  });

  return calls;
}
