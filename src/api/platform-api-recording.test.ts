import { afterEach, describe, expect, it, vi } from "vitest";
import { getRecordingEvents, getRecordingSessionResult, listRecordingSessions, stopRecordingSession } from "./platform-api";

const session = {
  id: "recording-1",
  projectId: "project-1",
  flowId: "flow-1",
  environmentId: "env-1",
  status: "stopped",
  currentUrl: "https://example.test/login?token=discarded#fragment",
  lastSeq: 2,
  recordedStepCount: 2,
  startedAt: 1,
  lastActivityAt: 2,
};

afterEach(() => vi.unstubAllGlobals());

describe("recording API boundary", () => {
  it("keeps event payload values out of frontend recording state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events: [{ seq: 1, kind: "input", value: "plain-text-password", element: { value: "plain-text-password" } }],
      lastSeq: 1,
      hasMore: false,
    }), { status: 200 })));

    const page = await getRecordingEvents("token", "project-1", "recording-1");

    expect(page.events).toEqual([{ seq: 1, kind: "input", warnings: [] }]);
    expect(JSON.stringify(page)).not.toContain("plain-text-password");
  });

  it("redacts a bound value and query string before returning a stopped result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session,
      result: {
        steps: [{ id: "password", title: "Password", action: "填写", element: "Password", value: "plain-text-password" }],
        elements: [{ id: "password-element", name: "Password", path: "/login", method: "testid", value: "password" }],
        requiredBindings: [{ stepId: "password", fieldHint: "password" }],
        warnings: [],
        lastSeq: 2,
      },
    }), { status: 200 })));

    const response = await stopRecordingSession("token", "project-1", "recording-1");

    expect(response.session.currentUrl).toBe("https://example.test/login");
    expect(response.result.steps[0].value).toBeNull();
    expect(JSON.stringify(response)).not.toContain("plain-text-password");
    expect(JSON.stringify(response)).not.toContain("token=discarded");
  });

  it("infers a required binding for a password-like step missing backend metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session,
      result: {
        steps: [{ id: "password", title: "Password", action: "填写", element: "password field", value: "plain-text-password" }],
        elements: [],
        requiredBindings: [],
        warnings: [],
        lastSeq: 1,
      },
    }), { status: 200 })));

    const response = await stopRecordingSession("token", "project-1", "recording-1");

    expect(response.result.requiredBindings).toEqual([{ stepId: "password", fieldHint: "password field" }]);
    expect(response.result.steps[0].value).toBeNull();
    expect(JSON.stringify(response)).not.toContain("plain-text-password");
  });

  it("decodes an interrupted session from the recent-sessions list without leaking query strings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sessions: [
        { ...session, id: "interrupted-1", status: "interrupted", currentUrl: "https://example.test/dashboard?token=discarded#fragment", errorCode: "SERVICE_RESTARTED", recordedStepCount: 4 },
      ],
      total: 1,
      page: 1,
      pageSize: 5,
    }), { status: 200 })));

    const page = await listRecordingSessions("token", "project-1", 1, 5);

    expect(page.total).toBe(1);
    expect(page.sessions[0].status).toBe("interrupted");
    expect(page.sessions[0].errorCode).toBe("SERVICE_RESTARTED");
    expect(page.sessions[0].recordedStepCount).toBe(4);
    expect(page.sessions[0].currentUrl).toBe("https://example.test/dashboard");
    expect(JSON.stringify(page)).not.toContain("token=discarded");
  });

  it("loads a terminal recording result without leaking bound values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: { ...session, status: "failed" },
      result: {
        steps: [{ id: "password", title: "Password", action: "填写", element: "Password", value: "plain-text-password" }],
        elements: [{ id: "password-element", name: "Password", path: "/login", method: "testid", value: "password" }],
        requiredBindings: [{ stepId: "password", fieldHint: "password" }],
        warnings: [],
        lastSeq: 2,
      },
    }), { status: 200 })));

    const response = await getRecordingSessionResult("token", "project-1", "recording-1");

    expect(response.session.status).toBe("failed");
    expect(response.result.steps[0].value).toBeNull();
    expect(JSON.stringify(response)).not.toContain("plain-text-password");
  });
});
