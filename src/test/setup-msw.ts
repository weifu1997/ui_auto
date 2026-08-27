// vitest 全局 MSW 服务（阶段1-E）。
//
// 所有未显式 `vi.mock("../api/platform-api")` 的组件测试走真实 fetch 管线，
// 由 `setupServer` 拦截到 `platformHandlers`。未匹配的 `/api/*` 请求直接抛错，
// 让 mock 覆盖缺口显式暴露（而不是静默 404 在断言里消失）。
import { afterAll, afterEach, beforeAll } from "vitest";
import { setupServer } from "msw/node";
import { platformHandlers, resetPlatformServer } from "./server-handlers";

const server = setupServer(...platformHandlers);

beforeAll(() => {
  server.listen({
    onUnhandledRequest(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        throw new Error(
          `[MSW] 未注册 handler：${request.method} ${url.pathname}${url.search}`,
        );
      }
    },
  });
});

afterEach(() => {
  server.resetHandlers();
  resetPlatformServer();
});

afterAll(() => {
  server.close();
});
