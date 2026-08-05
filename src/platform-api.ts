const apiBase = (import.meta.env.VITE_WORKER_API_URL ?? "http://127.0.0.1:8787/api").replace(/\/$/, "");

export function platformApiOrigin() {
  return new URL(apiBase).origin;
}

export type PlatformAgent = {
  id: string;
  workspaceId: string;
  name: string;
  status: "online" | "offline" | "disabled";
  browserVersion: string;
  os: string;
  maxConcurrency: number;
  currentTask: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};

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

export type PlatformRevision = {
  id: string;
  flowId?: string;
  flowName?: string;
  revisionNumber: number;
  status: "draft" | "published" | "superseded";
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
  status: "queued" | "dispatched" | "running" | "success" | "failed" | "canceled";
  snapshot: Record<string, unknown>;
  result?: Record<string, unknown>;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
  lease?: { id: string; runId: string; agentId: string; status: string; expiresAt: string; attempt: number; expired: boolean };
  agent?: { id: string; name: string; browserVersion: string; os: string; maxConcurrency: number; lastSeenAt: string | null };
  artifacts: Array<{ id: string; name: string; contentType: string; createdAt: string }>;
  events: Array<{ id: number; kind: string; data: Record<string, unknown>; at: string }>;
  flowOutputs: Array<{ name: string; value: string; source: string; createdAt: string }>;
};

export type PlatformDebugSession = {
  id: string;
  projectId: string;
  revisionId: string;
  environmentId: string;
  agentId: string;
  status: "requested" | "active" | "paused" | "ending" | "ended" | "failed" | "expired";
  currentStep: number;
  currentUrl: string | null;
  idleExpiresAt: string;
  maxExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  agent?: { id: string; name: string; browserVersion: string; os: string; lastSeenAt: string | null };
  artifacts: Array<{ id: string; name: string; contentType: string; createdAt: string }>;
  events: Array<{ id: number; kind: string; data: Record<string, unknown>; at: string }>;
};

