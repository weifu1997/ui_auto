import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = mkdtempSync(join(tmpdir(), "autoflow-e2e-"));
const workerEnvironment = {
  WORKER_DATA_DIRECTORY: join(testRoot, "data"),
  WORKER_ARTIFACT_DIRECTORY: join(testRoot, "artifacts"),
};

export default defineConfig({
  testDir: "./tests",
  timeout: 20_000,
  workers: 1,
  outputDir: join(testRoot, "test-results"),
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run server:py",
      url: "http://127.0.0.1:8787/health",
      env: workerEnvironment,
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4174",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: true,
    },
  ],
});
