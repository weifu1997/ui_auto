import {
  fixtureElement,
  fixtureEnvironment,
  removeWorkerRoot,
  startWorker,
  stopWorker,
  waitForTask,
  type TestWorker,
} from "./worker-test-utils.ts";

const port = 8792;
let worker: TestWorker | undefined;

try {
  worker = await startWorker({ port, env: { PLAYWRIGHT_LAUNCH_FAILURE: "1" } });
  const response = await fetch(`http://127.0.0.1:${port}/api/projects/launch-failure/validations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      environment: fixtureEnvironment(port),
      element: fixtureElement({
        id: "submit",
        name: "submit",
        path: "/__fixture/login",
        value: "login-submit",
      }),
    }),
  });
  const { validationId } = (await response.json()) as { validationId: string };
  const task = await waitForTask(
    port,
    `/api/projects/launch-failure/validations/${validationId}`,
  );
  if (
    task.status !== "failed" ||
    task.browserState !== "closed" ||
    typeof task.result?.reason !== "string" ||
    !task.result.reason.includes("BROWSER_LAUNCH_FAILED")
  ) {
    throw new Error(`Launch failure did not settle as failed: ${JSON.stringify(task)}`);
  }
  console.log("Worker launch failure smoke test passed");
} finally {
  if (worker) {
    const root = worker.root;
    await stopWorker(worker);
    await removeWorkerRoot(root);
  }
}
