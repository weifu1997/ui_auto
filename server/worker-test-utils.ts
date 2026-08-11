import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type WorkerProcess = ReturnType<typeof spawn>;

export type TestWorker = {
  port: number;
  root: string;
  childProcess: WorkerProcess;
};

export type WorkerTask = {
  status: "queued" | "running" | "success" | "failed" | "canceled";
  browserState?: string;
  result?: Record<string, unknown>;
  artifactIds?: string[];
  artifacts?: Array<{ id: string; name: string }>;
  events?: Array<{ data: Record<string, unknown> }>;
};

export async function createWorkerRoot() {
  return mkdtemp(join(tmpdir(), "autoflow-worker-"));
}

export async function startWorker(input: {
  port: number;
  root?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const root = input.root ?? (await createWorkerRoot());
  const command = process.platform === "win32" ? "cmd.exe" : "sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm run server"] : ["-c", "npm run server"];
  const childProcess = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...input.env,
      PORT: String(input.port),
      WORKER_DATA_DIRECTORY: join(root, "data"),
      WORKER_ARTIFACT_DIRECTORY: join(root, "artifacts"),
      PLATFORM_ARTIFACT_DIRECTORY: join(root, "platform-artifacts"),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const worker = { port: input.port, root, childProcess };
  await waitForHealth(worker.port);
  return worker;
}

export async function stopWorker(worker: TestWorker) {
  if (worker.childProcess.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(worker.childProcess.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(killer, "exit").catch(() => undefined);
  } else {
    worker.childProcess.kill();
    await once(worker.childProcess, "exit").catch(() => undefined);
  }
}

export async function removeWorkerRoot(root: string) {
  await rm(root, { recursive: true, force: true });
}

export async function waitForHealth(port: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { ok?: boolean };
        if (body.ok === true) return;
      }
    } catch {
      // The Worker is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Worker API did not start");
}

export async function waitForTask(port: number, path: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    if (response.ok) {
      const task = (await response.json()) as WorkerTask;
      if (["success", "failed", "canceled"].includes(task.status)) return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Worker task timed out: ${path}`);
}

export function fixtureEnvironment(port: number) {
  return {
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
}

export function fixtureElement(input: {
  id: string;
  name: string;
  path: string;
  value: string;
}) {
  return {
    ...input,
    description: "",
    method: "testid",
    environment: "fixture",
    validation: "unverified" as const,
    updatedAt: "now",
  };
}
