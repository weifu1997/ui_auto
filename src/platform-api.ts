const apiBase = (import.meta.env.VITE_WORKER_API_URL ?? (import.meta.env.PROD ? "/api" : "http://127.0.0.1:8787/api")).replace(/\/$/, "");

export function platformApiOrigin() {
  return new URL(apiBase, window.location.origin).origin;
}

export type PlatformSession = {
  token: string;
  user: { id: string; email: string; name: string };
  workspaces: Array<{ id: string; name: string; role: string }>;
};

export type PlatformProject = {
  id: string;
  workspaceId: string;
  sourceProjectId?: string;
  slug: string;
  name: string;
  description: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformProjectDocument = {
  data: Record<string, unknown>;
  version: number;
  updatedAt?: string;
};

export type PlatformResourceType = "flows" | "elements" | "variables" | "environments";
export type PlatformResource<T = Record<string, unknown>> = {
  id: string;
  data: T;
  version: number;
  archivedAt: string | null;
  updatedAt: string;
  updatedBy: string;
};
export type PlatformTemplate = { id: string; name: string; description: string; category: string; sourceProjectId?: string; sourceRevisionId?: string; createdBy?: string; createdAt: string; updatedAt: string; favorite: boolean; snapshot?: Record<string, unknown> };

export type PlatformRevision = {
  id: string;
  flowId?: string;
  flowName?: string;
  revisionNumber: number;
  status: "draft" | "pending_review" | "published" | "rejected" | "deprecated" | "superseded";
  checksum: string;
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
  environmentId?: string;
  stepCount?: number;
};

export type PlatformRun = {
  id: string;
  projectId: string;
  revisionId: string;
  environmentId: string;
  agentId: string;
  executorType?: "managed" | "agent";
  status: "queued" | "dispatched" | "running" | "success" | "failed" | "canceled";
  snapshot: Record<string, unknown>;
  result?: Record<string, unknown>;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
  agent?: { id: string; name: string; browserVersion: string; os: string; maxConcurrency: number; lastSeenAt: string | null };
  artifacts: Array<{ id: string; name: string; contentType: string; createdAt: string }>;
  events: Array<{ id: number; kind: string; data: Record<string, unknown>; at: string }>;
  flowOutputs: Array<{ name: string; value: string; source: string; createdAt: string }>;
};

export type PlatformElementValidation = {
  id: string;
  projectId: string;
  environmentId: string;
  agentId: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  element: Record<string, unknown>;
  result?: { count: number; firstMatch?: string; elapsedMs: number; screenshotId?: string };
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type PlatformElement = {
  id: string;
  name: string;
  description: string;
  path: string;
  method: string;
  value: string;
  environment: string;
  validation: "verified" | "unverified";
  updatedAt: string;
};

export type PlatformDatasetVersion = {
  id: string;
  datasetId: string;
  projectId: string;
  versionNumber: number;
  columns: string[];
  rowCount: number;
  checksum: string;
  sourceName: string;
  createdAt: string;
};

export type PlatformDataset = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  latestVersion?: PlatformDatasetVersion;
};

export type PlatformSchedule = {
  id: string;
  revisionId: string;
  environmentId: string;
  datasetVersionId: string | null;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PlatformWebhookTrigger = {
  id: string;
  revisionId: string;
  environmentId: string;
  datasetVersionId: string | null;
  name: string;
  enabled: boolean;
  createdAt: string;
  lastTriggeredAt: string | null;
};

export type PlatformNotificationChannel = {
  id: string;
  name: string;
  type: "webhook" | "feishu" | "dingtalk" | "wecom" | "email";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PlatformNotificationSubscription = {
  channelId: string;
  name: string;
  type: PlatformNotificationChannel["type"];
  channelEnabled: boolean;
  onSuccess: boolean;
  onFailure: boolean;
};

export type PlatformDelivery = {
  id: string;
  runId: string;
  status: "pending" | "retrying" | "delivering" | "delivered" | "failed";
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  channel: { name: string; type: PlatformNotificationChannel["type"] };
};

export type PlatformAnalyticsSummary = {
  totalRuns: number;
  successRate: number;
  failedRuns: number;
  canceledRuns: number;
  failedRate: number;
  canceledRate: number;
};

export type PlatformAnalytics = {
  summary: PlatformAnalyticsSummary;
  previous?: PlatformAnalyticsSummary;
  trend: Array<{ date: string; total: number; success: number; failed: number; canceled: number }>;
  failureCategories: Array<{ category: string; count: number; dimension: "message" | "code" | "step" }>;
  slowSteps: Array<{ stepId: string; title: string; count: number; averageMs: number; maxMs: number }>;
  elementImpact: Array<{ elementId: string; name: string; runCount: number; flowCount: number; failedRuns: number; lastUsedAt: string }>;
  runDurations: Array<{ date: string; averageMs: number; count: number }>;
  scheduleHealth: { triggered: number; skipped: number; successRate: number };
};

export type PlatformAnalyticsQuery = {
  window?: number;
  from?: string;
  to?: string;
  period?: "day" | "week";
  limit?: number;
  categoryBy?: "message" | "code" | "step";
};

export type PlatformAuditEvent = { id: string; actorType: string; actorId: string; action: string; targetType: string; targetId: string; detail: Record<string, unknown>; createdAt: string };

export type PlatformAuditQuery = {
  page?: number;
  pageSize?: number;
  /** action 前缀匹配，如 "auth."、"notification."、"run." */
  action?: string;
  actorId?: string;
  actorType?: string;
  from?: string;
  to?: string;
  /** 关键字：匹配 action / target_type / target_id / detail */
  q?: string;
};

export class PlatformApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "PlatformApiError";
    this.status = status;
    this.code = code;
  }
}

// 会话代次：登录/注册/恢复成功即递增。旧会话 in-flight 请求的迟到 401 只有在代次未变时
// 才触发 autoflow-auth-expired，避免清掉刚建立的新登录会话。
let sessionGeneration = 0;
export function bumpSessionGeneration() {
  sessionGeneration += 1;
}

async function request<T>(path: string, init: RequestInit = {}, token?: string) {
  const generation = sessionGeneration;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) {
      if (response.status === 401 && generation === sessionGeneration && typeof window !== "undefined") {
        window.dispatchEvent(new Event("autoflow-auth-expired"));
      }
      throw new PlatformApiError(response.status, body.error ?? "PLATFORM_REQUEST_FAILED");
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new PlatformApiError(0, "TIMEOUT");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function loginPlatform(input: { email: string; password: string; name?: string }) {
  await request<{ token: string; user: PlatformSession["user"] }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  bumpSessionGeneration();
  const session = await request<Omit<PlatformSession, "token">>("/auth/session");
  return { ...session, token: "cookie" } satisfies PlatformSession;
}

export async function registerPlatform(input: { email: string; password: string; name?: string }) {
  await request<{ token: string; user: PlatformSession["user"] }>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  bumpSessionGeneration();
  const session = await request<Omit<PlatformSession, "token">>("/auth/session");
  return { ...session, token: "cookie" } satisfies PlatformSession;
}

export function logoutPlatform() {
  bumpSessionGeneration();
  return request<{ loggedOut: true }>("/auth/logout", { method: "POST" }, "cookie");
}

export async function restorePlatformSession() {
  const session = await request<Omit<PlatformSession, "token">>("/auth/session");
  bumpSessionGeneration();
  return { ...session, token: "cookie" } satisfies PlatformSession;
}

export function importLocalWorkspace(
  token: string,
  workspaceId: string,
  sourceId: string,
  data: Record<string, unknown>,
) {
  return request<{ imported: boolean; projects: Array<{ sourceProjectId: string; projectId: string }> }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/imports/local-storage`,
    { method: "POST", body: JSON.stringify({ sourceId, data }) },
    token,
  );
}

export function getWorkspaceProjects(token: string, workspaceId: string, archived = false) {
  return request<{ projects: PlatformProject[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/projects${archived ? "?archived=1" : ""}`,
    {},
    token,
  );
}

export function createWorkspaceProject(token: string, workspaceId: string, input: { name: string; description?: string }) {
  return request<{ project: PlatformProject }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/projects`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function getPlatformResources<T>(token: string, projectId: string, type: PlatformResourceType) {
  return request<{ resources: Array<PlatformResource<T>> }>(
    `/platform/projects/${encodeURIComponent(projectId)}/resources/${type}`,
    {},
    token,
  );
}

export function createPlatformResource<T extends Record<string, unknown>>(token: string, projectId: string, type: PlatformResourceType, data: T) {
  return request<{ resource: PlatformResource<T> }>(
    `/platform/projects/${encodeURIComponent(projectId)}/resources/${type}`,
    { method: "POST", body: JSON.stringify({ id: data.id, data }) },
    token,
  );
}

export function updatePlatformResource<T extends Record<string, unknown>>(token: string, projectId: string, type: PlatformResourceType, id: string, data: T, expectedVersion: number) {
  return request<{ resource: PlatformResource<T> }>(
    `/platform/projects/${encodeURIComponent(projectId)}/resources/${type}/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify({ data, expectedVersion }) },
    token,
  );
}

