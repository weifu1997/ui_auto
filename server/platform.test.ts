// @vitest-environment node
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PlatformError, errorResponse } from "./http-utils";
import {
  cronFieldMatches,
  cronMatches,
  failureCategory,
  nextCronTime,
  normalizeDatasetRows,
  notificationHostAllowed,
  notificationRejectionCode,
  parseCsv,
  publicFlowOutputNames,
  publicIpAddress,
  webhookSignatureMatches,
} from "./platform-core";

describe("cronFieldMatches", () => {
  it("matches exact values and wildcard ranges", () => {
    expect(cronFieldMatches("5", 5, 0, 59)).toBe(true);
    expect(cronFieldMatches("5", 6, 0, 59)).toBe(false);
    expect(cronFieldMatches("*", 42, 0, 59)).toBe(true);
    expect(cronFieldMatches("1-5", 3, 1, 5)).toBe(true);
    expect(cronFieldMatches("1-5", 6, 1, 5)).toBe(false);
  });

  it("supports step intervals and lists", () => {
    expect(cronFieldMatches("*/15", 30, 0, 59)).toBe(true);
    expect(cronFieldMatches("*/15", 31, 0, 59)).toBe(false);
    expect(cronFieldMatches("1,3,5", 3, 0, 59)).toBe(true);
    expect(cronFieldMatches("1,3,5", 4, 0, 59)).toBe(false);
    expect(cronFieldMatches("1-10/3", 7, 1, 10)).toBe(true);
    expect(cronFieldMatches("1-10/3", 8, 1, 10)).toBe(false);
  });

  it("rejects invalid intervals and out-of-range values", () => {
    expect(cronFieldMatches("*/0", 5, 0, 59)).toBe(false);
    expect(cronFieldMatches("*/x", 5, 0, 59)).toBe(false);
    expect(cronFieldMatches("61", 61, 0, 59)).toBe(false);
    expect(cronFieldMatches("5", -1, 0, 59)).toBe(false);
  });
});

describe("cronMatches", () => {
  it("matches a daily 9am schedule in a fixed timezone", () => {
    const date = new Date("2026-01-15T01:00:00Z"); // 09:00 Asia/Shanghai
    expect(cronMatches("0 9 * * *", date, "Asia/Shanghai")).toBe(true);
  });

  it("does not match other hours", () => {
    const date = new Date("2026-01-15T02:00:00Z"); // 10:00 Asia/Shanghai
    expect(cronMatches("0 9 * * *", date, "Asia/Shanghai")).toBe(false);
  });

  it("supports weekdays and month-day alternation", () => {
    // 2026-01-15 is a Thursday (weekday 4)
    const thursday = new Date("2026-01-15T01:00:00Z");
    expect(cronMatches("0 9 * * 4", thursday, "Asia/Shanghai")).toBe(true);
    expect(cronMatches("0 9 * * 1", thursday, "Asia/Shanghai")).toBe(false);
    expect(cronMatches("0 9 15 * *", thursday, "Asia/Shanghai")).toBe(true);
    expect(cronMatches("0 9 20 * *", thursday, "Asia/Shanghai")).toBe(false);
  });

  it("rejects malformed expressions and invalid timezones", () => {
    expect(cronMatches("0 9", new Date(), "Asia/Shanghai")).toBe(false);
    expect(() => cronMatches("0 9 * * *", new Date(), "Not/AZone")).toThrow();
  });
});

describe("nextCronTime", () => {
  it("computes the next occurrence after a given time", () => {
    const from = new Date("2026-01-15T00:30:00Z");
    const next = new Date(nextCronTime("0 9 * * *", "Asia/Shanghai", from));
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(cronMatches("0 9 * * *", next, "Asia/Shanghai")).toBe(true);
  });

  it("throws for impossible expressions", () => {
    expect(() => nextCronTime("0 9 30 2 *", "Asia/Shanghai", new Date("2026-01-01T00:00:00Z"))).toThrow();
  }, 40_000);
});

