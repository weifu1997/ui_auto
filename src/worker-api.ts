import type { ElementAsset, Environment } from "./mock-data";

const apiBase = (import.meta.env.VITE_WORKER_API_URL ?? (import.meta.env.PROD ? "/api" : "http://127.0.0.1:8787/api")).replace(/\/$/, "");

export async function getWorkerHealth(signal?: AbortSignal) {
  const response = await fetch(`${apiBase}/health`, { signal, credentials: "include" });
  if (!response.ok) throw new PlatformApiError(response.status, `WORKER_HEALTH_${response.status}`);
  return (await response.json()) as { ok: boolean; queue?: string };
}

export class PlatformApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(`[${status}] ${code}`);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    credentials: "include",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new PlatformApiError(response.status, body.error ?? "WORKER_REQUEST_FAILED");
  }
  return (await response.json()) as T;
}

export type LocalPickerSession = {
  id: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  status: "starting" | "running" | "recording" | "stopped" | "failed";
  currentUrl: string;
  createdAt: number;
  elementCount: number;
};

export type LocalPickerCandidate = {
  method: string;
  value: string;
  count: number;
  score: number;
  label: string;
};

export type LocalPickerCapture = {
  id: string;
  seq: number;
  tag: string;
  text: string;
  candidates: LocalPickerCandidate[];
  previewElementCount?: number;
  previewScreenshotUrl?: string;
};

export type LocalPickerFillback = {
  capture: LocalPickerCapture;
  candidate: LocalPickerCandidate;
  path: string;
  environmentId: string;
  suggestedName: string;
};

export async function createLocalPickerSession(
  projectId: string,
  environment: Environment,
  startUrl?: string,
) {
  return request<{ session: LocalPickerSession }>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        environmentId: environment.id,
        startUrl: startUrl ?? environment.baseUrl,
      }),
    },
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
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function getLocalPickerCaptures(projectId: string, sessionId: string) {
  return request<{ captures: LocalPickerCapture[] }>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions/${encodeURIComponent(sessionId)}/picker-captures`,
  );
}

export async function previewLocalPickerCandidate(
  projectId: string,
  sessionId: string,
  captureId: string,
  candidateIndex: number,
) {
  return request<{ ok: boolean }>(
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
  return request<{ ok: boolean }>(
    `/projects/${encodeURIComponent(projectId)}/local-picker/sessions/${encodeURIComponent(sessionId)}/commands`,
    { method: "POST", body: JSON.stringify({ command: "stop" }) },
  );
}

export function localPickerScreenshotUrl(projectId: string, sessionId: string) {
  return `${apiBase}/projects/${encodeURIComponent(projectId)}/local-picker/sessions/${encodeURIComponent(sessionId)}/screenshot`;
}

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
  queue?: { position?: number; active: boolean };
  events?: WorkerTaskEvent[];
};

export type RunRequest = {
  environment: Environment;
  flow: { id: string; name: string; steps: Array<{ id: string; title: string; action: string; value?: string; element?: string }> };
  elements: ElementAsset[];
  variables?: Record<string, string>;
};