export type PlatformElementValidation = {
  id: string;
  projectId: string;
  environmentId: string;
  agentId: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  element: Record<string, unknown>;
  result?: { count: number; firstMatch?: string; elapsedMs: number };
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type PlatformPickerCapture = {
  id: string;
  sessionId: string;
  target: string;
  status: "pending" | "confirmed";
  capturedAt: string;
  confirmedAt: string | null;
  candidates: Array<{
    method: "testid" | "role" | "label" | "text" | "css";
    value: string;
    count: number;
    score: number;
    label: string;
  }>;
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

export type PlatformAnalytics = {
  summary: { totalRuns: number; successRate: number; failedRuns: number };
  trend: Array<{ date: string; total: number; success: number; failed: number; canceled: number }>;
  failureCategories: Array<{ category: string; count: number }>;
  slowSteps: Array<{ stepId: string; title: string; count: number; averageMs: number; maxMs: number }>;
  elementImpact: Array<{ elementId: string; name: string; runCount: number; flowCount: number; failedRuns: number; lastUsedAt: string }>;
};

export type PlatformMember = { id: string; email: string; name: string; role: "owner" | "admin" | "editor" | "viewer" };
export type PlatformAuditEvent = { id: string; actorType: string; actorId: string; action: string; targetType: string; targetId: string; detail: Record<string, unknown>; createdAt: string };

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

async function request<T>(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new PlatformApiError(response.status, body.error ?? "PLATFORM_REQUEST_FAILED");
  return body;
}

export async function loginPlatform(input: { email: string; password: string; name?: string }) {
  const login = await request<{ token: string; user: PlatformSession["user"] }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const session = await request<Omit<PlatformSession, "token">>("/auth/session", {}, login.token);
  return { ...session, token: login.token } satisfies PlatformSession;
}

export async function registerPlatform(input: { email: string; password: string; name?: string; invitationToken?: string }) {
  const registration = await request<{ token: string; user: PlatformSession["user"] }>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const session = await request<Omit<PlatformSession, "token">>("/auth/session", {}, registration.token);
  return { ...session, token: registration.token } satisfies PlatformSession;
}

export function getPlatformAgents(token: string, workspaceId: string) {
  return request<{ agents: PlatformAgent[] }>(`/agents?workspaceId=${encodeURIComponent(workspaceId)}`, {}, token);
}

export function createAgentRegistrationToken(token: string, workspaceId: string) {
  return request<{ registrationToken: string; expiresAt: string }>(
    "/agent-tokens",
    { method: "POST", body: JSON.stringify({ workspaceId, expiresInMinutes: 30 }) },
    token,
  );
}

export function getAgentBindings(token: string, projectId: string) {
  return request<{
    bindings: Array<{
      environmentId: string;
      agent: Pick<PlatformAgent, "id" | "name" | "status" | "browserVersion" | "lastSeenAt">;
    }>;
  }>(`/platform/projects/${encodeURIComponent(projectId)}/agent-bindings`, {}, token);
}

export function bindAgent(token: string, projectId: string, environmentId: string, agentId: string) {
  return request<{ projectId: string; environmentId: string; agentId: string }>(
    `/platform/projects/${encodeURIComponent(projectId)}/agent-bindings`,
    { method: "PUT", body: JSON.stringify({ environmentId, agentId }) },
    token,
  );
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

export function getWorkspaceProjects(token: string, workspaceId: string) {
  return request<{ projects: PlatformProject[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/projects`,
    {},
    token,
  );
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

export function createPlatformRun(token: string, projectId: string, input: { revisionId: string; environmentId: string; datasetVersionId?: string; upToStepId?: string }) {
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

export function getPlatformRuns(token: string, projectId: string) {
  return request<{ runs: PlatformRun[] }>(`/platform/projects/${encodeURIComponent(projectId)}/runs`, {}, token);
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

export async function fetchPlatformArtifact(token: string, artifactId: string) {
  const response = await fetch(platformArtifactUrl(artifactId), { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new PlatformApiError(response.status, body.error ?? "PLATFORM_ARTIFACT_FETCH_FAILED");
  }
  return response.blob();
}

export function getDebugSessions(token: string, projectId: string) {
  return request<{ sessions: PlatformDebugSession[] }>(
    `/platform/projects/${encodeURIComponent(projectId)}/debug-sessions`,
    {},
    token,
  );
}

export function createDebugSession(
  token: string,
  projectId: string,
  input: { revisionId: string; environmentId: string; startStep?: number },
) {
  return request<{ session: PlatformDebugSession }>(
    `/platform/projects/${encodeURIComponent(projectId)}/debug-sessions`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function sendDebugCommand(
  token: string,
  projectId: string,
  sessionId: string,
  command: "start" | "continue" | "runCurrent" | "skip" | "pause" | "retry" | "stop",
) {
  return request<{ session: PlatformDebugSession }>(
    `/platform/projects/${encodeURIComponent(projectId)}/debug-sessions/${encodeURIComponent(sessionId)}/commands`,
    { method: "POST", body: JSON.stringify({ command }) },
    token,
  );
}

export function debugArtifactUrl(artifactId: string) {
  return `${apiBase}/platform/debug-artifacts/${encodeURIComponent(artifactId)}`;
}

export async function fetchDebugArtifact(token: string, artifactId: string) {
  const response = await fetch(debugArtifactUrl(artifactId), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new PlatformApiError(response.status, body.error ?? "DEBUG_ARTIFACT_FETCH_FAILED");
  }
  return response.blob();
}

export function enableElementPicker(token: string, projectId: string, sessionId: string) {
  return request<{ session: PlatformDebugSession }>(
    `/platform/projects/${encodeURIComponent(projectId)}/debug-sessions/${encodeURIComponent(sessionId)}/picker/enable`,
    { method: "POST" },
    token,
  );
}

export function getPickerCaptures(token: string, projectId: string, sessionId: string) {
  return request<{ captures: PlatformPickerCapture[] }>(
    `/platform/projects/${encodeURIComponent(projectId)}/debug-sessions/${encodeURIComponent(sessionId)}/picker-captures`,
    {},
    token,
  );
}

export function previewPickerCandidate(token: string, projectId: string, sessionId: string, captureId: string, candidateIndex: number) {
  return request<{ candidateIndex: number }>(
    `/platform/projects/${encodeURIComponent(projectId)}/debug-sessions/${encodeURIComponent(sessionId)}/picker-captures/${encodeURIComponent(captureId)}/preview`,
    { method: "POST", body: JSON.stringify({ candidateIndex }) },
    token,
  );
}

export function confirmPickerCandidate(
  token: string,
  projectId: string,
  sessionId: string,
  captureId: string,
  input: { candidateIndex: number; target: "element" | "step"; name?: string; flowId?: string; stepId?: string },
) {
  return request<{ element: PlatformElement; documentVersion: number; target: "element" | "step" }>(
    `/platform/projects/${encodeURIComponent(projectId)}/debug-sessions/${encodeURIComponent(sessionId)}/picker-captures/${encodeURIComponent(captureId)}/confirm`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
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

export function scheduleAction(token: string, projectId: string, scheduleId: string, action: "enable" | "disable" | "run") {
  return request<{ enabled?: boolean; runIds?: string[] }>(
    `/platform/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(scheduleId)}/${action}`,
    { method: "POST" },
    token,
  );
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

export function webhookTriggerAction(token: string, projectId: string, triggerId: string, action: "enable" | "disable") {
  return request<{ enabled: boolean }>(
    `/platform/projects/${encodeURIComponent(projectId)}/webhook-triggers/${encodeURIComponent(triggerId)}/${action}`,
    { method: "POST" },
    token,
  );
}

export function getPlatformNotificationChannels(token: string, workspaceId: string) {
  return request<{ channels: PlatformNotificationChannel[] }>(
    `/platform/workspaces/${encodeURIComponent(workspaceId)}/notification-channels`,
    {},
    token,
  );
}

export function createPlatformNotificationChannel(token: string, workspaceId: string, input: { name: string; type: PlatformNotificationChannel["type"]; url: string }) {
  return request<{ channel: PlatformNotificationChannel }>(
    `/platform/workspaces/${encodeURIComponent(workspaceId)}/notification-channels`,
    { method: "POST", body: JSON.stringify({ name: input.name, type: input.type, config: { url: input.url } }) },
    token,
  );
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

export function getPlatformDeliveries(token: string, projectId: string) {
  return request<{ deliveries: PlatformDelivery[] }>(`/platform/projects/${encodeURIComponent(projectId)}/deliveries`, {}, token);
}

export function getPlatformAnalytics(token: string, projectId: string) {
  return request<{ analytics: PlatformAnalytics }>(`/platform/projects/${encodeURIComponent(projectId)}/analytics`, {}, token);
}

export function getPlatformAuditEvents(token: string, projectId: string) {
  return request<{ events: PlatformAuditEvent[] }>(`/platform/projects/${encodeURIComponent(projectId)}/audit-events`, {}, token);
}

export function getWorkspaceMembers(token: string, workspaceId: string) {
  return request<{ members: PlatformMember[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, {}, token);
}

export function addWorkspaceMember(token: string, workspaceId: string, input: { email: string; name?: string; role: PlatformMember["role"] }) {
  return request<{ member: PlatformMember; invitationToken?: string; invitationExpiresAt?: string }>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, { method: "POST", body: JSON.stringify(input) }, token);
}

export function updateWorkspaceMember(token: string, workspaceId: string, memberId: string, role: PlatformMember["role"]) {
  return request<{ memberId: string; role: PlatformMember["role"] }>(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`, { method: "PATCH", body: JSON.stringify({ role }) }, token);
}