describe("parseCsv", () => {
  it("parses simple rows with commas and newlines", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("handles quoted cells with embedded commas and quotes", () => {
    const csv = 'name,note\n"Smith, John","said ""hi"""';
    expect(parseCsv(csv)).toEqual([["name", "note"], ["Smith, John", 'said "hi"']]);
  });

  it("ignores carriage returns", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("rejects unterminated quotes", () => {
    expect(() => parseCsv('"unclosed')).toThrow();
  });
});

describe("normalizeDatasetRows", () => {
  it("builds column/row objects from a header plus data rows", () => {
    const result = normalizeDatasetRows([["name", "age"], ["alice", "30"], ["bob", "25"]]);
    expect(result.columns).toEqual(["name", "age"]);
    expect(result.rows).toEqual([{ name: "alice", age: "30" }, { name: "bob", age: "25" }]);
  });

  it("strips the BOM from the first header and trims headers", () => {
    const result = normalizeDatasetRows([["\uFEFFname ", "age"], ["alice", "30"]]);
    expect(result.columns).toEqual(["name", "age"]);
  });

  it("rejects duplicate headers (case-insensitive)", () => {
    expect(() => normalizeDatasetRows([["Name", "name"], ["a", "b"]])).toThrow();
  });

  it("rejects empty headers and missing data rows", () => {
    expect(() => normalizeDatasetRows([["", "b"], ["a", "b"]])).toThrow();
    expect(() => normalizeDatasetRows([["a", "b"]])).toThrow();
  });

  it("skips fully-empty rows and enforces the row limit", () => {
    const many = [["a", "b"], ...Array.from({ length: 10_002 }, (_, i) => [`r${i}`, "x"])];
    expect(() => normalizeDatasetRows(many)).toThrow();
    const withEmpty = normalizeDatasetRows([["a", "b"], ["", ""], ["1", "2"]]);
    expect(withEmpty.rows).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("failureCategory", () => {
  it("classifies common failure messages", () => {
    expect(failureCategory("TIMEOUT waiting for selector")).toBe("timeout");
    expect(failureCategory("ELEMENT_NOT_FOUND for #submit")).toBe("locator");
    expect(failureCategory("expect(received).toBe() ASSERTION_FAILED")).toBe("assertion");
    expect(failureCategory("net::ERR_CONNECTION_REFUSED")).toBe("network");
    expect(failureCategory("BROWSER_LAUNCH_FAILED")).toBe("browser");
    expect(failureCategory("RUN_CANCELED by user")).toBe("canceled");
  });

  it("falls back to other for unknown messages", () => {
    expect(failureCategory("something unexpected")).toBe("other");
    expect(failureCategory(undefined)).toBe("other");
  });
});

describe("publicFlowOutputNames", () => {
  it("collects public output names from flow steps", () => {
    const run = {
      projectId: "p",
      snapshot: {
        flow: {
          steps: [
            { output: "orderId", outputPublic: true },
            { output: "secret", outputPublic: false },
            { storeAs: "cartTotal", outputPublic: true },
          ],
        },
      },
    } as never;
    const names = publicFlowOutputNames(run);
    expect(names.has("orderId")).toBe(true);
    expect(names.has("cartTotal")).toBe(true);
    expect(names.has("secret")).toBe(false);
  });

  it("ignores malformed names", () => {
    const run = {
      projectId: "p",
      snapshot: { flow: { steps: [{ output: "bad name!", outputPublic: true }] } },
    } as never;
    expect(publicFlowOutputNames(run).size).toBe(0);
  });
});

describe("publicIpAddress", () => {
  it("identifies public vs private IPv4", () => {
    expect(publicIpAddress("8.8.8.8")).toBe(true);
    expect(publicIpAddress("10.0.0.1")).toBe(false);
    expect(publicIpAddress("192.168.1.1")).toBe(false);
    expect(publicIpAddress("172.16.0.1")).toBe(false);
    expect(publicIpAddress("127.0.0.1")).toBe(false);
  });

  it("identifies public vs private IPv6", () => {
    expect(publicIpAddress("2001:4860:4860::8888")).toBe(true);
    expect(publicIpAddress("::1")).toBe(false);
    expect(publicIpAddress("fe80::1")).toBe(false);
  });
});

describe("notificationHostAllowed", () => {
  it("supports exact hosts and explicit subdomain wildcards", () => {
    const allowlist = ["hooks.corp.test", "*.notify.corp.test"];
    expect(notificationHostAllowed("hooks.corp.test", allowlist)).toBe(true);
    expect(notificationHostAllowed("team.notify.corp.test", allowlist)).toBe(true);
    expect(notificationHostAllowed("notify.corp.test", allowlist)).toBe(false);
    expect(notificationHostAllowed("hooks.corp.test.attacker.test", allowlist)).toBe(false);
  });
});

describe("notificationRejectionCode", () => {
  it("detects non-zero code and errcode responses", () => {
    expect(notificationRejectionCode(JSON.stringify({ code: 19001 }))).toBe(19001);
    expect(notificationRejectionCode(JSON.stringify({ errcode: 310000 }))).toBe(310000);
    expect(notificationRejectionCode(JSON.stringify({ code: 19001, errcode: 310000 }))).toBe(19001);
  });

  it("ignores success codes and malformed bodies", () => {
    expect(notificationRejectionCode(JSON.stringify({ code: 0 }))).toBeUndefined();
    expect(notificationRejectionCode(JSON.stringify({ errcode: 0 }))).toBeUndefined();
    expect(notificationRejectionCode("not-json")).toBeUndefined();
    expect(notificationRejectionCode(null)).toBeUndefined();
  });
});

describe("webhookSignatureMatches", () => {
  it("accepts a valid HMAC signature and rejects tampered bodies", () => {
    const secret = "test-secret";
    const body = Buffer.from(JSON.stringify({ runId: "r1" }));
    const signature = `sha256=${createHmac("sha256", secret).update(`1735689600.${body.toString("utf8")}`).digest("hex")}`;
    expect(webhookSignatureMatches(secret, "1735689600", body, signature)).toBe(true);
    expect(webhookSignatureMatches(secret, "1735689600", Buffer.from("tampered"), signature)).toBe(false);
    expect(webhookSignatureMatches("wrong-secret", "1735689600", body, signature)).toBe(false);
  });
});

describe("errorResponse", () => {
  it("maps PlatformError to its status and code", () => {
    expect(errorResponse(new PlatformError(404, "PROJECT_NOT_FOUND")))
      .toEqual({ status: 404, code: "PROJECT_NOT_FOUND" });
  });

  it("hides unknown errors behind a generic 500 code by default", () => {
    const sql = new Error("SQLITE_ERROR: near \"/var/lib/data\": syntax error");
    expect(errorResponse(sql)).toEqual({ status: 500, code: "INTERNAL_ERROR" });
    expect(errorResponse({ weird: true })).toEqual({ status: 500, code: "INTERNAL_ERROR" });
  });

  it("honors internalCode for unknown errors", () => {
    expect(errorResponse(new Error("boom"), { internalCode: "PLATFORM_INTERNAL_ERROR" }))
      .toEqual({ status: 500, code: "PLATFORM_INTERNAL_ERROR" });
  });

  it("exposes message-based codes only when explicitly enabled", () => {
    expect(errorResponse(new Error("RUN_NOT_FOUND"), { exposeMessage: true }))
      .toEqual({ status: 404, code: "RUN_NOT_FOUND" });
    expect(errorResponse(new Error("RUN_SECRETS_REQUIRED"), { exposeMessage: true }))
      .toEqual({ status: 409, code: "RUN_SECRETS_REQUIRED" });
    expect(errorResponse(new Error("ENVIRONMENT_REQUIRED"), { exposeMessage: true }))
      .toEqual({ status: 400, code: "ENVIRONMENT_REQUIRED" });
    expect(errorResponse(new Error("ENVIRONMENT_REQUIRED"))).toEqual({ status: 500, code: "INTERNAL_ERROR" });
  });
});
