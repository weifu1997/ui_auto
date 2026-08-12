import { createHmac } from "node:crypto";
import { removeWorkerRoot, startWorker, stopWorker, type TestWorker } from "./worker-test-utils.ts";

const port = 8795;
let worker: TestWorker | undefined;
let root: string | undefined;

type ApiResponse<T> = { response: Response; body: T };

async function api<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { response, body: (await response.json()) as T };
}

async function waitForRun(token: string, projectId: string, runId: string, statuses: string[]) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await api<{ run: { status: string; executorType: string; artifacts: Array<{ id: string; name: string }> } }>(`/api/platform/projects/${projectId}/runs/${runId}`, { headers: headers(token) });
    if (statuses.includes(response.body.run.status)) return response.body.run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Managed run ${runId} did not reach ${statuses.join(", ")}`);
}

function headers(token: string) {
  return { authorization: `Bearer ${token}` };
}

try {
  worker = await startWorker({
    port,
    env: {
      AUTOFLOW_LISTEN_HOST: "0.0.0.0",
      AUTOFLOW_CORS_ORIGINS: "http://console.example.test",
      PLATFORM_SECRET_KEY: "platform-contract-smoke-secret",
      MANAGED_RUNNER_HEADLESS: "1",
    },
  });
  root = worker.root;

  const corsPreflight = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
    method: "OPTIONS",
    headers: {
      origin: "http://console.example.test",
      "access-control-request-method": "GET",
    },
  });
  if (corsPreflight.status !== 204 || corsPreflight.headers.get("access-control-allow-origin") !== "http://console.example.test") {
    throw new Error("Configured CORS origin was not accepted");
  }
  const rejectedOrigin = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: { origin: "http://untrusted.example.test" } });
  if (rejectedOrigin.status !== 403) throw new Error("Unconfigured CORS origin was accepted");
  const disabledLegacyWorker = await api<{ error?: string }>("/api/projects/legacy/runs", { method: "POST", body: JSON.stringify({}) });
  if (disabledLegacyWorker.response.status !== 404 || disabledLegacyWorker.body.error !== "LEGACY_WORKER_API_DISABLED") {
    throw new Error("Legacy Worker API was exposed from a non-local listener");
  }

  const health = await api<{ ok: boolean; service: string }>("/api/platform/health");
  if (!health.response.ok || health.body.service !== "platform") throw new Error("Platform health endpoint failed");

  const registration = await api<{ token: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.test", name: "Owner", password: "development-password" }),
  });
  if (!registration.response.ok || !registration.body.token) throw new Error("Platform registration failed");
  const sessionCookie = registration.response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!sessionCookie?.startsWith("autoflow_session=")) throw new Error("Platform registration did not issue an HttpOnly session cookie");
  const cookieSession = await api<{ workspaces: Array<{ id: string }> }>("/api/auth/session", { headers: { cookie: sessionCookie } });
  if (!cookieSession.response.ok || !cookieSession.body.workspaces[0]?.id) throw new Error("Cookie session could not be restored");
  const rejectedLogin = await api<{ error?: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.test", password: "wrong-password" }),
  });
  if (rejectedLogin.response.status !== 401 || rejectedLogin.body.error !== "LOGIN_INVALID") {
    throw new Error("Platform login accepted an invalid password");
  }
  const login = await api<{ token: string; workspaces: never }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.test", password: "development-password" }),
  });
  if (!login.response.ok || !login.body.token) throw new Error("Platform login failed");
  const token = login.body.token;
  const session = await api<{ workspaces: Array<{ id: string }> }>("/api/auth/session", { headers: headers(token) });
  const workspaceId = session.body.workspaces[0]?.id;
  if (!workspaceId) throw new Error("Login did not create a workspace");

  const projectResponse = await api<{ project: { id: string } }>(`/api/workspaces/${workspaceId}/projects`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "Platform contract project", description: "contract" }),
  });
  const projectId = projectResponse.body.project?.id;
  if (!projectResponse.response.ok || !projectId) throw new Error(`Project creation failed: ${JSON.stringify(projectResponse.body)}`);
  const internalEnvironment = { id: "internal", name: "Internal", baseUrl: "https://internal.example.test", browser: "Chromium" };
  const currentDocument = await api<{ version: number }>(`/api/platform/projects/${projectId}/document`, { headers: headers(token) });
  if (!currentDocument.response.ok) throw new Error("Project document lookup failed");
  const document = await api(`/api/platform/projects/${projectId}/document`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ data: { environments: [internalEnvironment] }, expectedVersion: currentDocument.body.version }),
  });
  if (!document.response.ok) throw new Error(`Project document setup failed: ${JSON.stringify(document.body)}`);
  const migratedEnvironments = await api<{ resources: Array<{ id: string }> }>(`/api/platform/projects/${projectId}/resources/environments`, { headers: headers(token) });
  if (!migratedEnvironments.response.ok || migratedEnvironments.body.resources[0]?.id !== internalEnvironment.id) {
    throw new Error("Project document resources were not migrated idempotently");
  }
  const secretVariable = await api<{ resource: { id: string; data: { value?: string }; version: number } }>(`/api/platform/projects/${projectId}/resources/variables`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ id: "login-password", data: { id: "login-password", name: "login_password", value: "must-not-persist", secret: true } }),
  });
  if (!secretVariable.response.ok || secretVariable.body.resource.data.value !== "") throw new Error("Secret variable plaintext entered the resource model");
  const variableUpdate = await api<{ resource: { version: number } }>(`/api/platform/projects/${projectId}/resources/variables/login-password`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ data: { description: "rotated" }, expectedVersion: 1 }),
  });
  if (!variableUpdate.response.ok || variableUpdate.body.resource.version !== 2) throw new Error("Resource optimistic update failed");
  const variableConflict = await api<{ error?: string }>(`/api/platform/projects/${projectId}/resources/variables/login-password`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ data: { description: "stale" }, expectedVersion: 1 }),
  });
  if (variableConflict.response.status !== 409 || variableConflict.body.error !== "RESOURCE_VERSION_CONFLICT") {
    throw new Error("A stale resource update was not rejected");
  }
  const unsupportedRevision = await api<{ error?: string }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ flow: { id: "unsupported", steps: [] }, environment: { ...internalEnvironment, browser: "Firefox" }, elements: [] }),
  });
  if (unsupportedRevision.response.status !== 400 || unsupportedRevision.body.error !== "AGENT_BROWSER_UNSUPPORTED") {
    throw new Error("Platform accepted a browser engine without a Chromium implementation");
  }

  const revision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: { id: "contract-flow", name: "Contract flow", steps: [{ id: "uses-secret", action: "wait", value: "{{secret.login_password}}" }] },
      environment: internalEnvironment,
      elements: [],
      dataset: { id: "dataset-v1", version: 1 },
      secretNames: ["login_password"],
    }),
  });
  const revisionId = revision.body.revision?.id;
  if (!revision.response.ok || !revisionId) throw new Error(`Revision creation failed: ${JSON.stringify(revision.body)}`);
  await api(`/api/platform/projects/${projectId}/secrets`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "login_password", value: "never-log-this" }),
  });
  const publish = await api(`/api/platform/projects/${projectId}/revisions/${revisionId}/publish`, { method: "POST", headers: headers(token) });
  if (!publish.response.ok) throw new Error("Revision publish failed");
  const secondaryRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: { id: "secondary-flow", name: "Secondary flow", steps: [{ id: "open", action: "wait", value: "1" }] },
      environment: internalEnvironment,
      elements: [],
    }),
  });
  const secondaryRevisionId = secondaryRevision.body.revision?.id;
  if (!secondaryRevision.response.ok || !secondaryRevisionId) throw new Error("Secondary revision creation failed");
  const secondaryPublish = await api(`/api/platform/projects/${projectId}/revisions/${secondaryRevisionId}/publish`, { method: "POST", headers: headers(token) });
  if (!secondaryPublish.response.ok) throw new Error("Secondary revision publish failed");
  const publishedRevisions = await api<{ revisions: Array<{ id: string; flowId?: string; flowName?: string; environmentId?: string; status: string }> }>(`/api/platform/projects/${projectId}/revisions`, { headers: headers(token) });
  const primaryPublished = publishedRevisions.body.revisions.find((item) => item.id === revisionId);
  const secondaryPublished = publishedRevisions.body.revisions.find((item) => item.id === secondaryRevisionId);
  if (
    primaryPublished?.status !== "published" ||
    secondaryPublished?.status !== "published" ||
    primaryPublished.flowId !== "contract-flow" ||
    secondaryPublished.flowName !== "Secondary flow" ||
    secondaryPublished.environmentId !== "internal"
  ) {
    throw new Error(`Published revisions were not isolated by flow and environment: ${JSON.stringify(publishedRevisions.body)}`);
  }

  const reviewDraft = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, { method: "POST", headers: headers(token), body: JSON.stringify({ flow: { id: "review-flow", name: "Review flow", steps: [] }, environment: internalEnvironment, elements: [] }) });
  const reviewId = reviewDraft.body.revision.id;
  const submitted = await api<{ status: string }>(`/api/platform/projects/${projectId}/revisions/${reviewId}/submit`, { method: "POST", headers: headers(token), body: JSON.stringify({ note: "Ready" }) });
  const rejected = await api<{ status: string }>(`/api/platform/projects/${projectId}/revisions/${reviewId}/reject`, { method: "POST", headers: headers(token), body: JSON.stringify({ note: "Add an assertion" }) });
  const resubmitted = await api<{ status: string }>(`/api/platform/projects/${projectId}/revisions/${reviewId}/submit`, { method: "POST", headers: headers(token), body: JSON.stringify({ note: "Assertion added" }) });
  if (submitted.body.status !== "pending_review" || rejected.body.status !== "rejected" || resubmitted.body.status !== "pending_review") throw new Error("Revision review state machine failed");

  const templatePublished = await api<{ template: { id: string } }>(`/api/platform/templates?workspaceId=${workspaceId}`, { method: "POST", headers: headers(token), body: JSON.stringify({ projectId, revisionId: secondaryRevisionId, name: "Contract template", category: "Smoke" }) });
  const templateId = templatePublished.body.template?.id;
  if (!templatePublished.response.ok || !templateId) throw new Error("Template publication failed");
  const templateUpdated = await api<{ template: { name: string; category: string } }>(`/api/platform/templates/${templateId}`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ name: "Updated contract template", description: "updated metadata", category: "Regression" }) });
  if (!templateUpdated.response.ok || templateUpdated.body.template.name !== "Updated contract template" || templateUpdated.body.template.category !== "Regression") throw new Error("Template creator update failed");
  const templateDetail = await api<{ template: { snapshot: { variables: Array<{ secret?: boolean; value?: string }> } } }>(`/api/platform/templates/${templateId}`, { headers: headers(token) });
  if (templateDetail.body.template.snapshot.variables.some((variable) => variable.secret && variable.value)) throw new Error("Template snapshot leaked a secret value");
  await api(`/api/platform/templates/${templateId}/favorite`, { method: "POST", headers: headers(token) });
  const targetProject = await api<{ project: { id: string } }>(`/api/workspaces/${workspaceId}/projects`, { method: "POST", headers: headers(token), body: JSON.stringify({ name: "Template target" }) });
  const applied = await api<{ created: { flows: string[] } }>(`/api/platform/templates/${templateId}/apply`, { method: "POST", headers: headers(token), body: JSON.stringify({ projectId: targetProject.body.project.id }) });
  if (!applied.response.ok || applied.body.created.flows[0] === "secondary-flow") throw new Error("Template assets were not cloned with new IDs");

  // 方案C：执行恒为 ManagedRunner（部署机本机）。用 worker fixture 页面走真实 managed 执行闭环。
  const fixtureEnvironment = { id: "fixture", name: "Fixture", description: "", baseUrl: `http://127.0.0.1:${port}`, browser: "Chromium", auth: "无认证", timeout: 10, color: "teal", updatedAt: "now" };
  const fixtureRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: {
        id: "fixture-flow",
        name: "Fixture flow",
        steps: [{ id: "open", title: "Open fixture", action: "打开页面", value: "/__fixture/login", timeout: 10, failurePolicy: "停止流程", status: "pending" }],
      },
      environment: fixtureEnvironment,
      elements: [],
      secretNames: ["login_password"],
    }),
  });
  const fixtureRevisionId = fixtureRevision.body.revision?.id;
  if (!fixtureRevision.response.ok || !fixtureRevisionId) throw new Error(`Fixture revision creation failed: ${JSON.stringify(fixtureRevision.body)}`);
  const fixturePublished = await api(`/api/platform/projects/${projectId}/revisions/${fixtureRevisionId}/publish`, { method: "POST", headers: headers(token) });
  if (!fixturePublished.response.ok) throw new Error("Fixture revision publish failed");

  const createdRun = await api<{ run: { id: string; snapshot: Record<string, unknown> } }>(`/api/platform/projects/${projectId}/runs`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ revisionId: fixtureRevisionId, environmentId: "fixture" }),
  });
  const runId = createdRun.body.run?.id;
  if (!createdRun.response.ok || !runId || JSON.stringify(createdRun.body.run.snapshot).includes("never-log-this")) {
    throw new Error(`Immutable run snapshot failed: ${JSON.stringify(createdRun.body)}`);
  }
  const completedRun = await waitForRun(token, projectId, runId, ["success", "failed"]);
  if (completedRun.status !== "success" || completedRun.executorType !== "managed" || !completedRun.artifacts.some((artifact) => artifact.name === "trace.zip")) {
    throw new Error(`Managed run did not complete with Trace: ${JSON.stringify(completedRun)}`);
  }
  const downloadedArtifact = await fetch(`http://127.0.0.1:${port}/api/platform/artifacts/${completedRun.artifacts[0].id}`, { headers: headers(token) });
  if (!downloadedArtifact.ok) throw new Error("Artifact download failed");

  // 取消：等待中的 managed 运行可取消并收敛为 canceled。
  const waitingFlow = { id: "fixture-wait", name: "Fixture wait", steps: [{ id: "wait", title: "Wait", action: "等待", value: "10000", timeout: 10, failurePolicy: "停止流程", status: "pending" }] };
  const waitingRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, { method: "POST", headers: headers(token), body: JSON.stringify({ flow: waitingFlow, environment: fixtureEnvironment, elements: [] }) });
  const waitingRevisionId = waitingRevision.body.revision?.id;
  if (!waitingRevision.response.ok || !waitingRevisionId) throw new Error("Waiting revision creation failed");
  await api(`/api/platform/projects/${projectId}/revisions/${waitingRevisionId}/publish`, { method: "POST", headers: headers(token) });
  const waitingRun = await api<{ runIds: string[] }>(`/api/platform/projects/${projectId}/runs`, { method: "POST", headers: headers(token), body: JSON.stringify({ revisionId: waitingRevisionId, environmentId: "fixture" }) });
  const waitingRunId = waitingRun.body.runIds[0];
  if (!waitingRun.response.ok || !waitingRunId) throw new Error("Waiting run creation failed");
  await waitForRun(token, projectId, waitingRunId, ["running"]);
  const canceled = await api<{ run: { cancellationRequested: boolean } }>(`/api/platform/projects/${projectId}/runs/${waitingRunId}/cancel`, { method: "POST", headers: headers(token) });
  if (!canceled.response.ok || !canceled.body.run.cancellationRequested) throw new Error("Run cancellation request failed");
  const canceledRun = await waitForRun(token, projectId, waitingRunId, ["canceled"]);
  if (canceledRun.status !== "canceled") throw new Error("Managed cancellation did not settle the run");

  const csv = "account,expectedOrder\nalice,A-100\nbob,B-200\n";
  const importedDataset = await api<{ dataset: { id: string }; version: { id: string; rowCount: number; columns: string[] } }>(`/api/platform/projects/${projectId}/datasets`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "Accounts", fileName: "accounts.csv", contentBase64: Buffer.from(csv).toString("base64") }),
  });
  const datasetVersionId = importedDataset.body.version?.id;
  if (!importedDataset.response.ok || !datasetVersionId || importedDataset.body.version.rowCount !== 2 || importedDataset.body.version.columns[0] !== "account") {
    throw new Error(`Dataset import failed: ${JSON.stringify(importedDataset.body)}`);
  }
  const datasetPreview = await api<{ rows: Array<{ rowNumber: number; data: { account: string } }> }>(`/api/platform/projects/${projectId}/dataset-versions/${datasetVersionId}`, { headers: headers(token) });
  if (!datasetPreview.response.ok || datasetPreview.body.rows[1]?.data.account !== "bob") throw new Error("Dataset rows were not versioned");

  const dataRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: { id: "parameterized-flow", name: "Parameterized flow", steps: [{ id: "input", action: "fill", value: "{{data.account}}", output: "orderId", outputPublic: true }, { id: "reuse", action: "fill", value: "{{flow.orderId}}" }] },
      environment: { id: "internal", name: "Internal", baseUrl: "https://internal.example.test" },
      elements: [],
      datasetVersionId,
    }),
  });
  const dataRevisionId = dataRevision.body.revision?.id;
  if (!dataRevision.response.ok || !dataRevisionId) throw new Error("Dataset revision creation failed");
  const dataPublished = await api(`/api/platform/projects/${projectId}/revisions/${dataRevisionId}/publish`, { method: "POST", headers: headers(token) });
  if (!dataPublished.response.ok) throw new Error("Dataset revision publish failed");

  const channel = await api<{ channel: { id: string; name: string }; config?: unknown }>(`/api/platform/workspaces/${workspaceId}/notification-channels`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "Contract webhook", type: "webhook", config: { url: "https://example.com/notification-sink", headers: { "x-contract": "yes" } } }),
  });
  const channelId = channel.body.channel?.id;
  if (!channel.response.ok || !channelId || "config" in channel.body) throw new Error("Notification channel was not securely created");
  const subscription = await api(`/api/platform/projects/${projectId}/notification-subscriptions`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ channelId, onSuccess: true, onFailure: true }),
  });
  if (!subscription.response.ok) throw new Error("Notification subscription failed");

  const parameterized = await api<{ runs: Array<{ id: string; snapshot: Record<string, unknown> }> }>(`/api/platform/projects/${projectId}/runs`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ revisionId: dataRevisionId, environmentId: "internal", datasetVersionId }),
  });
  if (!parameterized.response.ok || parameterized.body.runs.length !== 2 || (parameterized.body.runs[0]?.snapshot.datasetRow as { data?: { account?: string } } | undefined)?.data?.account !== "alice") {
    throw new Error(`Parameterized run snapshot failed: ${JSON.stringify(parameterized.body)}`);
  }
  // managed 执行：再跑一次 fixture 版本产生成功运行，用于通知投递断言。
  const fixtureRun = await api<{ runIds: string[] }>(`/api/platform/projects/${projectId}/runs`, { method: "POST", headers: headers(token), body: JSON.stringify({ revisionId: fixtureRevisionId, environmentId: "fixture" }) });
  await waitForRun(token, projectId, fixtureRun.body.runIds[0], ["success", "failed"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const deliveries = await api<{ deliveries: Array<{ channel: { name: string } }> }>(`/api/platform/projects/${projectId}/deliveries`, { headers: headers(token) });
  if (!deliveries.response.ok || deliveries.body.deliveries[0]?.channel.name !== "Contract webhook") throw new Error("Run notification delivery was not queued");
  if (JSON.stringify(deliveries.body).includes("never-log-this")) throw new Error("Delivery listing leaked a secret value");
  const auditEvents = await api(`/api/platform/projects/${projectId}/audit-events`, { headers: headers(token) });
  if (!auditEvents.response.ok) throw new Error("Audit events listing failed");
  if (JSON.stringify(auditEvents.body).includes("never-log-this")) throw new Error("Audit events leaked a secret value");

  const schedule = await api<{ schedule: { id: string } }>(`/api/platform/projects/${projectId}/schedules`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "Daily parameterized check", revisionId: dataRevisionId, environmentId: "internal", datasetVersionId, cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" }),
  });
  if (!schedule.response.ok || !schedule.body.schedule?.id) throw new Error(`Schedule creation failed: ${JSON.stringify(schedule.body)}`);
  const scheduled = await api<{ runIds: string[] }>(`/api/platform/projects/${projectId}/schedules/${schedule.body.schedule.id}/run`, { method: "POST", headers: headers(token) });
  if (!scheduled.response.ok || scheduled.body.runIds.length !== 2) throw new Error("Schedule did not create one run per dataset row");

  const webhook = await api<{ trigger: { id: string }; triggerUrl: string; signingSecret: string }>(`/api/platform/projects/${projectId}/webhook-triggers`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "CI parameterized check", revisionId: dataRevisionId, environmentId: "internal", datasetVersionId }),
  });
  if (!webhook.response.ok || !webhook.body.triggerUrl || !webhook.body.signingSecret) throw new Error("Webhook trigger creation failed");
  const timestamp = String(Date.now());
  const rawBody = "";
  const deliveryId = "contract-webhook-delivery";
  const signature = `sha256=${createHmac("sha256", webhook.body.signingSecret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const webhookRun = await api<{ accepted: boolean; runIds: string[] }>(webhook.body.triggerUrl, {
    method: "POST",
    headers: {
      "x-autoflow-timestamp": timestamp,
      "x-autoflow-delivery-id": deliveryId,
      "x-autoflow-signature": signature,
    },
    body: rawBody,
  });
  if (!webhookRun.response.ok || !webhookRun.body.accepted || webhookRun.body.runIds.length !== 2) throw new Error("Webhook did not run the published parameterized revision");

  const analytics = await api<{ analytics: { summary: { totalRuns: number } } }>(`/api/platform/projects/${projectId}/analytics`, { headers: headers(token) });
  if (!analytics.response.ok || analytics.body.analytics.summary.totalRuns < 1) {
    throw new Error(`Analytics aggregation failed: ${JSON.stringify(analytics.body)}`);
  }
  const viewerRegistration = await api<{ token: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "viewer@example.test", name: "Viewer", password: "viewer-password" }),
  });
  if (!viewerRegistration.response.ok || !viewerRegistration.body.token) throw new Error("Viewer registration failed");
  const addedMember = await api<{ member: { id: string; role: string } }>(`/api/workspaces/${workspaceId}/members`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ email: "viewer@example.test", name: "Viewer", role: "viewer" }),
  });
  if (!addedMember.response.ok || addedMember.body.member.role !== "viewer") throw new Error("Workspace member creation failed");
  const viewerRead = await api(`/api/platform/projects/${projectId}/revisions`, { headers: headers(viewerRegistration.body.token) });
  if (!viewerRead.response.ok) throw new Error("Viewer should retain project read access");
  const viewerPublish = await api<{ error?: string }>(`/api/platform/projects/${projectId}/revisions/${dataRevisionId}/publish`, { method: "POST", headers: headers(viewerRegistration.body.token) });
  if (viewerPublish.response.status !== 403 || viewerPublish.body.error !== "CAPABILITY_REQUIRED") throw new Error("Viewer was allowed to publish a release");
  const viewerDraft = await api(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(viewerRegistration.body.token),
    body: JSON.stringify({ flow: { id: "viewer-flow", steps: [] }, environment: { id: "internal" }, elements: [] }),
  });
  if (viewerDraft.response.status !== 403) throw new Error("Viewer was allowed to create a draft");
  const productRegistration = await api<{ token?: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "product@example.test", name: "Product", password: "product-password" }),
  });
  if (!productRegistration.response.ok || !productRegistration.body.token) throw new Error("Product registration failed");
  const productMember = await api<{ member: { id: string } }>(`/api/workspaces/${workspaceId}/members`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ email: "product@example.test", name: "Product", role: "product" }),
  });
  if (!productMember.response.ok) throw new Error("Product member creation failed");
  const productRun = await api<{ error?: string }>(`/api/platform/projects/${projectId}/runs`, {
    method: "POST",
    headers: headers(productRegistration.body.token),
    body: JSON.stringify({ revisionId: dataRevisionId }),
  });
  if (productRun.response.status !== 403 || productRun.body.error !== "CAPABILITY_REQUIRED") throw new Error("Product was allowed to create a run without run.execute");
  const ownerId = registration.body.token ? (await api<{ members: Array<{ id: string; role: string }> }>(`/api/workspaces/${workspaceId}/members`, { headers: headers(token) })).body.members.find((member) => member.role === "owner")?.id : undefined;
  const disableLastOwner = await api<{ error?: string }>(`/api/workspaces/${workspaceId}/members/${ownerId}/account`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ enabled: false }) });
  if (disableLastOwner.response.status !== 409 || disableLastOwner.body.error !== "LAST_WORKSPACE_OWNER_REQUIRED") throw new Error("Last workspace owner could be disabled");

  const invitedMember = await api<{ member?: { id: string }; invitationToken?: string }>(`/api/workspaces/${workspaceId}/members`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ email: "invited@example.test", name: "Invited", role: "editor" }),
  });
  if (!invitedMember.response.ok || !invitedMember.body.member?.id || !invitedMember.body.invitationToken) {
    throw new Error("Workspace invitation was not created");
  }
  const missingInvitation = await api<{ error?: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "invited@example.test", name: "Invited", password: "invited-password" }),
  });
  if (missingInvitation.response.status !== 409 || missingInvitation.body.error !== "INVITATION_VERIFICATION_REQUIRED") {
    throw new Error("Pending member registered without an invitation token");
  }
  const acceptedInvitation = await api<{ token?: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "invited@example.test", name: "Invited", password: "invited-password", invitationToken: invitedMember.body.invitationToken }),
  });
  if (!acceptedInvitation.response.ok || !acceptedInvitation.body.token) throw new Error("Valid invitation token was not accepted");
  const invitedId = invitedMember.body.member.id;
  const disabledInvited = await api<{ enabled: boolean }>(`/api/workspaces/${workspaceId}/members/${invitedId}/account`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ enabled: false }) });
  if (!disabledInvited.response.ok || disabledInvited.body.enabled !== false) throw new Error("Account disable failed");
  const disabledSession = await api<{ error?: string }>("/api/auth/session", { headers: headers(acceptedInvitation.body.token) });
  if (disabledSession.response.status !== 401) throw new Error("Disabled account retained an active session");
  await api(`/api/workspaces/${workspaceId}/members/${invitedId}/account`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ enabled: true }) });
  const resetPassword = await api(`/api/workspaces/${workspaceId}/members/${invitedId}/reset-password`, { method: "POST", headers: headers(token), body: JSON.stringify({ password: "invited-new-password" }) });
  if (!resetPassword.response.ok) throw new Error("Administrator password reset failed");
  const resetLogin = await api<{ token?: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "invited@example.test", password: "invited-new-password" }) });
  if (!resetLogin.response.ok || !resetLogin.body.token) throw new Error("Reset password could not be used");
  const archivedDataset = await api(`/api/platform/projects/${projectId}/datasets/${importedDataset.body.dataset.id}`, { method: "DELETE", headers: headers(token) });
  const archivedSchedule = await api(`/api/platform/projects/${projectId}/schedules/${schedule.body.schedule.id}`, { method: "DELETE", headers: headers(token) });
  const archivedWebhook = await api(`/api/platform/projects/${projectId}/webhook-triggers/${webhook.body.trigger.id}`, { method: "DELETE", headers: headers(token) });
  const archivedChannel = await api(`/api/platform/workspaces/${workspaceId}/notification-channels/${channelId}`, { method: "DELETE", headers: headers(token) });
  if (![archivedDataset, archivedSchedule, archivedWebhook, archivedChannel].every((item) => item.response.ok)) throw new Error("Governance resources could not be archived");
  const archivedLists = await Promise.all([
    api<{ datasets: unknown[] }>(`/api/platform/projects/${projectId}/datasets`, { headers: headers(token) }),
    api<{ schedules: unknown[] }>(`/api/platform/projects/${projectId}/schedules`, { headers: headers(token) }),
    api<{ triggers: unknown[] }>(`/api/platform/projects/${projectId}/webhook-triggers`, { headers: headers(token) }),
    api<{ channels: unknown[] }>(`/api/platform/workspaces/${workspaceId}/notification-channels`, { headers: headers(token) }),
  ]);
  if (archivedLists.some((item) => !item.response.ok) || archivedLists.some((item) => Object.values(item.body)[0]?.length !== 0)) throw new Error("Archived governance resources remained visible");
  const projectArchived = await api(`/api/platform/projects/${projectId}`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ archived: true }) });
  const archivedProjects = await api<{ projects: Array<{ id: string }> }>(`/api/workspaces/${workspaceId}/projects?archived=1`, { headers: headers(token) });
  if (!projectArchived.response.ok || !archivedProjects.body.projects.some((project) => project.id === projectId)) throw new Error("Archived project was not listed for recovery");
  const projectRestored = await api(`/api/platform/projects/${projectId}`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ archived: false }) });
  const activeProjects = await api<{ projects: Array<{ id: string }> }>(`/api/workspaces/${workspaceId}/projects`, { headers: headers(token) });
  if (!projectRestored.response.ok || !activeProjects.body.projects.some((project) => project.id === projectId)) throw new Error("Archived project could not be restored");
  console.log("Platform contract smoke test passed");
} finally {
  if (worker) await stopWorker(worker);
  if (root) await removeWorkerRoot(root);
}