export function archivePlatformResource(token: string, projectId: string, type: PlatformResourceType, id: string, expectedVersion: number) {
  return request<{ id: string; archived: true; version: number }>(
    `/platform/projects/${encodeURIComponent(projectId)}/resources/${type}/${encodeURIComponent(id)}?expectedVersion=${expectedVersion}`,
    { method: "DELETE" },
    token,
  );
}

export function getPlatformSettings(token: string, projectId: string) {
  return request<{ settings: { data: Record<string, unknown>; version: number; updatedAt?: string; updatedBy?: string } }>(
    `/platform/projects/${encodeURIComponent(projectId)}/settings`, {}, token,
  );
}

export function updatePlatformSettings(token: string, projectId: string, data: Record<string, unknown>, expectedVersion: number) {
  return request<{ settings: { data: Record<string, unknown>; version: number; updatedAt: string; updatedBy: string } }>(
    `/platform/projects/${encodeURIComponent(projectId)}/settings`,
    { method: "PUT", body: JSON.stringify({ data, expectedVersion }) },
    token,
  );
}

export function getPlatformTemplates(token: string, workspaceId: string, query = "") {
  return request<{ templates: PlatformTemplate[] }>(`/platform/templates?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}`, {}, token);
}

export function getPlatformTemplate(token: string, templateId: string) {
  return request<{ template: PlatformTemplate }>(`/platform/templates/${encodeURIComponent(templateId)}`, {}, token);
}

