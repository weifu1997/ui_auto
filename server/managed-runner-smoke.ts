import { removeWorkerRoot, startWorker, stopWorker, type TestWorker } from "./worker-test-utils";

const port = 8797;
let worker: TestWorker | undefined;
let root: string | undefined;

type ApiResult<T> = { response: Response; body: T };

async function api<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { response, body: await response.json() as T };
}

function authenticated(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function waitForRun(token: string, projectId: string, runId: string, statuses: string[]) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await api<{ run: { status: string; executorType: string; result?: { error?: string }; artifacts: Array<{ name: string }> } }>(`/api/platform/projects/${projectId}/runs/${runId}`, { headers: authenticated(token) });
    if (statuses.includes(response.body.run.status)) return response.body.run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Managed run ${runId} did not reach ${statuses.join(", ")}`);
}

async function waitForValidation(token: string, projectId: string, validationId: string) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await api<{ validation: { status: string; result?: { count: number; screenshotId?: string }; error?: string } }>(`/api/platform/projects/${projectId}/element-validations/${validationId}`, { headers: authenticated(token) });
    if (["success", "failed", "canceled"].includes(response.body.validation.status)) return response.body.validation;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Managed validation ${validationId} did not finish`);
}

try {
  worker = await startWorker({ port, env: { PLATFORM_SECRET_KEY: "managed-runner-smoke-secret", MANAGED_RUNNER_HEADLESS: "1" } });
  root = worker.root;
  const registration = await api<{ token: string }>("/api/auth/register", { method: "POST", body: JSON.stringify({ email: "managed@example.test", name: "Managed", password: "development-password" }) });
  const token = registration.body.token;
  const session = await api<{ workspaces: Array<{ id: string }> }>("/api/auth/session", { headers: authenticated(token) });
  const workspaceId = session.body.workspaces[0]?.id;
  const project = await api<{ project: { id: string } }>(`/api/workspaces/${workspaceId}/projects`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ name: "Managed smoke" }) });
  const projectId = project.body.project.id;
  const environment = { id: "managed-local", name: "Managed local", description: "", baseUrl: `http://127.0.0.1:${port}`, browser: "Chromium", auth: "无认证", timeout: 5, color: "teal", updatedAt: "now" };
  const flow = {
    id: "managed-flow",
    name: "Managed flow",
    steps: [
      { id: "open", title: "Open fixture", action: "打开页面", value: "/__fixture/login", timeout: 5, failurePolicy: "停止流程", status: "pending" },
      { id: "assert", title: "Assert login", action: "文本断言", element: "fixture-title", value: "Fixture login", timeout: 5, failurePolicy: "停止流程", status: "pending" },
    ],
  };
  const element = { id: "fixture-title", name: "fixture-title", description: "", path: "/__fixture/login", method: "css", value: "h1", environment: environment.id, validation: "unverified", updatedAt: "now" };
  const environmentResource = await api(`/api/platform/projects/${projectId}/resources/environments`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ id: environment.id, data: environment }) });
  if (!environmentResource.response.ok) throw new Error("Managed validation environment setup failed");
  const revision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ flow, environment, elements: [element] }) });
  await api(`/api/platform/projects/${projectId}/revisions/${revision.body.revision.id}/publish`, { method: "POST", headers: authenticated(token) });

  const created = await api<{ runIds: string[] }>(`/api/platform/projects/${projectId}/runs`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ revisionId: revision.body.revision.id, environmentId: environment.id }) });
  const completed = await waitForRun(token, projectId, created.body.runIds[0], ["success", "failed"]);
  if (completed.status !== "success" || completed.executorType !== "managed" || !completed.artifacts.some((artifact) => artifact.name === "trace.zip")) {
    throw new Error(`Managed execution did not complete with Trace: ${JSON.stringify(completed)}`);
  }

  const validationCreated = await api<{ validation: { id: string } }>(`/api/platform/projects/${projectId}/element-validations`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ environmentId: environment.id, element }) });
  if (!validationCreated.response.ok || !validationCreated.body.validation?.id) throw new Error("Managed element validation was not queued");
  const validation = await waitForValidation(token, projectId, validationCreated.body.validation.id);
  if (validation.status !== "success" || validation.result?.count !== 1 || !validation.result.screenshotId) throw new Error(`Managed element validation failed: ${JSON.stringify(validation)}`);
  const validationScreenshot = await fetch(`http://127.0.0.1:${port}/api/platform/validation-artifacts/${validation.result.screenshotId}`, { headers: authenticated(token) });
  if (!validationScreenshot.ok || validationScreenshot.headers.get("content-type") !== "image/png" || (await validationScreenshot.arrayBuffer()).byteLength < 100) throw new Error("Managed validation screenshot was not readable");

  const waitingFlow = { ...flow, id: "cancel-flow", name: "Cancel flow", steps: [{ id: "wait", title: "Wait", action: "等待", value: "10000", timeout: 10, failurePolicy: "停止流程", status: "pending" }] };
  const waitingRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ flow: waitingFlow, environment, elements: [] }) });
  await api(`/api/platform/projects/${projectId}/revisions/${waitingRevision.body.revision.id}/publish`, { method: "POST", headers: authenticated(token) });
  const waitingRun = await api<{ runIds: string[] }>(`/api/platform/projects/${projectId}/runs`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ revisionId: waitingRevision.body.revision.id, environmentId: environment.id }) });
  await waitForRun(token, projectId, waitingRun.body.runIds[0], ["running"]);
  await api(`/api/platform/projects/${projectId}/runs/${waitingRun.body.runIds[0]}/cancel`, { method: "POST", headers: authenticated(token) });
  const canceled = await waitForRun(token, projectId, waitingRun.body.runIds[0], ["canceled"]);
  if (canceled.status !== "canceled") throw new Error("Managed cancellation did not terminate the run");

  console.log("ManagedRunner smoke test passed");
} finally {
  if (worker) await stopWorker(worker);
  if (root) await removeWorkerRoot(root);
}
