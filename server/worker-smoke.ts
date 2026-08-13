import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const port = 8790;
const server = spawn(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/d", "/s", "/c", "npm run server"] : ["-c", "npm run server"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
  windowsHide: true,
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Worker is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Worker API did not start");
}

async function waitForTask(path: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    const task = (await response.json()) as {
      status: string;
      result?: Record<string, unknown>;
      artifactIds?: string[];
    };
    if (["success", "failed", "canceled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Worker task timed out");
}

try {
  await waitForHealth();
  const environment = {
    id: "fixture",
    name: "Worker fixture",
    description: "",
    baseUrl: `http://127.0.0.1:${port}`,
    browser: "Chromium",
    auth: "无认证",
    timeout: 10,
    color: "teal",
    updatedAt: "now",
  };
  const element = {
    id: "promo",
    name: "候选按钮",
    description: "",
    path: "/__fixture/multiple",
    method: "CSS",
    value: ".candidate",
    environment: "fixture",
    validation: "unverified" as const,
    updatedAt: "now",
  };
  const validationResponse = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/validations`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment, element }) },
  );
  const { validationId } = (await validationResponse.json()) as { validationId: string };
  const validation = await waitForTask(`/api/projects/fixture-project/validations/${validationId}`);
  if (validation.status !== "success" || validation.result?.count !== 3) {
    throw new Error(`Unexpected validation result: ${JSON.stringify(validation)}`);
  }
  const newProjectValidationResponse = await fetch(
    `http://127.0.0.1:${port}/api/projects/new-project/validations`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment, element }) },
  );
  const { validationId: newProjectValidationId } = (await newProjectValidationResponse.json()) as {
    validationId: string;
  };
  const newProjectValidation = await waitForTask(
    `/api/projects/new-project/validations/${newProjectValidationId}`,
  );
  if (newProjectValidation.status !== "success" || newProjectValidation.result?.count !== 3) {
    throw new Error(`New project validation failed: ${JSON.stringify(newProjectValidation)}`);
  }

  const loginElements = [
    { ...element, id: "account", name: "账号", path: "/__fixture/login", method: "testid", value: "login-account" },
    { ...element, id: "password", name: "密码", path: "/__fixture/login", method: "testid", value: "login-password" },
    { ...element, id: "submit", name: "登录", path: "/__fixture/login", method: "testid", value: "login-submit" },
    { ...element, id: "welcome", name: "欢迎", path: "/__fixture/login", method: "testid", value: "welcome" },
  ];
  const flow = {
    id: "fixture-login",
    name: "Fixture 登录",
    steps: [
      { id: "open", title: "打开", action: "打开页面", value: "/__fixture/login", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "account", title: "填写账号", action: "填写", element: "账号", value: "demo", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "password", title: "填写密码", action: "填写", element: "密码", value: "secret", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "login", title: "登录", action: "点击", element: "登录", value: "", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "assert", title: "断言欢迎", action: "可见性断言", element: "欢迎", value: "", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
    ],
  };
  const runResponse = await fetch(`http://127.0.0.1:${port}/api/projects/fixture-project/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment, flow, elements: loginElements }),
  });
  const { runId } = (await runResponse.json()) as { runId: string };
  const run = await waitForTask(`/api/projects/fixture-project/runs/${runId}`);
  if (run.status !== "success" || run.result?.completedSteps !== 5) {
    throw new Error(`Unexpected run result: ${JSON.stringify(run)}`);
  }
  const traceId = run.artifactIds?.[0];
  if (!traceId) throw new Error("Run did not expose a Trace artifact");
  const artifact = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/artifacts/${traceId}`,
  );
  const foreignProjectArtifact = await fetch(
    `http://127.0.0.1:${port}/api/projects/foreign-project/artifacts/${traceId}`,
  );
  if (!artifact.ok || foreignProjectArtifact.status !== 404) {
    throw new Error(
      `Artifact project isolation check failed: owner=${artifact.status}, foreign=${foreignProjectArtifact.status}`,
    );
  }

  const retryFlow = {
    id: "fixture-retry-policy",
    name: "Fixture retry policy",
    steps: [
      { id: "open", title: "打开", action: "打开页面", value: "/__fixture/retry", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "eventual", title: "等待目标", action: "可见性断言", element: "延迟目标", value: "", timeout: 1, failurePolicy: "重试 1 次", status: "pending" as const },
    ],
  };
  const retryPolicyResponse = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment,
        flow: retryFlow,
        elements: [
          {
            ...element,
            id: "eventual",
            name: "延迟目标",
            path: "/__fixture/retry",
            method: "testid",
            value: "retry-target",
          },
        ],
      }),
    },
  );
  const { runId: retryPolicyRunId } = (await retryPolicyResponse.json()) as { runId: string };
  const retryPolicyRun = await waitForTask(
    `/api/projects/fixture-project/runs/${retryPolicyRunId}`,
  );
  if (retryPolicyRun.status !== "success" || retryPolicyRun.result?.completedSteps !== 2) {
    throw new Error(`Retry policy did not complete: ${JSON.stringify(retryPolicyRun)}`);
  }

  const interpolationFlow = {
    id: "fixture-interpolation",
    name: "Fixture interpolation",
    steps: [
      { id: "open", title: "打开", action: "打开页面", value: "/__fixture/interpolation", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "project", title: "填写项目变量", action: "填写", element: "项目输入", value: "{{project.username}}", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "environment", title: "填写环境变量", action: "填写", element: "环境输入", value: "{{env.region}}", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "apply", title: "应用", action: "点击", element: "应用按钮", value: "", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "assert", title: "验证插值", action: "文本断言", element: "结果", value: "runner|cn-north", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
    ],
  };
  const interpolationResponse = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment,
        flow: interpolationFlow,
        variables: { "project.username": "runner", "env.region": "cn-north" },
        elements: [
          { ...element, id: "project-value", name: "项目输入", path: "/__fixture/interpolation", method: "testid", value: "project-value" },
          { ...element, id: "environment-value", name: "环境输入", path: "/__fixture/interpolation", method: "testid", value: "environment-value" },
          { ...element, id: "apply", name: "应用按钮", path: "/__fixture/interpolation", method: "testid", value: "apply" },
          { ...element, id: "result", name: "结果", path: "/__fixture/interpolation", method: "testid", value: "result" },
        ],
      }),
    },
  );
  const { runId: interpolationRunId } = (await interpolationResponse.json()) as { runId: string };
  const interpolationRun = await waitForTask(
    `/api/projects/fixture-project/runs/${interpolationRunId}`,
  );
  if (interpolationRun.status !== "success" || interpolationRun.result?.completedSteps !== 5) {
    throw new Error(`Variable interpolation failed: ${JSON.stringify(interpolationRun)}`);
  }

  const upToStepFlow = {
    id: "fixture-up-to-step",
    name: "Fixture upToStepId",
    steps: [
      { id: "open", title: "打开", action: "打开页面", value: "/__fixture/login", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "missing", title: "点击缺失元素", action: "点击", element: "缺失元素", value: "", timeout: 1, failurePolicy: "继续执行", status: "pending" as const },
      { id: "must-not-run", title: "不应执行", action: "点击", element: "缺失元素", value: "", timeout: 1, failurePolicy: "立即失败", status: "pending" as const },
    ],
  };
  const upToStepResponse = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment,
        flow: upToStepFlow,
        upToStepId: "missing",
        elements: [{ ...element, id: "missing", name: "缺失元素", path: "/__fixture/login", method: "testid", value: "does-not-exist" }],
      }),
    },
  );
  const { runId: upToStepRunId } = (await upToStepResponse.json()) as { runId: string };
  const upToStepRun = await waitForTask(`/api/projects/fixture-project/runs/${upToStepRunId}`);
  if (upToStepRun.status !== "success" || upToStepRun.result?.completedSteps !== 1) {
    throw new Error(`upToStepId did not stop at the failing target step: ${JSON.stringify(upToStepRun)}`);
  }
  const upToStep404Response = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment,
        flow: upToStepFlow,
        upToStepId: "no-such-step",
        elements: [{ ...element, id: "missing", name: "缺失元素", path: "/__fixture/login", method: "testid", value: "does-not-exist" }],
      }),
    },
  );
  const { runId: upToStep404RunId } = (await upToStep404Response.json()) as { runId: string };
  const upToStep404Run = await waitForTask(`/api/projects/fixture-project/runs/${upToStep404RunId}`);
  if (upToStep404Run.status !== "failed" || upToStep404Run.result?.error !== "RUN_STEP_NOT_FOUND") {
    throw new Error(`Unknown upToStepId did not fail with RUN_STEP_NOT_FOUND: ${JSON.stringify(upToStep404Run)}`);
  }

  const cancelFlow = {
    id: "fixture-cancel",
    name: "Fixture cancel",
    steps: [
      { id: "wait", title: "等待", action: "等待", value: "3000", timeout: 5, failurePolicy: "立即失败", status: "pending" as const },
    ],
  };
  const cancelResponse = await fetch(`http://127.0.0.1:${port}/api/projects/fixture-project/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment, flow: cancelFlow, elements: [] }),
  });
  const { runId: cancelRunId } = (await cancelResponse.json()) as { runId: string };
  const cancelTaskResponse = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/runs/${cancelRunId}/cancel`,
    { method: "POST" },
  );
  if (!cancelTaskResponse.ok) throw new Error("Cancel request was rejected");
  const canceledRun = await waitForTask(`/api/projects/fixture-project/runs/${cancelRunId}`);
  if (canceledRun.status !== "canceled") {
    throw new Error(`Run was not canceled: ${JSON.stringify(canceledRun)}`);
  }

  const failedFlow = {
    id: "fixture-retry-endpoint",
    name: "Fixture retry endpoint",
    steps: [
      { id: "open", title: "打开", action: "打开页面", value: "/__fixture/login", timeout: 10, failurePolicy: "立即失败", status: "pending" as const },
      { id: "missing", title: "点击缺失元素", action: "点击", element: "缺失元素", value: "", timeout: 1, failurePolicy: "立即失败", status: "pending" as const },
    ],
  };
  const failedResponse = await fetch(`http://127.0.0.1:${port}/api/projects/fixture-project/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      environment,
      flow: failedFlow,
      elements: [{ ...element, id: "missing", name: "缺失元素", path: "/__fixture/login", method: "testid", value: "does-not-exist" }],
    }),
  });
  const { runId: failedRunId } = (await failedResponse.json()) as { runId: string };
  const failedRun = await waitForTask(`/api/projects/fixture-project/runs/${failedRunId}`);
  if (failedRun.status !== "failed") throw new Error("Failure fixture unexpectedly passed");
  const retryResponse = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/runs/${failedRunId}/retry`,
    { method: "POST" },
  );
  const { runId: retriedRunId } = (await retryResponse.json()) as { runId: string };
  const retriedRun = await waitForTask(`/api/projects/fixture-project/runs/${retriedRunId}`);
  if (retriedRun.status !== "failed") throw new Error("Retried failure fixture unexpectedly passed");

  const debugFailureResponse = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment: { ...environment, keepBrowserOpenOnFailure: true },
        flow: failedFlow,
        elements: [{ ...element, id: "debug-missing", name: "debug-missing", path: "/__fixture/login", method: "testid", value: "does-not-exist" }],
      }),
    },
  );
  const { runId: debugFailureRunId } = (await debugFailureResponse.json()) as { runId: string };
  let waitingTask: { browserState?: string } | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/projects/fixture-project/runs/${debugFailureRunId}`,
    );
    const task = (await response.json()) as { browserState?: string };
    if (task.browserState === "waiting") {
      waitingTask = task;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!waitingTask) throw new Error("Failed run did not keep its browser open for debugging");
  const stopDebugRun = await fetch(
    `http://127.0.0.1:${port}/api/projects/fixture-project/runs/${debugFailureRunId}/cancel`,
    { method: "POST" },
  );
  if (!stopDebugRun.ok) throw new Error("Failed to stop the retained browser run");
  const stoppedDebugRun = await waitForTask(
    `/api/projects/fixture-project/runs/${debugFailureRunId}`,
  );
  if (stoppedDebugRun.status !== "canceled") {
    throw new Error(`Retained browser run was not canceled: ${JSON.stringify(stoppedDebugRun)}`);
  }

  // --- SSE 生命周期：连接建立、事件回放、断连后进程存活（回归：断连竞态不再击穿进程） ---
  {
    const controller = new AbortController();
    const sseResponse = await fetch(
      `http://127.0.0.1:${port}/api/projects/fixture-project/runs/${runId}/events`,
      { signal: controller.signal },
    );
    if (!sseResponse.ok || !sseResponse.body) throw new Error(`SSE connect failed: ${sseResponse.status}`);
    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    for (let attempt = 0; attempt < 20 && !received.includes("event:"); attempt += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    if (!received.includes("event:")) {
      throw new Error(`SSE did not replay task events: ${JSON.stringify(received.slice(0, 200))}`);
    }
    controller.abort();
    const sseHealth = await fetch(`http://127.0.0.1:${port}/health`);
    if (!sseHealth.ok) throw new Error("Worker crashed after SSE disconnect");
  }

  // --- 双取消：重复 cancel 幂等，不产生重复终态 ---
  {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/fixture-project/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment, flow: cancelFlow, elements: [] }),
    });
    const { runId: doubleCancelRunId } = (await response.json()) as { runId: string };
    const first = await fetch(
      `http://127.0.0.1:${port}/api/projects/fixture-project/runs/${doubleCancelRunId}/cancel`,
      { method: "POST" },
    );
    const second = await fetch(
      `http://127.0.0.1:${port}/api/projects/fixture-project/runs/${doubleCancelRunId}/cancel`,
      { method: "POST" },
    );
    if (!first.ok || !second.ok) throw new Error("Double cancel was not idempotent");
    const doubleCanceled = await waitForTask(`/api/projects/fixture-project/runs/${doubleCancelRunId}`);
    if (doubleCanceled.status !== "canceled") {
      throw new Error(`Double-canceled run ended as ${doubleCanceled.status}`);
    }
  }

  // --- 陈旧产物回归：产物文件缺失时下载返回 404 且进程不崩溃（原 createReadStream 无 error 处理会击穿进程） ---
  {
    const artifactDirectory = join(process.cwd(), "server", ".artifacts");
    const files = readdirSync(artifactDirectory).filter((name) => name.startsWith(`${traceId}.`));
    if (files.length === 0) throw new Error("Expected Trace artifact file on disk");
    unlinkSync(join(artifactDirectory, files[0]));
    const staleResponse = await fetch(
      `http://127.0.0.1:${port}/api/projects/fixture-project/artifacts/${traceId}`,
    );
    if (staleResponse.status !== 404) {
      throw new Error(`Stale artifact download expected 404, got ${staleResponse.status}`);
    }
    const staleHealth = await fetch(`http://127.0.0.1:${port}/health`);
    if (!staleHealth.ok) throw new Error("Worker crashed after stale artifact download");
  }

  console.log("Worker smoke test passed");
} finally {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(killer, "exit").catch(() => undefined);
  } else {
    server.kill();
    await once(server, "exit").catch(() => undefined);
  }
}
