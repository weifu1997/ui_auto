import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  fixtureElement,
  fixtureEnvironment,
  removeWorkerRoot,
  startWorker,
  stopWorker,
  waitForTask,
  type TestWorker,
} from "./worker-test-utils.ts";

const port = 8793;
const secret = "secret-value-that-must-not-persist";
let worker: TestWorker | undefined;

try {
  worker = await startWorker({ port });
  const environment = fixtureEnvironment(port);
  const elements = [
    fixtureElement({ id: "input", name: "input", path: "/__fixture/interpolation", value: "project-value" }),
    fixtureElement({ id: "result", name: "result", path: "/__fixture/interpolation", value: "result" }),
  ];
  const flow = {
    id: "secret-flow",
    name: "Secret fixture",
    steps: [
      { id: "open", title: "open", action: "打开页面", value: "/__fixture/interpolation", timeout: 10, failurePolicy: "立即失败", status: "pending" },
      { id: "fill", title: "fill secret", action: "填写", element: "input", value: "{{project.password}}", timeout: 10, failurePolicy: "立即失败", status: "pending" },
      { id: "assert", title: "force failure", action: "文本断言", element: "result", value: "{{project.password}}", timeout: 10, failurePolicy: "立即失败", status: "pending" },
    ],
  };
  const response = await fetch(`http://127.0.0.1:${port}/api/projects/secret-project/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      environment,
      flow,
      elements,
      variables: { "project.password": secret },
      secretKeys: ["project.password"],
    }),
  });
  const { runId } = (await response.json()) as { runId: string };
  const task = await waitForTask(port, `/api/projects/secret-project/runs/${runId}`);
  const responseText = JSON.stringify(task);
  if (task.status !== "failed" || responseText.includes(secret) || task.artifactIds?.length) {
    throw new Error(`Sensitive task leaked data or artifacts: ${responseText}`);
  }

  const database = new DatabaseSync(join(worker.root, "data", "autoflow.sqlite"));
  const storedTask = database
    .prepare("SELECT request, result FROM worker_tasks WHERE id = ?")
    .get(runId) as { request: string; result: string | null } | undefined;
  const storedEvents = database
    .prepare("SELECT data FROM worker_events WHERE task_id = ?")
    .all(runId) as Array<{ data: string }>;
  database.close();
  const storedText = JSON.stringify({ storedTask, storedEvents });
  if (!storedTask || storedText.includes(secret) || !storedText.includes("***")) {
    throw new Error(`Sensitive task was persisted without redaction: ${storedText}`);
  }

  const retry = await fetch(
    `http://127.0.0.1:${port}/api/projects/secret-project/runs/${runId}/retry`,
    { method: "POST" },
  );
  const retryBody = (await retry.json()) as { error?: string };
  if (retry.status !== 409 || retryBody.error !== "RUN_SECRETS_REQUIRED") {
    throw new Error(`Sensitive retry did not require fresh secrets: ${JSON.stringify(retryBody)}`);
  }
  console.log("Worker secret smoke test passed");
} finally {
  if (worker) {
    const root = worker.root;
    await stopWorker(worker);
    await removeWorkerRoot(root);
  }
}
