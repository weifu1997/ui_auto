import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { basename, join, resolve } from "node:path";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import { PlatformError } from "./http-utils";
import { notificationHostAllowed as hostAllowed } from "./platform-automations";
import { asRecord } from "./platform-resources";

export { passwordHash, passwordMatches } from "./platform-auth";
export { cleanProjectSlug } from "./platform-projects";
export { asRecord } from "./platform-resources";
export { revisionNumber } from "./platform-revisions";
export { roleHasCapability } from "./platform-workspaces";
export type { Capability, Role } from "./platform-workspaces";

export { PlatformError, readBody, readJson, sendError, sendJson } from "./http-utils";

export type RevisionStatus = "draft" | "pending_review" | "published" | "rejected" | "deprecated" | "superseded";
export type PlatformRunStatus = "queued" | "dispatched" | "running" | "success" | "failed" | "canceled";
export type LeaseStatus = "offered" | "leased" | "expired" | "completed" | "canceled";
export type DebugSessionStatus = "requested" | "active" | "paused" | "ending" | "ended" | "failed" | "expired";
export type NotificationChannelType = "webhook" | "feishu" | "dingtalk" | "wecom" | "email";
export type DeliveryStatus = "pending" | "retrying" | "delivering" | "delivered" | "failed";
export type ValidatedNotificationTarget = { url: URL; address: string };
export type ElementValidationStatus = "queued" | "running" | "success" | "failed" | "canceled";

