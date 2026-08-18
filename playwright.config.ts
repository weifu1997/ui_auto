import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = mkdtempSync(join(tmpdir(), "autoflow-e2e-"));
const productionEnvironment = {
  PLATFORM_DATA_DIRECTORY: join(testRoot, "data"),
  PLATFORM_ARTIFACT_DIRECTORY: join(testRoot, "artifacts"),
  PLATFORM_SECRET_KEY: "playwright-production-secret",
};

export default defineConfig({
  testDir: "./tests",
  timeout: 20_000,
  workers: 1,
  outputDir: join(testRoot, "test-results"),
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:8787/health",
    env: productionEnvironment,
    reuseExistingServer: false,
  },
});
