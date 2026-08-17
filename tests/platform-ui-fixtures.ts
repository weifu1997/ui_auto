import type { Page } from "@playwright/test";

export type PlatformUiCalls = {
  revisions: Record<string, unknown>[];
  secrets: Record<string, unknown>[];
  runs: Record<string, unknown>[];
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
export async function configurePlatformRunUiMocks(page: Page, localProjectId: string, platformProjectId = `platform-${localProjectId}`) {
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
  const buildRun = (revision: FixtureRevision, environmentId: unknown, runKey: string): MockRun => {
    const flow = revision.flow as { steps?: Array<Record<string, unknown>> };
    return {
      id: `platform-run-${runKey}`,
      projectId: platformProjectId,
      revisionId: revision.id,
      environmentId,
      agentId: "platform-ui-agent",
      status: "success",
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
        const run = buildRun(spec as FixtureRevision, environmentId, `batch-${batches.length + 1}-${batch.childRunIds.length}`);
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
        const run = buildRun(revision, source.environmentId, `batch-${batches.length + 1}-${retry.childRunIds.length}`);
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

export async function configurePlatformRecordingUiMocks(
  page: Page,
  localProjectId: string,
  platformProjectId = `platform-${localProjectId}`,
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