export type ElementValidation = {
  id: string;
  projectId: string;
  environmentId: string;
  agentId: string;
  status: ElementValidationStatus;
  element: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type AuthUser = { id: string; email: string; name: string };
export type AgentRecord = {
  id: string;
  workspaceId: string;
  name: string;
  status: "online" | "offline" | "disabled";
  browserVersion: string;
  os: string;
  maxConcurrency: number;
  currentTask: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};
export type PlatformRun = {
  id: string;
  projectId: string;
  revisionId: string;
  agentId: string;
  executorType: "managed" | "agent";
  environmentId: string;
  status: PlatformRunStatus;
  snapshot: Record<string, unknown>;
  result?: Record<string, unknown>;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
};
export type Lease = {
  id: string;
  runId: string;
  agentId: string;
  status: LeaseStatus;
  expiresAt: string;
  attempt: number;
};
export type DebugSession = {
  id: string;
  projectId: string;
  revisionId: string | null;
  environmentId: string;
  agentId: string;
  status: DebugSessionStatus;
  snapshot: Record<string, unknown>;
  currentStep: number;
  currentUrl: string | null;
  browserContextId: string | null;
  idleExpiresAt: string;
  maxExpiresAt: string;
  createdAt: string;
  updatedAt: string;
};
export type LocatorCandidate = {
  method: "testid" | "role" | "label" | "text" | "css";
  value: string;
  count: number;
  score: number;
  label: string;
};

export type ProjectDocument = {
  data: Record<string, unknown>;
  version: number;
  updatedAt?: string;
};

export type DatasetVersionRecord = {
  id: string;
  datasetId: string;
  projectId: string;
  versionNumber: number;
  columns: string[];
  rowCount: number;
  checksum: string;
  sourceName: string;
  createdAt: string;
};

export type PublishedRevision = {
  id: string;
  flow_snapshot: string;
  environment_snapshot: string;
  element_snapshot: string;
  dataset_snapshot: string;
  checksum: string;
};

export type PlatformApi = {
  handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
};

export const jsonContentType = { "content-type": "application/json; charset=utf-8" };
export const platformArtifactDirectory = resolve(
  process.env.PLATFORM_ARTIFACT_DIRECTORY ?? join("server", ".platform-artifacts"),
);
export const agentLeaseDurationMs = Number(process.env.AGENT_LEASE_DURATION_MS ?? 45_000);
export const agentOfflineAfterMs = Number(process.env.AGENT_OFFLINE_AFTER_MS ?? 45_000);
export const debugIdleTimeoutMs = Number(process.env.DEBUG_IDLE_TIMEOUT_MS ?? 15 * 60_000);
export const debugMaxDurationMs = Number(process.env.DEBUG_MAX_DURATION_MS ?? 2 * 60 * 60_000);
export const webhookTimestampToleranceMs = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_MS ?? 5 * 60_000);
export const webhookRateLimitPerMinute = Number(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? 10);
export const webhookMaxRuns = Number(process.env.WEBHOOK_MAX_RUNS ?? 100);
export const notificationMaxAttempts = Math.max(1, Number(process.env.NOTIFICATION_MAX_ATTEMPTS ?? 5));
export const notificationRetryBaseMs = Math.max(1_000, Number(process.env.NOTIFICATION_RETRY_BASE_MS ?? 30_000));
export const allowPrivateNotificationTargets = process.env.PLATFORM_ALLOW_PRIVATE_NOTIFICATION_URLS === "1";
export const allowInsecureNotificationTargets = process.env.PLATFORM_ALLOW_INSECURE_NOTIFICATION_URLS === "1";
export const notificationHostAllowlist = (process.env.PLATFORM_NOTIFICATION_HOST_ALLOWLIST ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

export function notificationHostAllowed(host: string, allowlist = notificationHostAllowlist) {
  return hostAllowed(host, allowlist);
}

export function now() {
  return new Date().toISOString();
}

export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function json(value: unknown) {
  return JSON.stringify(value);
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function authorization(request: IncomingMessage) {
  const value = request.headers.authorization;
  if (value?.startsWith("Bearer ")) {
    const bearer = value.slice("Bearer ".length).trim();
    if (bearer && bearer !== "cookie") return bearer;
  }
  const cookie = request.headers.cookie?.split(";")
    .map((item) => item.trim().split("="))
    .find(([name]) => name === "autoflow_session");
  return cookie?.[1] ? decodeURIComponent(cookie[1]) : undefined;
}

export function leaseExpiresAt() {
  return new Date(Date.now() + agentLeaseDurationMs).toISOString();
}

export function safeArtifactName(value: string) {
  const filename = basename(value).replace(/[^a-zA-Z0-9._-]/g, "_");
  return filename || "artifact.bin";
}

export function normalizeLocatorCandidates(value: unknown) {
  if (!Array.isArray(value)) return [] as LocatorCandidate[];
  const supportedMethods = new Set<LocatorCandidate["method"]>(["testid", "role", "label", "text", "css"]);
  return value.flatMap((item) => {
    const candidate = asRecord(item);
    const method = candidate.method;
    const locatorValue = candidate.value;
    if (typeof method !== "string" || !supportedMethods.has(method as LocatorCandidate["method"]) || typeof locatorValue !== "string" || !locatorValue.trim()) return [];
    return [{
      method: method as LocatorCandidate["method"],
      value: locatorValue.slice(0, 500),
      count: typeof candidate.count === "number" && Number.isFinite(candidate.count) ? Math.max(0, Math.floor(candidate.count)) : 0,
      score: typeof candidate.score === "number" && Number.isFinite(candidate.score) ? Math.max(0, Math.min(100, Math.round(candidate.score))) : 0,
      label: typeof candidate.label === "string" ? candidate.label.slice(0, 160) : locatorValue.slice(0, 160),
    } satisfies LocatorCandidate];
  }).slice(0, 12);
}

export function failureCategory(message: unknown) {
  const value = String(message ?? "").toUpperCase();
  if (value.includes("TIMEOUT")) return "timeout";
  if (value.includes("ELEMENT_NOT_FOUND") || value.includes("LOCATOR") || value.includes("STRICT MODE")) return "locator";
  if (value.includes("ASSERT") || value.includes("TEXT_")) return "assertion";
  if (value.includes("NET::") || value.includes("ERR_") || value.includes("NETWORK") || value.includes("ECONN")) return "network";
  if (value.includes("BROWSER")) return "browser";
  if (value.includes("CANCELED")) return "canceled";
  return "other";
}

const cronFieldBounds: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

export function assertValidCronExpression(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new PlatformError(400, "SCHEDULE_CRON_INVALID");
  for (let index = 0; index < fields.length; index += 1) {
    const [minimum, maximum] = cronFieldBounds[index];
    for (const part of fields[index].split(",")) {
      if (!part) throw new PlatformError(400, "SCHEDULE_CRON_INVALID");
      const [range, intervalText] = part.split("/");
      if (intervalText !== undefined) {
        const interval = Number(intervalText);
        if (!Number.isInteger(interval) || interval < 1 || interval > maximum - minimum) throw new PlatformError(400, "SCHEDULE_CRON_INVALID");
      }
      if (range === "*") continue;
      const [startText, endText] = range.split("-");
      const start = Number(startText);
      const end = endText === undefined ? start : Number(endText);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < minimum || start > maximum || end < minimum || end > maximum || end < start) {
        throw new PlatformError(400, "SCHEDULE_CRON_INVALID");
      }
    }
  }
}

export function nextCronTime(expression: string, timeZone: string, from = new Date()) {
  assertValidCronExpression(expression);
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let minute = 0; minute < 5_000; minute += 1) {
    if (cronMatches(expression, cursor, timeZone)) return cursor.toISOString();
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new PlatformError(400, "SCHEDULE_CRON_INVALID");
}

const cronFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function cronMatches(expression: string, date: Date, timeZone: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  let values: Record<string, number>;
  try {
    let formatter = cronFormatterCache.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hourCycle: "h23" });
      cronFormatterCache.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(date);
    const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    values = { minute: Number(lookup.minute), hour: Number(lookup.hour), day: Number(lookup.day), month: Number(lookup.month), weekDay: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(lookup.weekday) };
  } catch {
    throw new PlatformError(400, "SCHEDULE_TIMEZONE_INVALID");
  }
  const dayOfMonthMatches = cronFieldMatches(fields[2], values.day, 1, 31);
  const dayOfWeekMatches = cronFieldMatches(fields[4], values.weekDay, 0, 6);
  const dayMatches = fields[2] === "*"
    ? dayOfWeekMatches
    : fields[4] === "*"
      ? dayOfMonthMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return cronFieldMatches(fields[0], values.minute, 0, 59)
    && cronFieldMatches(fields[1], values.hour, 0, 23)
    && dayMatches
    && cronFieldMatches(fields[3], values.month, 1, 12);
}

