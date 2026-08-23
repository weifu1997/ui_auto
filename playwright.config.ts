import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = mkdtempSync(join(tmpdir(), "autoflow-e2e-"));
const productionEnvironment = {
  PLATFORM_DATA_DIRECTORY: join(testRoot, "data"),
  PLATFORM_SECRET_KEY: "playwright-production-secret",
};

export default defineConfig({
  testDir: "./e2e",
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
    // 先为全新数据目录引导一个本地 super-admin（真实后端的契约冒烟测试需要
    // 登录态），再启动生产服务器。数据目录每次运行都是新临时目录，bootstrap
    // 恒为首次创建，幂等无副作用。
    command:
      "echo playwright-e2e-password | npm run bootstrap:super-admin -- --email e2e-admin@example.test --name E2EAdmin --password-stdin && npm run start",
    url: "http://127.0.0.1:8787/health",
    env: productionEnvironment,
    reuseExistingServer: false,
  },
});