export function createPlatformTemplate(token: string, workspaceId: string, input: { projectId: string; revisionId: string; name: string; description?: string; category?: string }) {
  return request<{ template: PlatformTemplate }>(`/platform/templates?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST", body: JSON.stringify(input) }, token);
}

export function updatePlatformTemplate(token: string, templateId: string, input: { name: string; description?: string; category?: string }) {
  return request<{ template: PlatformTemplate }>(`/platform/templates/${encodeURIComponent(templateId)}`, { method: "PATCH", body: JSON.stringify(input) }, token);
}

export function deletePlatformTemplate(token: string, templateId: string) {
  return request<{ templateId: string; deleted: boolean }>(`/platform/templates/${encodeURIComponent(templateId)}`, { method: "DELETE" }, token);
}

export function favoritePlatformTemplate(token: string, templateId: string, favorite: boolean) {
  return request<{ templateId: string; favorite: boolean }>(`/platform/templates/${encodeURIComponent(templateId)}/favorite`, { method: favorite ? "POST" : "DELETE" }, token);
}

export function applyPlatformTemplate(token: string, templateId: string, projectId: string) {
  return request<{ templateId: string; projectId: string; created: Record<string, string[]> }>(`/platform/templates/${encodeURIComponent(templateId)}/apply`, { method: "POST", body: JSON.stringify({ projectId }) }, token);
}

export function getPlatformProjectDocument(token: string, projectId: string) {
  return request<PlatformProjectDocument>(
    `/platform/projects/${encodeURIComponent(projectId)}/document`,
    {},
    token,
  );
}

export function savePlatformProjectDocument(
  token: string,
  projectId: string,
  data: Record<string, unknown>,
  expectedVersion: number,
) {
  return request<PlatformProjectDocument>(
    `/platform/projects/${encodeURIComponent(projectId)}/document`,
    { method: "PUT", body: JSON.stringify({ data, expectedVersion }) },
    token,
  );
}

export function updatePlatformProject(
  token: string,
  projectId: string,
  input: { name: string; description: string; archived?: boolean },
) {
  return request<{ project: PlatformProject }>(
    `/platform/projects/${encodeURIComponent(projectId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
    token,
  );
}

export function getPlatformRevisions(token: string, projectId: string) {
  return request<{ revisions: PlatformRevision[] }>(
    `/platform/projects/${encodeURIComponent(projectId)}/revisions`,
    {},
    token,
  );
}

export function createPlatformRevision(
  token: string,
  projectId: string,
  input: { flow: Record<string, unknown>; environment: Record<string, unknown>; elements: unknown[]; dataset?: unknown; secretNames?: string[] },
) {
  return request<{ revision: PlatformRevision }>(
    `/platform/projects/${encodeURIComponent(projectId)}/revisions`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function publishPlatformRevision(token: string, projectId: string, revisionId: string) {
  return request<{ revisionId: string; status: "published" }>(
    `/platform/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/publish`,
    { method: "POST" },
    token,
  );
}

export function rollbackPlatformRevision(token: string, projectId: string, revisionId: string, note?: string) {
  return request<{ revisionId: string; sourceRevisionId: string; status: "published" }>(
    `/platform/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/rollback`,
    { method: "POST", body: JSON.stringify({ note }) }, token,
  );
}

export function createPlatformRun(token: string, projectId: string, input: { revisionId?: string; environmentId: string; datasetVersionId?: string; upToStepId?: string }) {
  return request<{ run?: PlatformRun; runs: PlatformRun[]; runIds: string[] }>(
    `/platform/projects/${encodeURIComponent(projectId)}/runs`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function savePlatformSecret(token: string, projectId: string, input: { name: string; value: string }) {
  return request<{ secret: { id: string; name: string; keyVersion: number } }>(
    `/platform/projects/${encodeURIComponent(projectId)}/secrets`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export type PlatformRunsQuery = {
  page?: number;
  pageSize?: number;
  status?: string;
  flow?: string;
  source?: "manual" | "schedule" | "webhook";
  from?: string;
  to?: string;
};

export function getPlatformRuns(token: string, projectId: string, query: PlatformRunsQuery = {}) {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.status) params.set("status", query.status);
  if (query.flow) params.set("flow", query.flow);
  if (query.source) params.set("source", query.source);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  const suffix = params.size ? `?${params.toString()}` : "";
  return request<{ runs: PlatformRun[]; total: number; page: number; pageSize: number }>(
    `/platform/projects/${encodeURIComponent(projectId)}/runs${suffix}`,
    {},
    token,
  );
}

export function getPlatformRun(token: string, projectId: string, runId: string) {
  return request<{ run: PlatformRun }>(`/platform/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`, {}, token);
}

export function cancelPlatformRun(token: string, projectId: string, runId: string) {
  return request<{ run: PlatformRun }>(`/platform/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }, token);
}

export function createPlatformElementValidation(
  token: string,
  projectId: string,
  input: { environmentId: string; element: Record<string, unknown> },
) {
  return request<{ validation: PlatformElementValidation }>(
    `/platform/projects/${encodeURIComponent(projectId)}/element-validations`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function getPlatformElementValidation(token: string, projectId: string, validationId: string) {
  return request<{ validation: PlatformElementValidation }>(
    `/platform/projects/${encodeURIComponent(projectId)}/element-validations/${encodeURIComponent(validationId)}`,
    {},
    token,
  );
}

export function platformArtifactUrl(artifactId: string) {
  return `${apiBase}/platform/artifacts/${encodeURIComponent(artifactId)}`;
}

export function platformValidationArtifactUrl(artifactId: string) {
  return `${apiBase}/platform/validation-artifacts/${encodeURIComponent(artifactId)}`;
}

export async function fetchPlatformArtifact(token: string, artifactId: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(platformArtifactUrl(artifactId), { credentials: "include", headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new PlatformApiError(response.status, body.error ?? "PLATFORM_ARTIFACT_FETCH_FAILED");
    }
    return response.blob();
  } catch (error) {
    if (controller.signal.aborted) throw new PlatformApiError(0, "TIMEOUT");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getPlatformDatasets(token: string, projectId: string) {
  return request<{ datasets: PlatformDataset[] }>(`/platform/projects/${encodeURIComponent(projectId)}/datasets`, {}, token);
}

export function importPlatformDataset(
  token: string,
  projectId: string,
  input: { name: string; description?: string; fileName: string; contentBase64: string },
) {
  return request<{ dataset: PlatformDataset; version: PlatformDatasetVersion }>(
    `/platform/projects/${encodeURIComponent(projectId)}/datasets`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function importPlatformDatasetVersion(token: string, projectId: string, datasetId: string, input: { fileName: string; contentBase64: string }) {
  return request<{ version: PlatformDatasetVersion }>(
    `/platform/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/versions`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function getPlatformDatasetVersion(token: string, projectId: string, versionId: string) {
  return request<{ version: PlatformDatasetVersion; rows: Array<{ rowNumber: number; data: Record<string, string> }>; truncated: boolean }>(
    `/platform/projects/${encodeURIComponent(projectId)}/dataset-versions/${encodeURIComponent(versionId)}`,
    {},
    token,
  );
}

export function archivePlatformDataset(token: string, projectId: string, datasetId: string) {
  return request<{ datasetId: string; archived: boolean }>(`/platform/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}`, { method: "DELETE" }, token);
}

export function getPlatformSchedules(token: string, projectId: string) {
  return request<{ schedules: PlatformSchedule[] }>(`/platform/projects/${encodeURIComponent(projectId)}/schedules`, {}, token);
}

export function createPlatformSchedule(token: string, projectId: string, input: { name: string; revisionId: string; environmentId: string; datasetVersionId?: string; cron: string; timezone: string }) {
  return request<{ schedule: PlatformSchedule }>(
    `/platform/projects/${encodeURIComponent(projectId)}/schedules`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function updatePlatformSchedule(token: string, projectId: string, scheduleId: string, input: { name: string; revisionId: string; environmentId: string; datasetVersionId?: string; cron: string; timezone: string }) {
  return request<{ schedule: PlatformSchedule }>(
    `/platform/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(scheduleId)}`,
    { method: "PUT", body: JSON.stringify(input) },
    token,
  );
}

export function scheduleAction(token: string, projectId: string, scheduleId: string, action: "enable" | "disable" | "run") {
  return request<{ enabled?: boolean; runIds?: string[] }>(
    `/platform/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(scheduleId)}/${action}`,
    { method: "POST" },
    token,
  );
}

export function archivePlatformSchedule(token: string, projectId: string, scheduleId: string) {
  return request<{ scheduleId: string; archived: boolean }>(`/platform/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" }, token);
}

export function getPlatformWebhookTriggers(token: string, projectId: string) {
  return request<{ triggers: PlatformWebhookTrigger[] }>(`/platform/projects/${encodeURIComponent(projectId)}/webhook-triggers`, {}, token);
}

export function createPlatformWebhookTrigger(token: string, projectId: string, input: { name: string; revisionId: string; environmentId: string; datasetVersionId?: string }) {
  return request<{ trigger: PlatformWebhookTrigger; triggerUrl: string; signingSecret: string }>(
    `/platform/projects/${encodeURIComponent(projectId)}/webhook-triggers`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function updatePlatformWebhookTrigger(token: string, projectId: string, triggerId: string, input: { name: string; revisionId: string; environmentId: string; datasetVersionId?: string }) {
  return request<{ trigger: PlatformWebhookTrigger }>(
    `/platform/projects/${encodeURIComponent(projectId)}/webhook-triggers/${encodeURIComponent(triggerId)}`,
    { method: "PUT", body: JSON.stringify(input) },
    token,
  );
}

export function rotatePlatformWebhookSecret(token: string, projectId: string, triggerId: string) {
  return request<{ triggerId: string; signingSecret: string }>(
    `/platform/projects/${encodeURIComponent(projectId)}/webhook-triggers/${encodeURIComponent(triggerId)}/rotate-secret`,
    { method: "POST" },
    token,
  );
}

export function webhookTriggerAction(token: string, projectId: string, triggerId: string, action: "enable" | "disable") {
  return request<{ enabled: boolean }>(
    `/platform/projects/${encodeURIComponent(projectId)}/webhook-triggers/${encodeURIComponent(triggerId)}/${action}`,
    { method: "POST" },
    token,
  );
}

export function archivePlatformWebhookTrigger(token: string, projectId: string, triggerId: string) {
  return request<{ triggerId: string; archived: boolean }>(`/platform/projects/${encodeURIComponent(projectId)}/webhook-triggers/${encodeURIComponent(triggerId)}`, { method: "DELETE" }, token);
}

export function getPlatformNotificationChannels(token: string, workspaceId: string) {
  return request<{ channels: PlatformNotificationChannel[] }>(
    `/platform/workspaces/${encodeURIComponent(workspaceId)}/notification-channels`,
    {},
    token,
  );
}

export function createPlatformNotificationChannel(token: string, workspaceId: string, input: { name: string; type: PlatformNotificationChannel["type"]; url: string; keyword?: string }) {
  return request<{ channel: PlatformNotificationChannel }>(
    `/platform/workspaces/${encodeURIComponent(workspaceId)}/notification-channels`,
    { method: "POST", body: JSON.stringify({ name: input.name, type: input.type, config: { url: input.url, ...(input.keyword?.trim() ? { keyword: input.keyword.trim() } : {}) } }) },
    token,
  );
}

export function updatePlatformNotificationChannel(token: string, workspaceId: string, channelId: string, input: { name: string; type: PlatformNotificationChannel["type"]; enabled: boolean; url?: string; keyword?: string }) {
  return request<{ channel: PlatformNotificationChannel }>(
    `/platform/workspaces/${encodeURIComponent(workspaceId)}/notification-channels/${encodeURIComponent(channelId)}`,
    { method: "PUT", body: JSON.stringify({
      name: input.name,
      type: input.type,
      enabled: input.enabled,
      config: input.url?.trim()
        ? { url: input.url, ...(input.keyword?.trim() ? { keyword: input.keyword.trim() } : {}) }
        : undefined,
    }) },
    token,
  );
}

export function testPlatformNotificationChannel(token: string, workspaceId: string, channelId: string) {
  return request<{ tested: true; status: number | null; error: string | null }>(
    `/platform/workspaces/${encodeURIComponent(workspaceId)}/notification-channels/${encodeURIComponent(channelId)}/test`,
    { method: "POST" },
    token,
  );
}

export function archivePlatformNotificationChannel(token: string, workspaceId: string, channelId: string) {
  return request<{ channelId: string; archived: boolean }>(`/platform/workspaces/${encodeURIComponent(workspaceId)}/notification-channels/${encodeURIComponent(channelId)}`, { method: "DELETE" }, token);
}

export function getPlatformNotificationSubscriptions(token: string, projectId: string) {
  return request<{ subscriptions: PlatformNotificationSubscription[] }>(
    `/platform/projects/${encodeURIComponent(projectId)}/notification-subscriptions`,
    {},
    token,
  );
}

export function savePlatformNotificationSubscription(token: string, projectId: string, input: { channelId: string; onSuccess: boolean; onFailure: boolean }) {
  return request<{ channelId: string; onSuccess: boolean; onFailure: boolean }>(
    `/platform/projects/${encodeURIComponent(projectId)}/notification-subscriptions`,
    { method: "PUT", body: JSON.stringify(input) },
    token,
  );
}

export type PlatformDeliveriesQuery = {
  page?: number;
  pageSize?: number;
  status?: string;
  channel?: string;
  from?: string;
  to?: string;
};

export function getPlatformDeliveries(token: string, projectId: string, query: PlatformDeliveriesQuery = {}) {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.status) params.set("status", query.status);
  if (query.channel) params.set("channel", query.channel);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  const suffix = params.size ? `?${params.toString()}` : "";
  return request<{ deliveries: PlatformDelivery[]; total: number; page: number; pageSize: number }>(
    `/platform/projects/${encodeURIComponent(projectId)}/deliveries${suffix}`,
    {},
    token,
  );
}

export function getPlatformAuditEvents(token: string, projectId: string, query: PlatformAuditQuery = {}) {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.action) params.set("action", query.action);
  if (query.actorId) params.set("actorId", query.actorId);
  if (query.actorType) params.set("actorType", query.actorType);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.q) params.set("q", query.q);
  const suffix = params.size ? `?${params.toString()}` : "";
  return request<{ events: PlatformAuditEvent[]; total: number; page: number; pageSize: number }>(`/platform/projects/${encodeURIComponent(projectId)}/audit-events${suffix}`, {}, token);
}

export function getPlatformAnalytics(token: string, projectId: string, query: PlatformAnalyticsQuery = {}) {
  const params = new URLSearchParams();
  if (query.window !== undefined) params.set("window", String(query.window));
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.period) params.set("period", query.period);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.categoryBy) params.set("categoryBy", query.categoryBy);
  const suffix = params.size ? `?${params.toString()}` : "";
  return request<{ analytics: PlatformAnalytics }>(`/platform/projects/${encodeURIComponent(projectId)}/analytics${suffix}`, {}, token);
}