export function cronFieldMatches(field: string, value: number, minimum: number, maximum: number) {
  return field.split(",").some((part) => {
    const [range, intervalText] = part.split("/");
    const interval = intervalText === undefined ? 1 : Number(intervalText);
    if (!Number.isInteger(interval) || interval < 1) return false;
    const [startText, endText] = range === "*" ? [String(minimum), String(maximum)] : range.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    return Number.isInteger(start) && Number.isInteger(end) && start >= minimum && end <= maximum && value >= start && value <= end && (value - start) % interval === 0;
  });
}

export function publicFlowOutputNames(run: PlatformRun) {
  const flow = asRecord(run.snapshot.flow);
  const steps = Array.isArray(flow.steps) ? flow.steps.map(asRecord) : [];
  return new Set(
    steps.flatMap((step) => {
      const name = typeof step.output === "string" ? step.output : typeof step.storeAs === "string" ? step.storeAs : "";
      return step.outputPublic === true && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) ? [name] : [];
    }),
  );
}

export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      if (cell.length > 0) throw new PlatformError(400, "DATASET_FILE_INVALID");
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      if (rows.length > 10_001) throw new PlatformError(413, "DATASET_ROW_LIMIT_EXCEEDED");
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  if (quoted) throw new PlatformError(400, "DATASET_FILE_INVALID");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
    if (rows.length > 10_001) throw new PlatformError(413, "DATASET_ROW_LIMIT_EXCEEDED");
  }
  return rows;
}

export function normalizeDatasetRows(input: unknown[][]) {
  if (input.length < 2) throw new PlatformError(400, "DATASET_ROWS_REQUIRED");
  const headers = input[0].map((value) => String(value ?? "").trim().replace(/^\uFEFF/, ""));
  if (headers.length === 0 || headers.length > 200 || headers.some((value) => !value)) {
    throw new PlatformError(400, "DATASET_HEADERS_INVALID");
  }
  const canonical = headers.map((value) => value.toLocaleLowerCase());
  if (new Set(canonical).size !== headers.length) throw new PlatformError(400, "DATASET_HEADERS_DUPLICATE");
  const rows = input.slice(1, 10_001).flatMap((source) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, String(source[index] ?? "").slice(0, 10_000)]));
    return Object.values(row).some((value) => value.length > 0) ? [row] : [];
  });
  if (rows.length === 0) throw new PlatformError(400, "DATASET_ROWS_REQUIRED");
  if (input.length > 10_001) throw new PlatformError(413, "DATASET_ROW_LIMIT_EXCEEDED");
  return { columns: headers, rows };
}

export function publicIpAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const [first, second] = address.split(".").map(Number);
    return !(
      first === 0 || first === 10 || first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized !== "::" && normalized !== "::1" &&
      !normalized.startsWith("fc") && !normalized.startsWith("fd") &&
      !normalized.startsWith("fe80:") && !normalized.startsWith("::ffff:");
  }
  return false;
}

export function webhookSignatureMatches(secret: string, timestamp: string, body: Buffer, signature: string) {
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body.toString("utf8")}`).digest("hex")}`;
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}
