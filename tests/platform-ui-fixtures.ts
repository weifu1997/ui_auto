import type { Page } from "@playwright/test";

export type PlatformUiCalls = {
  revisions: Record<string, unknown>[];
  secrets: Record<string, unknown>[];
  runs: Record<string, unknown>[];
};

type FixtureRevision = {
  id: string;
  response: Record<string, unknown>;
  flow: Record<string, unknown>;
  environment: Record<string, unknown>;
  elements: unknown[];
};

const session = {
  token: "platform-ui-token",
  user: { id: "platform-ui-user", email: "platform-ui@example.test", name: "Platform UI user" },
  workspaces: [{ id: "platform-ui-workspace", name: "Platform UI workspace", role: "owner" }],
};

// These routes validate UI request composition only. They do not execute a browser flow.
export async function configurePlatformRunUiMocks(page: Page, localProjectId: string, platformProjectId = `platform-${localProjectId}`) {
  const calls: PlatformUiCalls = { revisions: [], secrets: [], runs: [] };
  const runs: Array<Record<string, unknown>> = [];

  await page.evaluate(({ value, localId, remoteId }) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value));
    localStorage.setItem("autoflow-platform-workspace", value.workspaces[0].id);
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ [value.workspaces[0].id]: { [localId]: remoteId } }));
  }, { value: session, localId: localProjectId, remoteId: platformProjectId });

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

  await page.route(`**/api/platform/projects/${platformProjectId}/agent-bindings`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        bindings: revisions.slice(0, 1).map((revision) => ({
          environmentId: revision.environment.id,
          agent: {
            id: "platform-ui-agent",
            name: "Platform UI Agent",
            status: "online",
            browserVersion: "Chromium",
            lastSeenAt: "2030-01-01T00:00:00.000Z",
          },
        })),
      }),
    });
  });

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
      await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ error: "RUN_MUST_NOT_CREATE_OR_PUBLISH_A_REVISION" }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ revisions: revisions.map((revision) => revision.response) }) });
  });

  await page.route(`**/api/platform/projects/${platformProjectId}/runs**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/runs")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.runs.push(body);
      const revision = revisionById.get(String(body.revisionId));
      if (!revision) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "PUBLISHED_REVISION_REQUIRED" }) });
        return;
      }
      const flow = revision.flow as { steps?: Array<Record<string, unknown>> };
      const run = {
        id: `platform-run-${calls.runs.length}`,
        projectId: platformProjectId,
        revisionId: body.revisionId,
        environmentId: body.environmentId,
        agentId: "platform-ui-agent",
        status: "success",
        snapshot: { flow: revision.flow, environment: revision.environment, elements: revision.elements },
        cancellationRequested: false,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:01.000Z",
        lease: { id: "lease-ui", runId: `platform-run-${calls.runs.length}`, agentId: "platform-ui-agent", status: "completed", expiresAt: "2030-01-01T00:01:00.000Z", attempt: 1, expired: false },
        artifacts: [{ id: "trace-ui", name: "trace.zip", contentType: "application/zip", createdAt: "2030-01-01T00:00:01.000Z" }],
        events: (flow?.steps ?? []).map((step, index) => ({ id: index + 1, kind: "step.completed", data: { index, title: step.title ?? "Step", durationMs: 100 }, at: "2030-01-01T00:00:01.000Z" })),
        flowOutputs: [],
      };
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

  return calls;
}
