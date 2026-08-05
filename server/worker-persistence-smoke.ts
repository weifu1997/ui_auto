import {
  fixtureElement,
  fixtureEnvironment,
  removeWorkerRoot,
  startWorker,
  stopWorker,
  waitForTask,
  type TestWorker,
} from "./worker-test-utils.ts";

const port = 8791;
let worker: TestWorker | undefined;
let root: string | undefined;

try {
  worker = await startWorker({ port });
  root = worker.root;
  const environment = fixtureEnvironment(port);
  const elements = [
    fixtureElement({ id: "submit", name: "submit", path: "/__fixture/login", value: "login-submit" }),
    fixtureElement({ id: "welcome", name: "welcome", path: "/__fixture/login", value: "welcome" }),
  ];
  const flow = {
    id: "persistence-flow",
    name: "Persistence fixture",
    steps: [
      { id: "open", title: "open", action: "打开页面", value: "/__fixture/login", timeout: 10, failurePolicy: "立即失败", status: "pending" },
      { id: "submit", title: "submit", action: "点击", element: "submit", value: "", timeout: 10, failurePolicy: "立即失败", status: "pending" },
      { id: "welcome", title: "assert welcome", action: "可见性断言", element: "welcome", value: "", timeout: 10, failurePolicy: "立即失败", status: "pending" },
    ],
  };
  const created = await fetch(`http://127.0.0.1:${port}/api/projects/restart-project/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment, flow, elements }),
  });
  const { runId } = (await created.json()) as { runId: string };
  const completed = await waitForTask(port, `/api/projects/restart-project/runs/${runId}`);
  const traceId = completed.artifacts?.find((artifact) => artifact.name === "trace.zip")?.id;
  if (completed.status !== "success" || !traceId) {
    throw new Error(`Initial task did not produce a trace: ${JSON.stringify(completed)}`);
  }

  await stopWorker(worker);
  worker = await startWorker({ port, root });

  const restored = await fetch(`http://127.0.0.1:${port}/api/projects/restart-project/runs/${runId}`);
  const task = (await restored.json()) as typeof completed;
  if (!restored.ok || task.status !== "success" || task.events?.length === 0) {
    throw new Error(`Run was not restored after restart: ${JSON.stringify(task)}`);
  }
  const artifact = await fetch(
    `http://127.0.0.1:${port}/api/projects/restart-project/artifacts/${traceId}`,
  );
  if (!artifact.ok) throw new Error(`Trace artifact was not restored: ${artifact.status}`);
  console.log("Worker persistence smoke test passed");
} finally {
  if (worker) await stopWorker(worker);
  if (root) await removeWorkerRoot(root);
}
