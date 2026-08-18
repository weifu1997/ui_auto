import { test as base, expect } from "@playwright/test";

type StoredSession = {
  user: { id: string; email: string; name: string };
  workspaces: Array<{ id: string; name: string; role: string }>;
};

const fallbackSession: StoredSession = {
  user: { id: "playwright-user", email: "playwright@example.test", name: "Playwright user" },
  workspaces: [
    { id: "test-workspace", name: "Playwright workspace", role: "owner" },
    { id: "workspace-1", name: "Workspace", role: "owner" },
    { id: "workspace-sync", name: "Sync workspace", role: "owner" },
    { id: "platform-ui-workspace", name: "Platform UI workspace", role: "owner" },
    { id: "runs-workspace", name: "Runs workspace", role: "owner" },
    { id: "template-workspace", name: "Template workspace", role: "owner" },
  ],
};

export const test = base.extend({
  page: async ({ page }, applyPage) => {
    await page.addInitScript(({ fallbackSession, storageKey, testSessionKey }) => {
      const nativeFetch = window.fetch.bind(window);
      const nativeSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        nativeSetItem.call(this, key, value);
        if (key !== storageKey) return;
        try {
          const candidate = JSON.parse(value) as { user?: { id?: string } };
          if (candidate.user?.id && candidate.user.id !== fallbackSession.user.id) {
            window.sessionStorage.setItem(testSessionKey, value);
          }
        } catch {
          // Invalid session values should retain the shared fallback behavior.
        }
      };
      window.fetch = async (input, init) => {
        const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        if (new URL(url, window.location.href).pathname === "/api/auth/session") {
          let session = fallbackSession;
          try {
            const stored = window.sessionStorage.getItem(testSessionKey) ?? window.localStorage.getItem(storageKey);
            if (stored) session = JSON.parse(stored) as typeof fallbackSession;
          } catch {
            // A malformed test fixture should exercise the shared fallback session.
          }
          return new Response(JSON.stringify(session), {
            headers: { "content-type": "application/json" },
          });
        }
        return nativeFetch(input, init);
      };
    }, {
      fallbackSession,
      storageKey: "autoflow-platform-session",
      testSessionKey: "autoflow-test-platform-session",
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/auth/session") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(fallbackSession),
        });
        return;
      }

      if (request.method() === "GET" && /^\/api\/workspaces\/[^/]+\/projects$/.test(pathname)) {
        const workspaceId = pathname.split("/")[3]!;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            projects: [{
              id: "sauce-demo",
              workspaceId,
              slug: "sauce-demo",
              name: "Sauce Demo",
              description: "",
              archivedAt: null,
              createdAt: "2030-01-01T00:00:00.000Z",
              updatedAt: "2030-01-01T00:00:00.000Z",
            }],
          }),
        });
        return;
      }

      if (request.method() === "GET" && /^\/api\/platform\/projects\/sauce-demo\/resources\/(flows|elements|variables|environments)$/.test(pathname)) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ resources: [] }),
        });
        return;
      }

      if (request.method() === "GET" && pathname === "/api/platform/projects/sauce-demo/settings") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ settings: { data: { activeEnvironmentId: "" }, version: 1 } }),
        });
        return;
      }

      await route.fulfill({
        contentType: "application/json",
        status: 404,
        body: JSON.stringify({ error: "TEST_ROUTE_NOT_CONFIGURED" }),
      });
    });
    await applyPage(page);
  },
});

export { expect };
