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
      // 通知投递指向本地 sink（worker 自身的 logout 端点返回 200），避免依赖外网且退避到终态耗时过长。
      PLATFORM_ALLOW_INSECURE_NOTIFICATION_URLS: "1",
      PLATFORM_ALLOW_PRIVATE_NOTIFICATION_URLS: "1",
      PLATFORM_NOTIFICATION_HOST_ALLOWLIST: "127.0.0.1,localhost",
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
    body: JSON.stringify({ id: "login-password", data: { id: "login-password", name: "login_password", value: "", secret: true } }),
  });
  if (!secretVariable.response.ok || secretVariable.body.resource.data.value !== "") throw new Error("Secret variable plaintext entered the resource model");
  // secret 变量不允许带明文值写路径：带值保存应被明确拒绝（400），而不是静默丢弃。
  const secretWithValue = await api<{ error?: string }>(`/api/platform/projects/${projectId}/resources/variables`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ id: "login-password-2", data: { id: "login-password-2", name: "login_password_2", value: "must-not-persist", secret: true } }),
  });
  if (secretWithValue.response.status !== 400 || secretWithValue.body.error !== "SECRET_VALUE_NOT_PERSISTED") {
    throw new Error(`Secret variable with plaintext value should be rejected with 400, got ${secretWithValue.response.status}: ${JSON.stringify(secretWithValue.body)}`);
  }
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

  const revision = await api<{ revision: { id: string; status: string } }>(`/api/platform/projects/${projectId}/revisions`, {
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
  if (revision.body.revision.status !== "published") throw new Error(`Save-as-snapshot revision was not published: ${JSON.stringify(revision.body)}`);
  await api(`/api/platform/projects/${projectId}/secrets`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "login_password", value: "never-log-this" }),
  });
  // 孤儿 run 回归：引用不存在 secret 的 revision 触发 run 应立即 409，且不留下永久 queued 孤儿 run。
  const missingSecretRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: { id: "missing-secret-flow", name: "Missing secret flow", steps: [{ id: "uses-missing", action: "wait", value: "{{secret.not_configured}}" }] },
      environment: internalEnvironment,
      elements: [],
      secretNames: ["not_configured"],
    }),
  });
  const missingSecretRevisionId = missingSecretRevision.body.revision?.id;
  if (!missingSecretRevision.response.ok || !missingSecretRevisionId) throw new Error("Missing-secret revision creation failed");
  const missingSecretRun = await api<{ runIds: string[]; error?: string }>(`/api/platform/projects/${projectId}/runs`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ revisionId: missingSecretRevisionId, environmentId: "internal" }),
  });
  if (missingSecretRun.response.status !== 409 || missingSecretRun.body.error !== "RUN_SECRET_NOT_CONFIGURED") {
    throw new Error(`Missing-secret run should be rejected with 409, got ${missingSecretRun.response.status}: ${JSON.stringify(missingSecretRun.body)}`);
  }
  const orphanCheck = await api<{ runs: Array<{ status: string }> }>(`/api/platform/projects/${projectId}/runs`, { headers: headers(token) });
  if ((orphanCheck.body.runs ?? []).some((run) => run.status === "queued")) {
    throw new Error("Missing-secret run left an orphan queued run behind");
  }
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

  // 保存即快照：相同内容重复保存不产生新版本（checksum 幂等）。
  const reviewSnapshot = { flow: { id: "review-flow", name: "Review flow", steps: [{ id: "open", action: "wait", value: "1" }] }, environment: internalEnvironment, elements: [] };
  const idempotentFirst = await api<{ revision: { id: string; status: string } }>(`/api/platform/projects/${projectId}/revisions`, { method: "POST", headers: headers(token), body: JSON.stringify(reviewSnapshot) });
  const idempotentSecond = await api<{ revision: { id: string; status: string } }>(`/api/platform/projects/${projectId}/revisions`, { method: "POST", headers: headers(token), body: JSON.stringify(reviewSnapshot) });
  if (!idempotentFirst.response.ok || idempotentFirst.body.revision.status !== "published") throw new Error("Save-as-snapshot failed for review flow");
  if (!idempotentSecond.response.ok || idempotentSecond.body.revision.id !== idempotentFirst.body.revision.id) {
    throw new Error(`Identical snapshot was saved twice: ${JSON.stringify(idempotentSecond.body)}`);
  }
  // 回滚：从历史版本生成新的 published 快照，旧版本置 superseded。
  const rollback = await api<{ revisionId: string; status: string }>(`/api/platform/projects/${projectId}/revisions/${revisionId}/rollback`, { method: "POST", headers: headers(token) });
  if (!rollback.response.ok || rollback.body.status !== "published") throw new Error(`Rollback failed: ${JSON.stringify(rollback.body)}`);
  const afterRollback = await api<{ revisions: Array<{ id: string; status: string }> }>(`/api/platform/projects/${projectId}/revisions`, { headers: headers(token) });
  const rolledBackSource = afterRollback.body.revisions.find((item) => item.id === revisionId);
  const rollbackLatest = afterRollback.body.revisions.find((item) => item.id === rollback.body.revisionId);
  if (rolledBackSource?.status !== "superseded" || rollbackLatest?.status !== "published") {
    throw new Error(`Rollback did not supersede the source revision: ${JSON.stringify(afterRollback.body)}`);
  }

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
  // 密钥解密审计：运行引用 {{secret.login_password}} 的流程会触发解密留痕（enqueue 阶段即审计，运行成败不影响）。
  const secretFlowRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: { id: "secret-flow", name: "Secret flow", steps: [{ id: "uses-secret", action: "wait", value: "{{secret.login_password}}" }] },
      environment: fixtureEnvironment,
      elements: [],
      secretNames: ["login_password"],
    }),
  });
  const secretFlowRevisionId = secretFlowRevision.body.revision?.id;
  if (!secretFlowRevision.response.ok || !secretFlowRevisionId) throw new Error("Secret flow revision creation failed");
  const secretRun = await api<{ runIds: string[] }>(`/api/platform/projects/${projectId}/runs`, { method: "POST", headers: headers(token), body: JSON.stringify({ revisionId: secretFlowRevisionId, environmentId: "fixture" }) });
  if (!secretRun.response.ok || !secretRun.body.runIds[0]) throw new Error("Secret flow run creation failed");
  await waitForRun(token, projectId, secretRun.body.runIds[0], ["success", "failed"]);

  // 取消：等待中的 managed 运行可取消并收敛为 canceled。
  const waitingFlow = { id: "fixture-wait", name: "Fixture wait", steps: [{ id: "wait", title: "Wait", action: "等待", value: "10000", timeout: 10, failurePolicy: "停止流程", status: "pending" }] };
  const waitingRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, { method: "POST", headers: headers(token), body: JSON.stringify({ flow: waitingFlow, environment: fixtureEnvironment, elements: [] }) });
  const waitingRevisionId = waitingRevision.body.revision?.id;
  if (!waitingRevision.response.ok || !waitingRevisionId) throw new Error("Waiting revision creation failed");
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

  const channel = await api<{ channel: { id: string; name: string }; config?: unknown }>(`/api/platform/workspaces/${workspaceId}/notification-channels`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "Contract webhook", type: "webhook", config: { url: `http://127.0.0.1:${port}/api/auth/logout`, headers: { "x-contract": "yes" } } }),
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
  // 通知投递终态轮询：delivered/failed 落地后，投递审计才可断言。
  let deliveryStatus = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const poll = await api<{ deliveries: Array<{ status: string; channel: { name: string } }> }>(`/api/platform/projects/${projectId}/deliveries`, { headers: headers(token) });
    const first = poll.body.deliveries[0];
    if (first?.status === "delivered" || first?.status === "failed") { deliveryStatus = first.status; break; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (deliveryStatus !== "delivered" && deliveryStatus !== "failed") throw new Error("Run notification delivery did not settle");
  const deliveries = await api<{ deliveries: Array<{ channel: { name: string } }> }>(`/api/platform/projects/${projectId}/deliveries`, { headers: headers(token) });
  if (!deliveries.response.ok || deliveries.body.deliveries[0]?.channel.name !== "Contract webhook") throw new Error("Run notification delivery was not queued");
  if (JSON.stringify(deliveries.body).includes("never-log-this")) throw new Error("Delivery listing leaked a secret value");
  const auditEvents = await api(`/api/platform/projects/${projectId}/audit-events`, { headers: headers(token) });
  if (!auditEvents.response.ok) throw new Error("Audit events listing failed");
  if (JSON.stringify(auditEvents.body).includes("never-log-this")) throw new Error("Audit events leaked a secret value");
  // 通知投递审计：终态投递（成功/失败/业务拒绝）应有审计事件。
  const notificationAudit = await api<{ events: Array<{ action: string }> }>(`/api/platform/projects/${projectId}/audit-events?action=notification.`, { headers: headers(token) });
  if (!notificationAudit.response.ok || !notificationAudit.body.events.some((event) => ["notification.delivered", "notification.rejected", "notification.failed"].includes(event.action))) {
    throw new Error(`Notification delivery audit missing: ${JSON.stringify(notificationAudit.body)}`);
  }
  // 认证审计：注册/登录成功/登录失败（含来源 IP）应出现在项目审计视图（工作区级事件）。
  const authAudit = await api<{ events: Array<{ action: string; detail: { ip?: string } }> }>(`/api/platform/projects/${projectId}/audit-events?action=auth.`, { headers: headers(token) });
  if (!authAudit.response.ok
    || !["auth.registered", "auth.login_succeeded", "auth.login_failed"].every((action) => authAudit.body.events.some((event) => event.action === action))
    || !authAudit.body.events.some((event) => typeof event.detail?.ip === "string")) {
    throw new Error(`Auth audit events missing or lacking source IP: ${JSON.stringify(authAudit.body)}`);
  }
  // 分页契约：page/pageSize/total 齐全，pageSize 生效。
  const pagedAudit = await api<{ events: unknown[]; total: number; page: number; pageSize: number }>(`/api/platform/projects/${projectId}/audit-events?page=1&pageSize=2`, { headers: headers(token) });
  if (!pagedAudit.response.ok || pagedAudit.body.events.length > 2 || pagedAudit.body.total < 1 || pagedAudit.body.page !== 1 || pagedAudit.body.pageSize !== 2) {
    throw new Error(`Audit pagination contract failed: ${JSON.stringify(pagedAudit.body)}`);
  }
  // 关键字搜索：按 action 内容命中。
  const searchedAudit = await api<{ events: Array<{ action: string }> }>(`/api/platform/projects/${projectId}/audit-events?q=run.`, { headers: headers(token) });
  if (!searchedAudit.response.ok || !searchedAudit.body.events.every((event) => event.action.includes("run."))) {
    throw new Error(`Audit keyword search failed: ${JSON.stringify(searchedAudit.body)}`);
  }

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
  // 指标扩展契约：窗口/周期/归类维度参数 + 运行时长、调度健康度、失败归类维度字段。
  const analyticsExtended = await api<{ analytics: { runDurations: Array<{ date: string; averageMs: number }>; scheduleHealth: { triggered: number; skipped: number; successRate: number }; failureCategories: Array<{ dimension: string }> } }>(`/api/platform/projects/${projectId}/analytics?window=30&period=week&categoryBy=code`, { headers: headers(token) });
  if (!analyticsExtended.response.ok
    || !Array.isArray(analyticsExtended.body.analytics.runDurations)
    || typeof analyticsExtended.body.analytics.scheduleHealth?.successRate !== "number"
    || analyticsExtended.body.analytics.failureCategories.some((item) => item.dimension !== "code")) {
    throw new Error(`Analytics extended contract failed: ${JSON.stringify(analyticsExtended.body)}`);
  }
  // 运行生命周期审计：至少存在 run.created 与一个终态事件。
  const runAudit = await api<{ events: Array<{ action: string }> }>(`/api/platform/projects/${projectId}/audit-events?action=run.&pageSize=100`, { headers: headers(token) });
  if (!runAudit.response.ok
    || !runAudit.body.events.some((event) => event.action === "run.created")
    || !runAudit.body.events.some((event) => ["run.completed", "run.failed", "run.canceled"].includes(event.action))) {
    throw new Error(`Run lifecycle audit events missing: ${JSON.stringify(runAudit.body)}`);
  }
  // 敏感操作审计：运行引用了 login_password，应有解密留痕且不含明文。
  const secretAudit = await api<{ events: Array<{ action: string; detail: { names?: string[] } }> }>(`/api/platform/projects/${projectId}/audit-events?action=secret.`, { headers: headers(token) });
  if (!secretAudit.response.ok || !secretAudit.body.events.some((event) => event.action === "secret.decrypted_for_run" && event.detail.names?.includes("login_password"))) {
    throw new Error(`Secret decryption audit missing: ${JSON.stringify(secretAudit.body)}`);
  }
  if (JSON.stringify(secretAudit.body).includes("never-log-this")) throw new Error("Secret audit leaked a plaintext value");
  // 成员/角色已收敛：登录即全权限（角色细分移除），但工作空间隔离保留。
  const strangerRegistration = await api<{ token: string; user: { id: string } }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "stranger@example.test", name: "Stranger", password: "stranger-password" }),
  });
  if (!strangerRegistration.response.ok || !strangerRegistration.body.token) throw new Error("Stranger registration failed");
  // 非成员不可见其他工作空间项目（隔离）。
  const strangerRead = await api<{ error?: string }>(`/api/platform/projects/${projectId}/revisions`, { headers: headers(strangerRegistration.body.token) });
  if (strangerRead.response.status !== 403 || strangerRead.body.error !== "WORKSPACE_ACCESS_DENIED") {
    throw new Error(`Cross-workspace project access was not denied: ${strangerRead.response.status} ${JSON.stringify(strangerRead.body)}`);
  }
  // 成员（含仅 open 注册）在自己的工作空间内拥有全权限：建项目 → 建环境 → 保存即快照 → 运行入队。
  const strangerSession = await api<{ workspaces: Array<{ id: string }> }>("/api/auth/session", { headers: headers(strangerRegistration.body.token) });
  const strangerWorkspaceId = strangerSession.body.workspaces[0]?.id;
  if (!strangerWorkspaceId) throw new Error("Stranger workspace missing");
  const strangerProject = await api<{ project: { id: string } }>(`/api/workspaces/${strangerWorkspaceId}/projects`, { method: "POST", headers: headers(strangerRegistration.body.token), body: JSON.stringify({ name: "Stranger project" }) });
  if (!strangerProject.response.ok) throw new Error("Stranger could not create a project in their own workspace");
  const strangerSnapshot = await api(`/api/platform/projects/${strangerProject.body.project.id}/revisions`, {
    method: "POST",
    headers: headers(strangerRegistration.body.token),
    body: JSON.stringify({ flow: { id: "stranger-flow", name: "Stranger flow", steps: [{ id: "open", action: "wait", value: "1" }] }, environment: { id: "internal", name: "Internal", description: "", baseUrl: `http://127.0.0.1:${port}`, browser: "Chromium", auth: "无认证", timeout: 5, color: "teal", updatedAt: "now" }, elements: [] }),
  });
  if (!strangerSnapshot.response.ok) throw new Error("Stranger full-permission snapshot creation failed");
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
  // 归档联动回归：归档项目后其 webhook 不再被接受（查询层过滤已归档项目），调度不再到期触发。
  const archivalWebhook = await api<{ triggerUrl: string; signingSecret: string }>(`/api/platform/projects/${projectId}/webhook-triggers`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "Archival webhook", revisionId: dataRevisionId, environmentId: "internal" }),
  });
  if (!archivalWebhook.response.ok || !archivalWebhook.body.triggerUrl || !archivalWebhook.body.signingSecret) throw new Error("Archival webhook creation failed");
  const archivalTimestamp = String(Date.now());
  const archivalSignature = `sha256=${createHmac("sha256", archivalWebhook.body.signingSecret).update(`${archivalTimestamp}.`).digest("hex")}`;
  const projectArchived = await api(`/api/platform/projects/${projectId}`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ archived: true }) });
  if (!projectArchived.response.ok) throw new Error("Project archival failed");
  const archivedWebhookHit = await api<{ error?: string }>(archivalWebhook.body.triggerUrl, {
    method: "POST",
    headers: {
      "x-autoflow-timestamp": archivalTimestamp,
      "x-autoflow-delivery-id": "archival-webhook-delivery",
      "x-autoflow-signature": archivalSignature,
    },
    body: "",
  });
  if (archivedWebhookHit.response.status !== 404) {
    throw new Error(`Webhook fired for an archived project: ${archivedWebhookHit.response.status} ${JSON.stringify(archivedWebhookHit.body)}`);
  }
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
