import type { ElementAsset, Environment, FlowStep } from "./mock-data";

const apiBase = (import.meta.env.VITE_WORKER_API_URL ?? (import.meta.env.PROD ? "/api" : "http://127.0.0.1:8787/api")).replace(/\/$/, "");

export type WorkerHealth = {
  ok: boolean;
  queue?: string;
};

export type WorkerTaskEvent = {
  id?: number;
  kind: "status" | "log" | "step" | "result";
  at: string;
  data: Record<string, unknown>;
};

export type WorkerArtifact = {
  id: string;
  name: string;
  contentType: string;
};

export type WorkerTask = {
  id: string;
  projectId: string;
  type: "run" | "validation";
  status: "queued" | "running" | "success" | "failed" | "canceled";
  createdAt: string;
  artifactIds: string[];
  artifacts: WorkerArtifact[];
  summary?: {
    flowName: string;
    environmentName: string;
    totalSteps: number;
    upToStepId?: string;
  };
  result?: Record<string, unknown>;
  browserState?: "queued" | "launching" | "running" | "waiting" | "closing" | "closed";
  queue?: {
    position?: number;
    active: boolean;
  };
  events?: WorkerTaskEvent[];
};

export type RunRequest = {
  environment: Environment;
  flow: { id: string; name: string; steps: FlowStep[] };
  elements: ElementAsset[];
  variables?: Record<string, string>;
  secretKeys?: string[];
  upToStepId?: string;
};

export class WorkerApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "WorkerApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new WorkerApiError(response.status, body?.error ?? `WORKER_API_${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getWorkerHealth(signal?: AbortSignal) {
  // 生产模式 apiBase 是相对路径 /api，必须带 base 构造 origin（否则 new URL 抛 TypeError，健康检查恒失败）。
  const response = await fetch(`${new URL(apiBase, window.location.origin).origin}/health`, { signal });
  if (!response.ok) throw new WorkerApiError(response.status, `WORKER_HEALTH_${response.status}`);
  return (await response.json()) as WorkerHealth;
}

export function artifactUrl(projectId: string, artifactId: string) {
  return `${apiBase}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export async function createRun(projectId: string, payload: RunRequest) {
  return request<{ runId: string }>(`/projects/${encodeURIComponent(projectId)}/runs`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export type LocalPickerSession = {
  id: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  currentUrl: string;
  status: string;
  captureCount: number;
  hasScreenshot: boolean;
};

export type LocalPickerCandidate = {
  method: "testid" | "role" | "label" | "text" | "css";
  value: string;
  count: number;
  score: number;
  label: string;
};

export type LocalPickerCapture = {
  id: string;
  sessionId: string;
  target: string;
  capturedAt: string;
  candidates: LocalPickerCandidate[];
};

export type LocalPickerFillback = {
  target: "fillback";
  candidate: LocalPickerCandidate;
  path: string;
  environmentId: string;
  suggestedName: string;
};

export async function createLocalPickerSession(projectId: string, environment: Environment, startUrl?: string) {
  return request<{ session: LocalPickerSession }>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions`,
    { method: "POST", body: JSON.stringify({ environment, startUrl }) },
  );
}

export async function getLocalPickerSessions(projectId: string) {
  return request<{ sessions: LocalPickerSession[] }>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions`,
  );
}

export async function enableLocalPicker(projectId: string, sessionId: string) {
  return request<{ session: LocalPickerSession }>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions/${encodeURIComponent(sessionId)}/picker/enable`,
    { method: "POST" },
  );
}

export async function getLocalPickerCaptures(projectId: string, sessionId: string) {
  return request<{ captures: LocalPickerCapture[] }>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions/${encodeURIComponent(sessionId)}/picker-captures`,
  );
}

export async function previewLocalPickerCandidate(projectId: string, sessionId: string, captureId: string, candidateIndex: number) {
  return request<{ captureId: string; candidateIndex: number; count: number }>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions/${encodeURIComponent(sessionId)}/picker-captures/${encodeURIComponent(captureId)}/preview`,
    { method: "POST", body: JSON.stringify({ candidateIndex }) },
  );
}

export async function confirmLocalPickerCandidate(
  projectId: string,
  sessionId: string,
  captureId: string,
  input: { candidateIndex: number; name?: string },
) {
  return request<LocalPickerFillback>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions/${encodeURIComponent(sessionId)}/picker-captures/${encodeURIComponent(captureId)}/confirm`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function stopLocalPickerSession(projectId: string, sessionId: string) {
  return request<{ ended: boolean }>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions/${encodeURIComponent(sessionId)}/commands`,
    { method: "POST", body: JSON.stringify({ command: "stop" }) },
  );
}

export function localPickerScreenshotUrl(projectId: string, sessionId: string) {
  return `${apiBase}/projects/${encodeURIComponent(projectId)}/local-picker/sessions/${encodeURIComponent(sessionId)}/screenshot`;
}

export async function createValidation(
  projectId: string,
  environment: Environment,
  element: ElementAsset,
) {
  return request<{ validationId: string }>(
    `/projects/${encodeURIComponent(projectId)}/validations`,
    { method: "POST", body: JSON.stringify({ environment, element }) },
  );
}

export async function getRun(projectId: string, runId: string) {
  return request<WorkerTask>(`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`);
}

export async function cancelRun(projectId: string, runId: string) {
  return request<WorkerTask>(
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
}

export async function retryRun(projectId: string, runId: string) {
  return request<{ runId: string }>(
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/retry`,
    { method: "POST" },
  );
}

export function subscribeToTask(
  projectId: string,
  type: "runs" | "validations",
  taskId: string,
  onEvent: (event: WorkerTaskEvent) => void,
  onError?: () => void,
) {
  const source = new EventSource(
    `${apiBase}/projects/${encodeURIComponent(projectId)}/${type}/${encodeURIComponent(taskId)}/events`,
  );
  for (const kind of ["status", "log", "step", "result"] as const) {
    source.addEventListener(kind, (event) => {
      const message = JSON.parse((event as MessageEvent<string>).data) as WorkerTaskEvent;
      onEvent(message);
    });
  }
  source.onerror = () => {
    source.close();
    onError?.();
  };
  return () => source.close();
}
