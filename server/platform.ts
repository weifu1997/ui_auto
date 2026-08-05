import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, join, resolve } from "node:path";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { readSheet } from "read-excel-file/node";

type Role = "owner" | "admin" | "editor" | "viewer";
type RevisionStatus = "draft" | "published" | "superseded";
type PlatformRunStatus = "queued" | "dispatched" | "running" | "success" | "failed" | "canceled";
type LeaseStatus = "offered" | "leased" | "expired" | "completed" | "canceled";
type DebugSessionStatus = "requested" | "active" | "paused" | "ending" | "ended" | "failed" | "expired";
type NotificationChannelType = "webhook" | "feishu" | "dingtalk" | "wecom" | "email";
type DeliveryStatus = "pending" | "retrying" | "delivering" | "delivered" | "failed";
type ValidatedNotificationTarget = { url: URL; address: string };
type ElementValidationStatus = "queued" | "running" | "success" | "failed" | "canceled";

type ElementValidation = {
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

type AuthUser = { id: string; email: string; name: string };
type AgentRecord = {
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
type PlatformRun = {
  id: string;
  projectId: string;
  revisionId: string;
  agentId: string;
  environmentId: string;
  status: PlatformRunStatus;
  snapshot: Record<string, unknown>;
  result?: Record<string, unknown>;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
};
type Lease = {
  id: string;
  runId: string;
  agentId: string;
  status: LeaseStatus;
  expiresAt: string;
  attempt: number;
};
type DebugSession = {
  id: string;
  projectId: string;
  revisionId: string;
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
type LocatorCandidate = {
  method: "testid" | "role" | "label" | "text" | "css";
  value: string;
  count: number;
  score: number;
  label: string;
};

type ProjectDocument = {
  data: Record<string, unknown>;
  version: number;
  updatedAt?: string;
};

type DatasetVersionRecord = {
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

type PublishedRevision = {
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

const jsonContentType = { "content-type": "application/json; charset=utf-8" };
const platformArtifactDirectory = resolve(
  process.env.PLATFORM_ARTIFACT_DIRECTORY ?? join("server", ".platform-artifacts"),
);
const agentLeaseDurationMs = Number(process.env.AGENT_LEASE_DURATION_MS ?? 45_000);
const agentOfflineAfterMs = Number(process.env.AGENT_OFFLINE_AFTER_MS ?? 45_000);
const debugIdleTimeoutMs = Number(process.env.DEBUG_IDLE_TIMEOUT_MS ?? 15 * 60_000);
const debugMaxDurationMs = Number(process.env.DEBUG_MAX_DURATION_MS ?? 2 * 60 * 60_000);
const webhookTimestampToleranceMs = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_MS ?? 5 * 60_000);
const webhookRateLimitPerMinute = Number(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? 10);
const webhookMaxRuns = Number(process.env.WEBHOOK_MAX_RUNS ?? 100);
const notificationMaxAttempts = Math.max(1, Number(process.env.NOTIFICATION_MAX_ATTEMPTS ?? 5));
const notificationRetryBaseMs = Math.max(1_000, Number(process.env.NOTIFICATION_RETRY_BASE_MS ?? 30_000));
const allowPrivateNotificationTargets = process.env.PLATFORM_ALLOW_PRIVATE_NOTIFICATION_URLS === "1";
const allowInsecureNotificationTargets = process.env.PLATFORM_ALLOW_INSECURE_NOTIFICATION_URLS === "1";

function now() {
  return new Date().toISOString();
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function passwordHash(password: string) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

function passwordMatches(password: string, encoded: string) {
  const [saltText, hashText] = encoded.split(":");
  if (!saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, jsonContentType);
  response.end(json(body));
}

function sendError(response: ServerResponse, status: number, error: string) {
  sendJson(response, status, { error });
}

async function readBody(request: IncomingMessage, maxBytes = 1_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new PlatformError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage, maxBytes = 1_000_000) {
  const body = await readBody(request, maxBytes);
  if (body.length === 0) return {} as T;
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new PlatformError(400, "INVALID_JSON");
  }
}

class PlatformError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function authorization(request: IncomingMessage) {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length).trim();
}

function leaseExpiresAt() {
  return new Date(Date.now() + agentLeaseDurationMs).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanProjectSlug(value: string) {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "project";
}

function revisionNumber(rows: Array<{ revision_number: number }>) {
  return Math.max(0, ...rows.map((row) => row.revision_number)) + 1;
}

function safeArtifactName(value: string) {
  const filename = basename(value).replace(/[^a-zA-Z0-9._-]/g, "_");
  return filename || "artifact.bin";
}

export function createPlatformApi(dataDirectory: string): PlatformApi {
  const database = new DatabaseSync(join(dataDirectory, "platform.sqlite"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS platform_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_user_credentials (
      user_id TEXT PRIMARY KEY REFERENCES platform_users(id),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES platform_users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id TEXT NOT NULL REFERENCES platform_users(id),
      role TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS workspace_invitations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id TEXT NOT NULL REFERENCES platform_users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS platform_projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, slug)
    );
    CREATE TABLE IF NOT EXISTS project_documents (
      project_id TEXT PRIMARY KEY REFERENCES platform_projects(id),
      data TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_imports (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      source_id TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      result TEXT NOT NULL,
      UNIQUE (workspace_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS flow_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      flow_id TEXT,
      flow_name TEXT,
      environment_id TEXT,
      revision_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      flow_snapshot TEXT NOT NULL,
      environment_snapshot TEXT NOT NULL,
      element_snapshot TEXT NOT NULL,
      dataset_snapshot TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE (project_id, revision_number)
    );
    CREATE TABLE IF NOT EXISTS project_secrets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      name TEXT NOT NULL,
      key_version INTEGER NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      project_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      browser_version TEXT NOT NULL,
      os TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL,
      current_task TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_bindings (
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      environment_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, environment_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS platform_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
      environment_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      cancellation_requested INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS element_validations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      environment_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL,
      element_snapshot TEXT NOT NULL,
      result TEXT,
      error TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_leases (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES platform_runs(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES platform_runs(id),
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES platform_runs(id),
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS debug_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
      environment_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 0,
      current_url TEXT,
      browser_context_id TEXT,
      idle_expires_at TEXT NOT NULL,
      max_expires_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS debug_session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES debug_sessions(id),
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS debug_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES debug_sessions(id),
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS picker_captures (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES debug_sessions(id),
      candidates TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS dataset_versions (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES datasets(id),
      version_number INTEGER NOT NULL,
      columns_json TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      source_name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (dataset_id, version_number)
    );
    CREATE TABLE IF NOT EXISTS dataset_rows (
      id TEXT PRIMARY KEY,
      dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(id),
      row_number INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      UNIQUE (dataset_version_id, row_number)
    );
    CREATE TABLE IF NOT EXISTS flow_outputs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES platform_runs(id),
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, name)
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
      environment_id TEXT NOT NULL,
      dataset_version_id TEXT REFERENCES dataset_versions(id),
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_triggers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
      environment_id TEXT NOT NULL,
      dataset_version_id TEXT REFERENCES dataset_versions(id),
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      signing_secret_iv TEXT,
      signing_secret_tag TEXT,
      signing_secret_ciphertext TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_triggered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      trigger_id TEXT NOT NULL REFERENCES webhook_triggers(id),
      delivery_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (trigger_id, delivery_id)
    );
    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      config_iv TEXT NOT NULL,
      config_tag TEXT NOT NULL,
      config_ciphertext TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, name)
    );
    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      channel_id TEXT NOT NULL REFERENCES notification_channels(id),
      on_success INTEGER NOT NULL DEFAULT 0,
      on_failure INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (project_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES notification_channels(id),
      run_id TEXT NOT NULL REFERENCES platform_runs(id),
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      response_code INTEGER,
      error TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (channel_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS platform_projects_workspace ON platform_projects (workspace_id, archived_at);
    CREATE INDEX IF NOT EXISTS flow_revisions_project ON flow_revisions (project_id, revision_number DESC);
    CREATE INDEX IF NOT EXISTS agents_workspace ON agents (workspace_id, status, last_seen_at);
    CREATE INDEX IF NOT EXISTS platform_runs_project ON platform_runs (project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS run_leases_agent ON run_leases (agent_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS debug_sessions_project ON debug_sessions (project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS debug_sessions_agent ON debug_sessions (agent_id, status, idle_expires_at);
    CREATE INDEX IF NOT EXISTS debug_session_events_session ON debug_session_events (session_id, id);
    CREATE INDEX IF NOT EXISTS picker_captures_session ON picker_captures (session_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS datasets_project ON datasets (project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS dataset_versions_dataset ON dataset_versions (dataset_id, version_number DESC);
    CREATE INDEX IF NOT EXISTS dataset_rows_version ON dataset_rows (dataset_version_id, row_number);
    CREATE INDEX IF NOT EXISTS flow_outputs_run ON flow_outputs (run_id, name);
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS webhook_triggers_project ON webhook_triggers (project_id, enabled);
    CREATE INDEX IF NOT EXISTS webhook_deliveries_received ON webhook_deliveries (received_at);
    CREATE INDEX IF NOT EXISTS deliveries_channel ON deliveries (channel_id, status, created_at DESC);
  `);

  const ensureColumn = (table: string, column: string, definition: string) => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  ensureColumn("webhook_triggers", "signing_secret_iv", "TEXT");
  ensureColumn("webhook_triggers", "signing_secret_tag", "TEXT");
  ensureColumn("webhook_triggers", "signing_secret_ciphertext", "TEXT");
  ensureColumn("deliveries", "next_attempt_at", "TEXT");
  ensureColumn("agent_bindings", "is_default", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("platform_projects", "source_project_id", "TEXT");
  ensureColumn("flow_revisions", "flow_id", "TEXT");
  ensureColumn("flow_revisions", "flow_name", "TEXT");
  ensureColumn("flow_revisions", "environment_id", "TEXT");
  const unscopedRevisions = database
    .prepare(`SELECT id, flow_snapshot, environment_snapshot FROM flow_revisions WHERE flow_id IS NULL OR environment_id IS NULL`)
    .all() as Array<{ id: string; flow_snapshot: string; environment_snapshot: string }>;
  for (const revision of unscopedRevisions) {
    const flow = parseJson<Record<string, unknown>>(revision.flow_snapshot, {});
    const environment = parseJson<Record<string, unknown>>(revision.environment_snapshot, {});
    const flowId = typeof flow.id === "string" ? flow.id : null;
    const flowName = typeof flow.name === "string" ? flow.name.slice(0, 240) : null;
    const environmentId = typeof environment.id === "string" ? environment.id : null;
    database.prepare(`UPDATE flow_revisions SET flow_id = ?, flow_name = ?, environment_id = ? WHERE id = ?`)
      .run(flowId, flowName, environmentId, revision.id);
  }
  database.exec(`
    UPDATE agent_bindings SET is_default = 0;
    UPDATE agent_bindings SET is_default = 1
    WHERE rowid IN (
      SELECT MAX(rowid) FROM agent_bindings GROUP BY project_id, environment_id
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_bindings_default
      ON agent_bindings (project_id, environment_id) WHERE is_default = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS platform_projects_workspace_source
      ON platform_projects (workspace_id, source_project_id) WHERE source_project_id IS NOT NULL;
  `);

  const sockets = new Map<string, WebSocket>();
  const pendingDebugCommands = new Map<string, {
    agentId: string;
    resolve: (result: { accepted: boolean; reason?: string }) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const webhookRequests = new Map<string, number[]>();
  const configuredPlatformSecret = process.env.PLATFORM_SECRET_KEY;
  if (process.env.NODE_ENV === "production" && !configuredPlatformSecret) {
    throw new Error("PLATFORM_SECRET_KEY is required in production");
  }
  const keyMaterial = createHash("sha256")
    .update(configuredPlatformSecret ?? "autoflow-development-key-change-before-production")
    .digest();

  function audit(
    workspaceId: string,
    actor: { type: "user" | "agent" | "system"; id: string },
    action: string,
    target: { type: string; id: string },
    detail: Record<string, unknown> = {},
    projectId?: string,
  ) {
    database
      .prepare(
        `INSERT INTO audit_events (id, workspace_id, project_id, actor_type, actor_id, action, target_type, target_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        workspaceId,
        projectId ?? null,
        actor.type,
        actor.id,
        action,
        target.type,
        target.id,
        json(detail),
        now(),
      );
  }

  function encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyMaterial, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  function decrypt(row: { iv: string; tag: string; ciphertext: string }) {
    const decipher = createDecipheriv("aes-256-gcm", keyMaterial, Buffer.from(row.iv, "base64"));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  function webhookSignatureMatches(secret: string, timestamp: string, body: Buffer, signature: string) {
    const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body.toString("utf8")}`).digest("hex")}`;
    const actual = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  }

  function allowWebhookRequest(triggerId: string) {
    const cutoff = Date.now() - 60_000;
    const requests = (webhookRequests.get(triggerId) ?? []).filter((time) => time > cutoff);
    if (requests.length >= webhookRateLimitPerMinute) return false;
    requests.push(Date.now());
    webhookRequests.set(triggerId, requests);
    return true;
  }

  function publicIpAddress(address: string) {
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

  async function notificationTarget(value: string): Promise<ValidatedNotificationTarget> {
    const target = new URL(value);
    if (target.username || target.password) throw new Error("NOTIFICATION_URL_CREDENTIALS_FORBIDDEN");
    if (target.protocol !== "https:" && !(allowInsecureNotificationTargets && target.protocol === "http:")) {
      throw new Error("NOTIFICATION_URL_PROTOCOL_FORBIDDEN");
    }
    const host = target.hostname.toLowerCase();
    if (!allowPrivateNotificationTargets && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))) {
      throw new Error("NOTIFICATION_URL_PRIVATE_HOST");
    }
    const addresses = isIP(host)
        ? [host]
        : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    if (!allowPrivateNotificationTargets) {
      if (addresses.length === 0 || addresses.some((address) => !publicIpAddress(address))) {
        throw new Error("NOTIFICATION_URL_PRIVATE_HOST");
      }
    }
    const address = addresses[0];
    if (!address) throw new Error("NOTIFICATION_URL_HOST_UNRESOLVED");
    return { url: target, address };
  }

  function postNotification(target: ValidatedNotificationTarget, headers: Record<string, string>, body: string) {
    return new Promise<{ status: number }>((resolve, reject) => {
      const transport = target.url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = transport({
        protocol: target.url.protocol,
        hostname: target.address,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: "POST",
        headers: { ...headers, host: target.url.host },
        servername: target.url.hostname,
        lookup: (_hostname, _options, callback) => callback(null, target.address, isIP(target.address)),
        timeout: 10_000,
      }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      request.once("timeout", () => request.destroy(new Error("NOTIFICATION_TIMEOUT")));
      request.once("error", reject);
      request.end(body);
    });
  }

  function normalizeDatasetRows(input: unknown[][]) {
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

  function parseCsv(content: string): string[][] {
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
    }
    return rows;
  }

  async function parseDatasetUpload(fileName: string, contentBase64: string) {
    const content = Buffer.from(contentBase64, "base64");
    if (content.length === 0) throw new PlatformError(400, "DATASET_FILE_EMPTY");
    if (content.length > 12_000_000) throw new PlatformError(413, "DATASET_FILE_TOO_LARGE");
    const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (extension !== "csv" && extension !== "xlsx") {
      throw new PlatformError(400, "DATASET_FILE_TYPE_UNSUPPORTED");
    }
    let rows: unknown[][];
    try {
      rows = extension === "csv"
        ? parseCsv(content.toString("utf8"))
        : await readSheet(content);
    } catch {
      throw new PlatformError(400, "DATASET_FILE_INVALID");
    }
    return { ...normalizeDatasetRows(rows), sourceName: safeArtifactName(fileName) };
  }

  function datasetVersionResponse(row: {
    id: string;
    dataset_id: string;
    project_id: string;
    version_number: number;
    columns_json: string;
    row_count: number;
    checksum: string;
    source_name: string;
    created_at: string;
  }): DatasetVersionRecord {
    return {
      id: row.id,
      datasetId: row.dataset_id,
      projectId: row.project_id,
      versionNumber: row.version_number,
      columns: parseJson<string[]>(row.columns_json, []),
      rowCount: row.row_count,
      checksum: row.checksum,
      sourceName: row.source_name,
      createdAt: row.created_at,
    };
  }

  function datasetVersionFor(projectId: string, versionId: string) {
    const row = database
      .prepare(
        `SELECT v.id, v.dataset_id, d.project_id, v.version_number, v.columns_json, v.row_count, v.checksum, v.source_name, v.created_at
         FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id
         WHERE v.id = ? AND d.project_id = ?`,
      )
      .get(versionId, projectId) as {
      id: string;
      dataset_id: string;
      project_id: string;
      version_number: number;
      columns_json: string;
      row_count: number;
      checksum: string;
      source_name: string;
      created_at: string;
    } | undefined;
    if (!row) throw new PlatformError(404, "DATASET_VERSION_NOT_FOUND");
    return datasetVersionResponse(row);
  }

  function datasetRowsFor(versionId: string) {
    return database
      .prepare(`SELECT row_number, data_json FROM dataset_rows WHERE dataset_version_id = ? ORDER BY row_number ASC`)
      .all(versionId)
      .map((row) => ({ rowNumber: Number((row as { row_number: number }).row_number), data: parseJson<Record<string, string>>((row as { data_json: string }).data_json, {}) }));
  }

  function publishedRevisionFor(projectId: string, revisionId?: string) {
    const row = revisionId
      ? database.prepare(`SELECT id, flow_snapshot, environment_snapshot, element_snapshot, dataset_snapshot, checksum FROM flow_revisions WHERE id = ? AND project_id = ? AND status = 'published'`).get(revisionId, projectId)
      : database.prepare(`SELECT id, flow_snapshot, environment_snapshot, element_snapshot, dataset_snapshot, checksum FROM flow_revisions WHERE project_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1`).get(projectId);
    if (!row) throw new PlatformError(409, "PUBLISHED_REVISION_REQUIRED");
    return row as PublishedRevision;
  }

  function boundOnlineAgent(projectId: string, environmentId: string) {
    const cutoff = new Date(Date.now() - agentOfflineAfterMs).toISOString();
    const row = database
      .prepare(
        `SELECT a.id, a.workspace_id, a.name, a.status, a.browser_version, a.os, a.max_concurrency, a.current_task, a.last_seen_at, a.created_at
         FROM agent_bindings b JOIN agents a ON a.id = b.agent_id
         WHERE b.project_id = ? AND b.environment_id = ? AND b.is_default = 1 AND a.status = 'online' AND a.last_seen_at > ?
         ORDER BY a.last_seen_at DESC LIMIT 1`,
      )
      .get(projectId, environmentId, cutoff) as (AgentRecord & { workspace_id: string; browser_version: string; max_concurrency: number; current_task: string | null; last_seen_at: string | null; created_at: string }) | undefined;
    return row ? mapAgent(row) : undefined;
  }

  function queuePublishedRuns(input: {
    projectId: string;
    revisionId?: string;
    environmentId?: string;
    datasetVersionId?: string;
    createdBy: string;
    source: "manual" | "schedule" | "webhook";
    maxRuns?: number;
    upToStepId?: string;
  }) {
    const revision = publishedRevisionFor(input.projectId, input.revisionId);
    const environment = parseJson<Record<string, unknown>>(revision.environment_snapshot, {});
    const environmentId = input.environmentId ?? (typeof environment.id === "string" ? environment.id : "");
    if (!environmentId) throw new PlatformError(400, "ENVIRONMENT_REQUIRED");
    if (environment.id !== environmentId) throw new PlatformError(409, "REVISION_ENVIRONMENT_MISMATCH");
    requireChromiumEnvironment(environment);
    const agent = boundOnlineAgent(input.projectId, environmentId);
    if (!agent) throw new PlatformError(409, "AGENT_UNAVAILABLE");
    const datasetVersionId = input.datasetVersionId ?? (asRecord(parseJson<unknown>(revision.dataset_snapshot, null)).versionId as string | undefined);
    const datasetVersion = datasetVersionId ? datasetVersionFor(input.projectId, datasetVersionId) : undefined;
    const rows = datasetVersion ? datasetRowsFor(datasetVersion.id) : [{ rowNumber: undefined, data: undefined }];
    if (input.maxRuns !== undefined && rows.length > input.maxRuns) {
      throw new PlatformError(413, "RUN_COUNT_LIMIT_EXCEEDED");
    }
      const flow = parseJson<Record<string, unknown>>(revision.flow_snapshot, {});
      const flowSteps = Array.isArray(flow.steps) ? flow.steps.map(asRecord) : [];
      if (input.upToStepId && !flowSteps.some((step) => step.id === input.upToStepId)) {
        throw new PlatformError(400, "RUN_STEP_NOT_FOUND");
      }
      const secretNames = Array.isArray(flow.secretNames) ? flow.secretNames.filter((value): value is string => typeof value === "string") : [];
      const stepLimit = input.upToStepId ? flowSteps.findIndex((step) => step.id === input.upToStepId) + 1 : flowSteps.length;
      const requiredSecretNames = new Set(
        flowSteps.slice(0, stepLimit).flatMap((step) => {
          const value = typeof step.value === "string" ? step.value : "";
          return secretNames.filter((name) => (
            value.includes(`{{${name}}}`) ||
            value.includes(`{{ ${name} }}`) ||
            value.includes(`{{secret.${name}}}`) ||
            value.includes(`{{ secret.${name} }}`)
          ));
        }),
      );
    const runIds: string[] = [];
    for (const row of rows) {
      const run = { id: randomUUID(), projectId: input.projectId, revisionId: revision.id, agentId: agent.id, environmentId, createdAt: now() };
      const snapshot = {
        flowRevisionId: revision.id,
        flowRevisionChecksum: revision.checksum,
        environmentId,
        flow,
        environment,
        elements: parseJson<unknown[]>(revision.element_snapshot, []),
        dataset: datasetVersion ? { datasetId: datasetVersion.datasetId, versionId: datasetVersion.id, versionNumber: datasetVersion.versionNumber, checksum: datasetVersion.checksum, columns: datasetVersion.columns } : null,
        datasetRow: row.data ? { number: row.rowNumber, data: row.data } : null,
        secretNames: secretNames.filter((name) => requiredSecretNames.has(name)),
        upToStepId: input.upToStepId ?? null,
        agent: { id: agent.id, name: agent.name, browserVersion: agent.browserVersion, os: agent.os, maxConcurrency: agent.maxConcurrency },
        trigger: input.source,
      };
      database.prepare(`INSERT INTO platform_runs (id, project_id, revision_id, environment_id, agent_id, status, snapshot, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
        .run(run.id, run.projectId, run.revisionId, run.environmentId, run.agentId, json(snapshot), input.createdBy, run.createdAt, run.createdAt);
      appendRunEvent(run.id, "run.queued", { revisionId: run.revisionId, environmentId, agentId: agent.id, source: input.source, datasetVersionId, datasetRow: row.rowNumber });
      runIds.push(run.id);
    }
    for (const runId of runIds) dispatchQueuedRun(runId);
    return { runIds, revision, environmentId, datasetVersionId };
  }

  function revisionEnvironmentId(revision: Pick<PublishedRevision, "environment_snapshot">) {
    const environment = parseJson<Record<string, unknown>>(revision.environment_snapshot, {});
    const environmentId = typeof environment.id === "string" ? environment.id : "";
    if (!environmentId) throw new PlatformError(400, "REVISION_ENVIRONMENT_REQUIRED");
    return environmentId;
  }

  function requireRevisionEnvironment(revision: Pick<PublishedRevision, "environment_snapshot">, environmentId: string) {
    if (revisionEnvironmentId(revision) !== environmentId) throw new PlatformError(409, "REVISION_ENVIRONMENT_MISMATCH");
  }

  function requireChromiumEnvironment(environment: Record<string, unknown>) {
    const browser = typeof environment.browser === "string" ? environment.browser : "Chromium";
    if (browser !== "Chromium") throw new PlatformError(400, "AGENT_BROWSER_UNSUPPORTED");
  }

  function requireSameOriginElementPath(environment: Record<string, unknown>, element: Record<string, unknown>) {
    const baseUrl = typeof environment.baseUrl === "string" ? environment.baseUrl : "";
    const path = typeof element.path === "string" ? element.path : "/";
    try {
      const base = new URL(baseUrl);
      const target = new URL(path, base);
      if ((base.protocol !== "http:" && base.protocol !== "https:") || target.origin !== base.origin) {
        throw new PlatformError(400, "ELEMENT_VALIDATION_TARGET_FORBIDDEN");
      }
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError(400, "ELEMENT_VALIDATION_TARGET_INVALID");
    }
  }

  function redactRunValue(run: PlatformRun, value: unknown): unknown {
    try {
      const rows = database.prepare(`SELECT name, iv, tag, ciphertext FROM project_secrets WHERE project_id = ?`).all(run.projectId) as Array<{ name: string; iv: string; tag: string; ciphertext: string }>;
      const secrets = Object.fromEntries(rows.map((row) => [row.name, decrypt(row)]));
      if (typeof value === "string") {
        return Object.values(secrets).reduce((result, secret) => secret ? result.replaceAll(secret, "***") : result, value);
      }
      if (Array.isArray(value)) return value.map((item) => redactRunValue(run, item));
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactRunValue(run, item)]));
      }
    } catch {
      return "***";
    }
    return value;
  }

  function publicFlowOutputNames(run: PlatformRun) {
    const flow = asRecord(run.snapshot.flow);
    const steps = Array.isArray(flow.steps) ? flow.steps.map(asRecord) : [];
    return new Set(
      steps.flatMap((step) => {
        const name = typeof step.output === "string" ? step.output : typeof step.storeAs === "string" ? step.storeAs : "";
        return step.outputPublic === true && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) ? [name] : [];
      }),
    );
  }

  function persistFlowOutputs(run: PlatformRun, result: Record<string, unknown>) {
    const outputs = asRecord(result.flowOutputs);
    const allowedNames = publicFlowOutputNames(run);
    for (const [name, sourceValue] of Object.entries(outputs)) {
      const outputName = name.trim().slice(0, 120);
      if (!allowedNames.has(outputName)) continue;
      const value = typeof sourceValue === "string" || typeof sourceValue === "number" || typeof sourceValue === "boolean"
        ? String(redactRunValue(run, sourceValue)).slice(0, 20_000)
        : "";
      if (!value) continue;
      database.prepare(
        `INSERT INTO flow_outputs (id, run_id, name, value, source, created_at) VALUES (?, ?, ?, ?, 'agent', ?)
         ON CONFLICT(run_id, name) DO UPDATE SET value = excluded.value, source = excluded.source, created_at = excluded.created_at`,
      ).run(randomUUID(), run.id, outputName, value, now());
    }
  }

  function notificationPayload(run: PlatformRun, status: PlatformRunStatus) {
    const latestFailure = database
      .prepare(`SELECT kind, data FROM platform_run_events WHERE run_id = ? AND (kind LIKE '%failed%' OR kind LIKE '%error%') ORDER BY id DESC LIMIT 1`)
      .get(run.id) as { kind: string; data: string } | undefined;
    const artifacts = database
      .prepare(`SELECT id, name FROM platform_artifacts WHERE run_id = ? ORDER BY created_at ASC`)
      .all(run.id) as Array<{ id: string; name: string }>;
    return {
      runId: run.id,
      projectId: run.projectId,
      status,
      environmentId: run.environmentId,
      revisionId: run.revisionId,
      agentId: run.agentId,
      failedStep: latestFailure ? { kind: latestFailure.kind, data: redactRunValue(run, parseJson<Record<string, unknown>>(latestFailure.data, {})) } : undefined,
      artifacts,
      retry: { cancellationRequested: run.cancellationRequested },
      completedAt: now(),
    };
  }

  function queueRunDeliveries(run: PlatformRun, status: PlatformRunStatus) {
    if (status !== "success" && status !== "failed" && status !== "canceled") return;
    const project = projectFor(run.projectId);
    const subscriptions = database
      .prepare(
        `SELECT c.id FROM notification_subscriptions s
         JOIN notification_channels c ON c.id = s.channel_id
         WHERE s.project_id = ? AND c.workspace_id = ? AND c.enabled = 1
           AND ((? = 'success' AND s.on_success = 1) OR (? != 'success' AND s.on_failure = 1))`,
      )
      .all(run.projectId, project.workspace_id, status, status) as Array<{ id: string }>;
    const payload = json(notificationPayload(run, status));
    for (const subscription of subscriptions) {
      database.prepare(
        `INSERT INTO deliveries (id, channel_id, run_id, status, payload, next_attempt_at, created_at, updated_at)
         SELECT ?, ?, ?, 'pending', ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM deliveries WHERE channel_id = ? AND run_id = ?)`,
      ).run(randomUUID(), subscription.id, run.id, payload, now(), now(), now(), subscription.id, run.id);
    }
    void deliverPendingNotifications();
  }

  function formatNotificationBody(channelType: NotificationChannelType, payload: Record<string, unknown>) {
    const content = `AutoFlow ${String(payload.status)}: ${String(payload.runId)} (${String(payload.environmentId)})`;
    if (channelType === "feishu") return { msg_type: "text", content: { text: content } };
    if (channelType === "dingtalk") return { msgtype: "text", text: { content } };
    if (channelType === "wecom") return { msgtype: "text", text: { content } };
    return payload;
  }

  async function deliverPendingNotifications() {
    const staleClaim = new Date(Date.now() - 30_000).toISOString();
    database.prepare(`UPDATE deliveries SET status = 'retrying', next_attempt_at = ?, updated_at = ? WHERE status = 'delivering' AND updated_at <= ?`)
      .run(now(), now(), staleClaim);
    const rows = database
      .prepare(
        `SELECT d.id, d.channel_id, d.payload, d.attempt_count, c.channel_type, c.config_iv, c.config_tag, c.config_ciphertext
         FROM deliveries d JOIN notification_channels c ON c.id = d.channel_id
         WHERE d.status IN ('pending', 'retrying') AND c.enabled = 1
           AND COALESCE(d.next_attempt_at, d.created_at) <= ?
         ORDER BY d.created_at ASC LIMIT 20`,
      )
      .all(now()) as Array<{ id: string; channel_id: string; payload: string; attempt_count: number; channel_type: NotificationChannelType; config_iv: string; config_tag: string; config_ciphertext: string }>;
    for (const delivery of rows) {
      const claimed = database.prepare(`UPDATE deliveries SET status = 'delivering', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'retrying')`).run(now(), delivery.id);
      if (claimed.changes !== 1) continue;
      let status: DeliveryStatus = "failed";
      let responseCode: number | null = null;
      let error: string | null = null;
      try {
        const config = parseJson<Record<string, unknown>>(decrypt({ iv: delivery.config_iv, tag: delivery.config_tag, ciphertext: delivery.config_ciphertext }), {});
        const endpoint = typeof config.url === "string" ? config.url : "";
        const target = await notificationTarget(endpoint);
        const headers = asRecord(config.headers);
        const response = await postNotification(
          target,
          { "content-type": "application/json", ...Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, String(value)])) },
          json(formatNotificationBody(delivery.channel_type, parseJson<Record<string, unknown>>(delivery.payload, {}))),
        );
        responseCode = response.status;
        status = response.status >= 200 && response.status < 300 ? "delivered" : "failed";
        error = status === "delivered" ? null : `HTTP_${response.status}`;
      } catch (reason) {
        error = reason instanceof Error ? reason.name === "TimeoutError" ? "NOTIFICATION_TIMEOUT" : reason.message.slice(0, 200) : "NOTIFICATION_DELIVERY_FAILED";
      }
      const attempts = Number(delivery.attempt_count) + 1;
      const retry = status === "failed" && attempts < notificationMaxAttempts;
      const nextAttemptAt = retry
        ? new Date(Date.now() + notificationRetryBaseMs * 2 ** Math.max(0, attempts - 1)).toISOString()
        : null;
      database.prepare(`UPDATE deliveries
        SET status = ?, attempt_count = ?, response_code = ?, error = ?, next_attempt_at = ?,
            delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, updated_at = ?
        WHERE id = ? AND status = 'delivering'`)
        .run(retry ? "retrying" : status, attempts, responseCode, error, nextAttemptAt, status, now(), now(), delivery.id);
    }
  }

  function cronFieldMatches(field: string, value: number, minimum: number, maximum: number) {
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

  function cronMatches(expression: string, date: Date, timeZone: string) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    let values: Record<string, number>;
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hourCycle: "h23" }).formatToParts(date);
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

  function nextCronTime(expression: string, timeZone: string, from = new Date()) {
    const cursor = new Date(from.getTime());
    cursor.setUTCSeconds(0, 0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    for (let minute = 0; minute < 527_040; minute += 1) {
      if (cronMatches(expression, cursor, timeZone)) return cursor.toISOString();
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }
    throw new PlatformError(400, "SCHEDULE_CRON_INVALID");
  }

  function processDueSchedules() {
    const rows = database
      .prepare(`SELECT id, project_id, revision_id, environment_id, dataset_version_id, cron_expression, timezone FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 20`)
      .all(now()) as Array<{ id: string; project_id: string; revision_id: string; environment_id: string; dataset_version_id: string | null; cron_expression: string; timezone: string }>;
    for (const schedule of rows) {
      const attemptedAt = now();
      try {
        const queued = queuePublishedRuns({ projectId: schedule.project_id, revisionId: schedule.revision_id, environmentId: schedule.environment_id, datasetVersionId: schedule.dataset_version_id ?? undefined, createdBy: `schedule:${schedule.id}`, source: "schedule" });
        database.prepare(`UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`).run(attemptedAt, nextCronTime(schedule.cron_expression, schedule.timezone), now(), schedule.id);
        const project = projectFor(schedule.project_id);
        audit(project.workspace_id, { type: "system", id: `schedule:${schedule.id}` }, "schedule.triggered", { type: "schedule", id: schedule.id }, { runIds: queued.runIds }, schedule.project_id);
      } catch (error) {
        const nextRunAt = nextCronTime(schedule.cron_expression, schedule.timezone);
        database.prepare(`UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?`).run(nextRunAt, now(), schedule.id);
        const project = projectFor(schedule.project_id);
        audit(project.workspace_id, { type: "system", id: `schedule:${schedule.id}` }, "schedule.skipped", { type: "schedule", id: schedule.id }, { error: error instanceof PlatformError ? error.code : "SCHEDULE_TRIGGER_FAILED" }, schedule.project_id);
      }
    }
  }

  function failureCategory(message: unknown) {
    const value = String(message ?? "").toUpperCase();
    if (value.includes("TIMEOUT")) return "timeout";
    if (value.includes("ELEMENT_NOT_FOUND") || value.includes("LOCATOR") || value.includes("STRICT MODE")) return "locator";
    if (value.includes("ASSERT") || value.includes("TEXT_")) return "assertion";
    if (value.includes("NET::") || value.includes("ERR_") || value.includes("NETWORK") || value.includes("ECONN")) return "network";
    if (value.includes("BROWSER")) return "browser";
    if (value.includes("CANCELED")) return "canceled";
    return "other";
  }

  function projectAnalytics(projectId: string) {
    const runs = database
      .prepare(`SELECT id, revision_id, status, snapshot, created_at FROM platform_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 500`)
      .all(projectId) as Array<{ id: string; revision_id: string; status: PlatformRunStatus; snapshot: string; created_at: string }>;
    const eventsByRun = new Map<string, Array<{ kind: string; data: Record<string, unknown>; at: string }>>();
    for (const run of runs) {
      const events = database.prepare(`SELECT kind, data, created_at FROM platform_run_events WHERE run_id = ? ORDER BY id ASC`).all(run.id) as Array<{ kind: string; data: string; created_at: string }>;
      eventsByRun.set(run.id, events.map((event) => ({ kind: event.kind, data: parseJson<Record<string, unknown>>(event.data, {}), at: event.created_at })));
    }
    const trend = new Map<string, { date: string; total: number; success: number; failed: number; canceled: number }>();
    const categories = new Map<string, number>();
    const slowSteps = new Map<string, { stepId: string; title: string; totalMs: number; maxMs: number; count: number }>();
    const elements = new Map<string, { elementId: string; name: string; runCount: number; flowCount: Set<string>; failedRuns: number; lastUsedAt: string }>();
    for (const run of runs) {
      const date = run.created_at.slice(0, 10);
      const point = trend.get(date) ?? { date, total: 0, success: 0, failed: 0, canceled: 0 };
      point.total += 1;
      if (run.status === "success") point.success += 1;
      if (run.status === "failed") point.failed += 1;
      if (run.status === "canceled") point.canceled += 1;
      trend.set(date, point);
      const events = eventsByRun.get(run.id) ?? [];
      const failure = [...events].reverse().find((event) => event.kind === "run.failed" || event.kind.includes("error"));
      if (failure) {
        const category = failureCategory(failure.data.message);
        categories.set(category, (categories.get(category) ?? 0) + 1);
      }
      for (const event of events.filter((item) => item.kind === "step.completed")) {
        const durationMs = Number(event.data.durationMs);
        if (!Number.isFinite(durationMs) || durationMs < 0) continue;
        const stepId = String(event.data.stepId ?? "unknown");
        const current = slowSteps.get(stepId) ?? { stepId, title: String(event.data.title ?? stepId), totalMs: 0, maxMs: 0, count: 0 };
        current.totalMs += durationMs;
        current.maxMs = Math.max(current.maxMs, durationMs);
        current.count += 1;
        slowSteps.set(stepId, current);
      }
      const snapshot = parseJson<Record<string, unknown>>(run.snapshot, {});
      const flow = asRecord(snapshot.flow);
      const stepDefinitions = Array.isArray(flow.steps) ? flow.steps.map(asRecord) : [];
      const elementDefinitions = Array.isArray(snapshot.elements) ? snapshot.elements.map(asRecord) : [];
      const failedStepIds = new Set(events.filter((event) => event.kind === "run.failed").map((event) => String(event.data.stepId ?? "")));
      for (const step of stepDefinitions) {
        const reference = typeof step.element === "string" ? step.element : typeof step.elementId === "string" ? step.elementId : "";
        if (!reference) continue;
        const definition = elementDefinitions.find((element) => element.id === reference || element.name === reference);
        const elementId = typeof definition?.id === "string" ? definition.id : reference;
        const name = typeof definition?.name === "string" ? definition.name : reference;
        const current = elements.get(elementId) ?? { elementId, name, runCount: 0, flowCount: new Set<string>(), failedRuns: 0, lastUsedAt: run.created_at };
        current.runCount += 1;
        current.flowCount.add(run.revision_id);
        if (failedStepIds.has(String(step.id ?? ""))) current.failedRuns += 1;
        if (run.created_at > current.lastUsedAt) current.lastUsedAt = run.created_at;
        elements.set(elementId, current);
      }
    }
    const terminal = runs.filter((run) => ["success", "failed", "canceled"].includes(run.status));
    return {
      summary: { totalRuns: runs.length, successRate: terminal.length ? Math.round((terminal.filter((run) => run.status === "success").length / terminal.length) * 100) : 0, failedRuns: runs.filter((run) => run.status === "failed").length },
      trend: [...trend.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30),
      failureCategories: [...categories.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      slowSteps: [...slowSteps.values()].map((item) => ({ stepId: item.stepId, title: item.title, count: item.count, averageMs: Math.round(item.totalMs / item.count), maxMs: item.maxMs })).sort((a, b) => b.averageMs - a.averageMs).slice(0, 20),
      elementImpact: [...elements.values()].map((item) => ({ elementId: item.elementId, name: item.name, runCount: item.runCount, flowCount: item.flowCount.size, failedRuns: item.failedRuns, lastUsedAt: item.lastUsedAt })).sort((a, b) => b.runCount - a.runCount).slice(0, 100),
    };
  }

  function createAuthSession(user: AuthUser) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
    database.prepare(`INSERT INTO platform_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .run(digest(token), user.id, expiresAt, now());
    return { token, expiresAt, user };
  }

  function sessionUser(request: IncomingMessage): AuthUser {
    const token = authorization(request);
    if (!token) throw new PlatformError(401, "AUTH_REQUIRED");
    const row = database
      .prepare(
        `SELECT u.id, u.email, u.name FROM platform_sessions s
         JOIN platform_users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(digest(token), now()) as AuthUser | undefined;
    if (!row) throw new PlatformError(401, "SESSION_INVALID");
    return row;
  }

  function projectFor(id: string) {
    const row = database
      .prepare(`SELECT id, workspace_id, source_project_id, slug, name, description, archived_at, created_at, updated_at FROM platform_projects WHERE id = ?`)
      .get(id) as
      | { id: string; workspace_id: string; source_project_id: string | null; slug: string; name: string; description: string; archived_at: string | null; created_at: string; updated_at: string }
      | undefined;
    if (!row) throw new PlatformError(404, "PROJECT_NOT_FOUND");
    return row;
  }

  function memberRole(workspaceId: string, userId: string): Role {
    const row = database
      .prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .get(workspaceId, userId) as { role: Role } | undefined;
    if (!row) throw new PlatformError(403, "WORKSPACE_ACCESS_DENIED");
    return row.role;
  }

  function requireProjectRole(projectId: string, userId: string, write = false) {
    const project = projectFor(projectId);
    const role = memberRole(project.workspace_id, userId);
    if (write && role === "viewer") throw new PlatformError(403, "WORKSPACE_WRITE_DENIED");
    return { project, role };
  }

  function requireProjectAdmin(projectId: string, userId: string) {
    const { project, role } = requireProjectRole(projectId, userId, true);
    if (role !== "owner" && role !== "admin") throw new PlatformError(403, "PROJECT_ADMIN_REQUIRED");
    return { project, role };
  }

  function normalizeRole(value: unknown): Role {
    if (value === "owner" || value === "admin" || value === "editor" || value === "viewer") return value;
    throw new PlatformError(400, "WORKSPACE_ROLE_INVALID");
  }

  function requireWorkspaceRole(workspaceId: string, userId: string, admin = false) {
    const role = memberRole(workspaceId, userId);
    if (admin && role !== "owner" && role !== "admin") throw new PlatformError(403, "WORKSPACE_ADMIN_REQUIRED");
    return role;
  }

  function documentFor(projectId: string): ProjectDocument {
    const row = database.prepare(`SELECT data, version, updated_at FROM project_documents WHERE project_id = ?`).get(projectId) as
      | { data: string; version: number; updated_at: string }
      | undefined;
    return row
      ? { data: parseJson<Record<string, unknown>>(row.data, {}), version: row.version, updatedAt: row.updated_at }
      : { data: {}, version: 0, updatedAt: undefined };
  }

  function putDocument(projectId: string, data: Record<string, unknown>, expectedVersion?: number) {
    const current = documentFor(projectId);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new PlatformError(409, "DOCUMENT_VERSION_CONFLICT");
    }
    const version = current.version + 1;
    database
      .prepare(
        `INSERT INTO project_documents (project_id, data, version, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(projectId, json(data), version, now());
    return { version, data };
  }

  function agentByCredential(credential?: string) {
    if (!credential) throw new PlatformError(401, "AGENT_CREDENTIAL_REQUIRED");
    const row = database
      .prepare(
        `SELECT id, workspace_id, name, status, browser_version, os, max_concurrency, current_task, last_seen_at, created_at, revoked_at
         FROM agents WHERE credential_hash = ?`,
      )
      .get(digest(credential)) as (AgentRecord & { workspace_id: string; browser_version: string; max_concurrency: number; current_task: string | null; last_seen_at: string | null; created_at: string; revoked_at: string | null }) | undefined;
    if (!row || row.revoked_at || row.status === "disabled") throw new PlatformError(401, "AGENT_CREDENTIAL_INVALID");
    return mapAgent(row);
  }

  function mapAgent(row: AgentRecord & { workspace_id?: string; browser_version?: string; max_concurrency?: number; current_task?: string | null; last_seen_at?: string | null; created_at?: string }) {
    return {
      id: row.id,
      workspaceId: row.workspace_id ?? row.workspaceId,
      name: row.name,
      status: row.status,
      browserVersion: row.browser_version ?? row.browserVersion,
      os: row.os,
      maxConcurrency: Number(row.max_concurrency ?? row.maxConcurrency),
      currentTask: row.current_task ?? row.currentTask ?? null,
      lastSeenAt: row.last_seen_at ?? row.lastSeenAt ?? null,
      createdAt: row.created_at ?? row.createdAt,
    } satisfies AgentRecord;
  }

  function updateAgentHeartbeat(agent: AgentRecord, payload: Record<string, unknown>) {
    const browserVersion = typeof payload.browserVersion === "string" ? payload.browserVersion.slice(0, 160) : agent.browserVersion;
    const os = typeof payload.os === "string" ? payload.os.slice(0, 160) : agent.os;
    const currentTask = typeof payload.currentTask === "string" ? payload.currentTask.slice(0, 120) : null;
    database
      .prepare(
        `UPDATE agents SET status = 'online', browser_version = ?, os = ?, current_task = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(browserVersion, os, currentTask, now(), agent.id);
    return { ...agent, status: "online" as const, browserVersion, os, currentTask, lastSeenAt: now() };
  }

  function runById(runId: string) {
    const row = database
      .prepare(
        `SELECT id, project_id, revision_id, environment_id, agent_id, status, snapshot, cancellation_requested, result, created_at, updated_at
         FROM platform_runs WHERE id = ?`,
      )
      .get(runId) as
      | { id: string; project_id: string; revision_id: string; environment_id: string; agent_id: string; status: PlatformRunStatus; snapshot: string; cancellation_requested: number; result: string | null; created_at: string; updated_at: string }
      | undefined;
    if (!row) throw new PlatformError(404, "RUN_NOT_FOUND");
    return {
      id: row.id,
      projectId: row.project_id,
      revisionId: row.revision_id,
      environmentId: row.environment_id,
      agentId: row.agent_id,
      status: row.status,
      snapshot: parseJson<Record<string, unknown>>(row.snapshot, {}),
      result: parseJson<Record<string, unknown> | undefined>(row.result, undefined),
      cancellationRequested: Boolean(row.cancellation_requested),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } satisfies PlatformRun;
  }

  function elementValidationById(validationId: string): ElementValidation {
    const row = database.prepare(`SELECT id, project_id, environment_id, agent_id, status, element_snapshot, result, error, created_at, updated_at FROM element_validations WHERE id = ?`).get(validationId) as
      | { id: string; project_id: string; environment_id: string; agent_id: string; status: ElementValidationStatus; element_snapshot: string; result: string | null; error: string | null; created_at: string; updated_at: string }
      | undefined;
    if (!row) throw new PlatformError(404, "ELEMENT_VALIDATION_NOT_FOUND");
    return {
      id: row.id,
      projectId: row.project_id,
      environmentId: row.environment_id,
      agentId: row.agent_id,
      status: row.status,
      element: parseJson<Record<string, unknown>>(row.element_snapshot, {}),
      result: parseJson<Record<string, unknown> | undefined>(row.result, undefined),
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function activeLeaseForRun(runId: string) {
    const row = database
      .prepare(`SELECT id, run_id, agent_id, status, expires_at, attempt FROM run_leases WHERE run_id = ? AND status IN ('offered', 'leased') ORDER BY attempt DESC LIMIT 1`)
      .get(runId) as { id: string; run_id: string; agent_id: string; status: LeaseStatus; expires_at: string; attempt: number } | undefined;
    return row ? { id: row.id, runId: row.run_id, agentId: row.agent_id, status: row.status, expiresAt: row.expires_at, attempt: row.attempt } : undefined;
  }

  function appendRunEvent(runId: string, kind: string, data: Record<string, unknown>) {
    database
      .prepare(`INSERT INTO platform_run_events (run_id, kind, data, created_at) VALUES (?, ?, ?, ?)`)
      .run(runId, kind, json(data), now());
  }

  function runResponse(run: PlatformRun) {
    const lease = activeLeaseForRun(run.id);
    const agent = database
      .prepare(`SELECT id, name, browser_version, os, max_concurrency, last_seen_at FROM agents WHERE id = ?`)
      .get(run.agentId) as { id: string; name: string; browser_version: string; os: string; max_concurrency: number; last_seen_at: string | null } | undefined;
    const artifacts = database
      .prepare(`SELECT id, name, content_type, created_at FROM platform_artifacts WHERE run_id = ? ORDER BY created_at ASC`)
      .all(run.id) as Array<{ id: string; name: string; content_type: string; created_at: string }>;
    const events = database
      .prepare(`SELECT id, kind, data, created_at FROM platform_run_events WHERE run_id = ? ORDER BY id ASC LIMIT 500`)
      .all(run.id) as Array<{ id: number; kind: string; data: string; created_at: string }>;
    const flowOutputs = database
      .prepare(`SELECT name, value, source, created_at FROM flow_outputs WHERE run_id = ? ORDER BY name ASC`)
      .all(run.id) as Array<{ name: string; value: string; source: string; created_at: string }>;
    return {
      ...run,
      lease: lease ? { ...lease, expired: new Date(lease.expiresAt).getTime() <= Date.now() } : undefined,
      agent: agent
        ? {
            id: agent.id,
            name: agent.name,
            browserVersion: agent.browser_version,
            os: agent.os,
            maxConcurrency: agent.max_concurrency,
            lastSeenAt: agent.last_seen_at,
          }
        : undefined,
      artifacts: artifacts.map((item) => ({ id: item.id, name: item.name, contentType: item.content_type, createdAt: item.created_at })),
      events: events.map((item) => ({ id: item.id, kind: item.kind, data: parseJson<Record<string, unknown>>(item.data, {}), at: item.created_at })),
      flowOutputs: flowOutputs.map((item) => ({ name: item.name, value: item.value, source: item.source, createdAt: item.created_at })),
    };
  }

  function debugSessionById(sessionId: string) {
    const row = database
      .prepare(
        `SELECT id, project_id, revision_id, environment_id, agent_id, status, snapshot, current_step, current_url,
                browser_context_id, idle_expires_at, max_expires_at, created_at, updated_at
         FROM debug_sessions WHERE id = ?`,
      )
      .get(sessionId) as
      | {
          id: string;
          project_id: string;
          revision_id: string;
          environment_id: string;
          agent_id: string;
          status: DebugSessionStatus;
          snapshot: string;
          current_step: number;
          current_url: string | null;
          browser_context_id: string | null;
          idle_expires_at: string;
          max_expires_at: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
    return {
      id: row.id,
      projectId: row.project_id,
      revisionId: row.revision_id,
      environmentId: row.environment_id,
      agentId: row.agent_id,
      status: row.status,
      snapshot: parseJson<Record<string, unknown>>(row.snapshot, {}),
      currentStep: row.current_step,
      currentUrl: row.current_url,
      browserContextId: row.browser_context_id,
      idleExpiresAt: row.idle_expires_at,
      maxExpiresAt: row.max_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } satisfies DebugSession;
  }

  function appendDebugEvent(sessionId: string, kind: string, data: Record<string, unknown>) {
    database
      .prepare(`INSERT INTO debug_session_events (session_id, kind, data, created_at) VALUES (?, ?, ?, ?)`)
      .run(sessionId, kind.slice(0, 80), json(data), now());
  }

  function nextDebugIdleExpiry(maxExpiresAt: string) {
    return new Date(Math.min(Date.now() + debugIdleTimeoutMs, new Date(maxExpiresAt).getTime())).toISOString();
  }

  function touchDebugSession(session: DebugSession, patch: { status?: DebugSessionStatus; currentStep?: number; currentUrl?: string | null; browserContextId?: string | null } = {}) {
    const idleExpiresAt = nextDebugIdleExpiry(session.maxExpiresAt);
    database
      .prepare(
        `UPDATE debug_sessions
         SET status = ?, current_step = ?, current_url = ?, browser_context_id = ?, idle_expires_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.status ?? session.status,
        patch.currentStep ?? session.currentStep,
        patch.currentUrl === undefined ? session.currentUrl : patch.currentUrl,
        patch.browserContextId === undefined ? session.browserContextId : patch.browserContextId,
        idleExpiresAt,
        now(),
        session.id,
      );
    return debugSessionById(session.id);
  }

  function debugSessionResponse(session: DebugSession) {
    const agent = database
      .prepare(`SELECT id, name, browser_version, os, last_seen_at FROM agents WHERE id = ?`)
      .get(session.agentId) as { id: string; name: string; browser_version: string; os: string; last_seen_at: string | null } | undefined;
    const artifacts = database
      .prepare(`SELECT id, name, content_type, created_at FROM debug_artifacts WHERE session_id = ? ORDER BY created_at DESC LIMIT 100`)
      .all(session.id) as Array<{ id: string; name: string; content_type: string; created_at: string }>;
    const events = database
      .prepare(`SELECT id, kind, data, created_at FROM debug_session_events WHERE session_id = ? ORDER BY id DESC LIMIT 500`)
      .all(session.id) as Array<{ id: number; kind: string; data: string; created_at: string }>;
    return {
      ...session,
      agent: agent
        ? { id: agent.id, name: agent.name, browserVersion: agent.browser_version, os: agent.os, lastSeenAt: agent.last_seen_at }
        : undefined,
      artifacts: artifacts.map((artifact) => ({ id: artifact.id, name: artifact.name, contentType: artifact.content_type, createdAt: artifact.created_at })),
      events: events.reverse().map((event) => ({ id: event.id, kind: event.kind, data: parseJson<Record<string, unknown>>(event.data, {}), at: event.created_at })),
    };
  }

  function normalizeLocatorCandidates(value: unknown) {
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

  function pickerCaptureResponse(row: { id: string; session_id: string; candidates: string; target: string; status: string; captured_at: string; confirmed_at: string | null }) {
    return {
      id: row.id,
      sessionId: row.session_id,
      candidates: parseJson<LocatorCandidate[]>(row.candidates, []),
      target: row.target,
      status: row.status,
      capturedAt: row.captured_at,
      confirmedAt: row.confirmed_at,
    };
  }

  function debugSessionPayload(session: DebugSession) {
    const secretNames = Array.isArray(session.snapshot.secretNames)
      ? session.snapshot.secretNames.filter((value): value is string => typeof value === "string")
      : [];
    return {
      type: "debug.start",
      session: {
        id: session.id,
        projectId: session.projectId,
        revisionId: session.revisionId,
        environmentId: session.environmentId,
        currentStep: session.currentStep,
        snapshot: session.snapshot,
        secrets: secretValues(session.projectId, secretNames),
        idleExpiresAt: session.idleExpiresAt,
        maxExpiresAt: session.maxExpiresAt,
      },
    };
  }

  function agentOwnsDebugSession(agentId: string, sessionId: string) {
    const session = debugSessionById(sessionId);
    if (session.agentId !== agentId) throw new PlatformError(403, "DEBUG_SESSION_AGENT_MISMATCH");
    return session;
  }

  function expireDebugSessions() {
    const expired = database
      .prepare(
        `SELECT id, agent_id, status, idle_expires_at, max_expires_at
         FROM debug_sessions
         WHERE status IN ('requested', 'active', 'paused', 'ending')
           AND (idle_expires_at <= ? OR max_expires_at <= ?)`,
      )
      .all(now(), now()) as Array<{ id: string; agent_id: string; status: DebugSessionStatus; idle_expires_at: string; max_expires_at: string }>;
    for (const item of expired) {
      database.prepare(`UPDATE debug_sessions SET status = 'expired', updated_at = ? WHERE id = ?`).run(now(), item.id);
      appendDebugEvent(item.id, "session.expired", { idleExpiresAt: item.idle_expires_at, maxExpiresAt: item.max_expires_at });
      sendAgent(item.agent_id, { type: "debug.command", sessionId: item.id, command: "stop", reason: "SESSION_TIMEOUT" });
    }
  }

  function secretValues(projectId: string, requested: string[]) {
    if (requested.length === 0) return {};
    const rows = database
      .prepare(`SELECT name, iv, tag, ciphertext FROM project_secrets WHERE project_id = ? AND name IN (${requested.map(() => "?").join(",")})`)
      .all(projectId, ...requested) as Array<{ name: string; iv: string; tag: string; ciphertext: string }>;
    if (rows.length !== requested.length) throw new PlatformError(409, "RUN_SECRET_NOT_CONFIGURED");
    return Object.fromEntries(rows.map((row) => [row.name, decrypt(row)]));
  }

  function recoverExpiredLeases() {
    const expired = database
      .prepare(`SELECT id, run_id, agent_id FROM run_leases WHERE status IN ('offered', 'leased') AND expires_at <= ?`)
      .all(now()) as Array<{ id: string; run_id: string; agent_id: string }>;
    for (const lease of expired) {
      database.prepare(`UPDATE run_leases SET status = 'expired', updated_at = ? WHERE id = ?`).run(now(), lease.id);
      const run = runById(lease.run_id);
      if (run.cancellationRequested) {
        database.prepare(`UPDATE platform_runs SET status = 'canceled', updated_at = ? WHERE id = ?`).run(now(), run.id);
        appendRunEvent(run.id, "run.canceled_after_lease_expiry", { leaseId: lease.id });
        continue;
      }
      if (["success", "failed", "canceled"].includes(run.status)) continue;
      database.prepare(`UPDATE platform_runs SET status = 'queued', updated_at = ? WHERE id = ?`).run(now(), run.id);
      appendRunEvent(run.id, "lease.expired", { leaseId: lease.id, agentId: lease.agent_id });
      dispatchQueuedRun(run.id);
    }
  }

  function recoverStaleElementValidations() {
    const cutoff = new Date(Date.now() - agentOfflineAfterMs).toISOString();
    const stale = database
      .prepare(
        `SELECT v.id FROM element_validations v
         JOIN agents a ON a.id = v.agent_id
         WHERE v.status IN ('queued', 'running')
           AND (a.status != 'online' OR a.last_seen_at IS NULL OR a.last_seen_at <= ?)`,
      )
      .all(cutoff) as Array<{ id: string }>;
    for (const validation of stale) {
      database.prepare(`UPDATE element_validations SET status = 'failed', error = 'AGENT_UNAVAILABLE', updated_at = ? WHERE id = ?`).run(now(), validation.id);
    }
  }

  function candidateAgent(projectId: string, environmentId: string) {
    const cutoff = new Date(Date.now() - agentOfflineAfterMs).toISOString();
    const rows = database
      .prepare(
        `SELECT a.id, a.workspace_id, a.name, a.status, a.browser_version, a.os, a.max_concurrency, a.current_task, a.last_seen_at, a.created_at,
                COUNT(l.id) AS active_leases
         FROM agent_bindings b
          JOIN agents a ON a.id = b.agent_id
         LEFT JOIN run_leases l ON l.agent_id = a.id AND l.status IN ('offered', 'leased') AND l.expires_at > ?
          WHERE b.project_id = ? AND b.environment_id = ? AND b.is_default = 1 AND a.status = 'online' AND a.last_seen_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM debug_sessions d
              WHERE d.agent_id = a.id AND d.status IN ('requested', 'active', 'paused', 'ending')
            )
            AND NOT EXISTS (
              SELECT 1 FROM element_validations v
              WHERE v.agent_id = a.id AND v.status IN ('queued', 'running')
            )
         GROUP BY a.id
         HAVING COUNT(l.id) < a.max_concurrency
         ORDER BY COUNT(l.id) ASC, a.last_seen_at DESC`,
      )
      .all(now(), projectId, environmentId, cutoff) as Array<AgentRecord & { workspace_id: string; browser_version: string; max_concurrency: number; current_task: string | null; last_seen_at: string | null; created_at: string; active_leases: number }>;
    return rows[0] ? mapAgent(rows[0]) : undefined;
  }

  function dispatchQueuedRun(runId: string) {
    const run = runById(runId);
    if (run.cancellationRequested || run.status !== "queued") return undefined;
    const agent = candidateAgent(run.projectId, run.environmentId);
    if (!agent) return undefined;
    const attempts = database.prepare(`SELECT attempt FROM run_leases WHERE run_id = ?`).all(run.id) as Array<{ attempt: number }>;
    const lease: Lease = {
      id: randomUUID(),
      runId: run.id,
      agentId: agent.id,
      status: "offered",
      expiresAt: leaseExpiresAt(),
      attempt: Math.max(0, ...attempts.map((item) => item.attempt)) + 1,
    };
    database
      .prepare(`INSERT INTO run_leases (id, run_id, agent_id, status, expires_at, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(lease.id, lease.runId, lease.agentId, lease.status, lease.expiresAt, lease.attempt, now(), now());
    database.prepare(`UPDATE platform_runs SET agent_id = ?, status = 'dispatched', updated_at = ? WHERE id = ?`).run(agent.id, now(), run.id);
    appendRunEvent(run.id, "lease.offered", { leaseId: lease.id, agentId: agent.id, attempt: lease.attempt });
    const socket = sockets.get(agent.id);
    if (socket && socket.readyState === socket.OPEN) {
      const claimed = claimLease(agent);
      if (claimed) socket.send(json(agentRunPayload(claimed)));
    }
    return lease;
  }

  function dispatchWaitingRuns(projectId?: string) {
    recoverExpiredLeases();
    const query = projectId
      ? database.prepare(`SELECT id FROM platform_runs WHERE project_id = ? AND status = 'queued' AND cancellation_requested = 0 ORDER BY created_at ASC`)
      : database.prepare(`SELECT id FROM platform_runs WHERE status = 'queued' AND cancellation_requested = 0 ORDER BY created_at ASC`);
    const rows = (projectId ? query.all(projectId) : query.all()) as Array<{ id: string }>;
    for (const row of rows) dispatchQueuedRun(row.id);
  }

  function agentRunPayload(lease: Lease) {
    const run = runById(lease.runId);
    const secretNames = Array.isArray(run.snapshot.secretNames)
      ? run.snapshot.secretNames.filter((value): value is string => typeof value === "string")
      : [];
    return {
      type: "run.lease",
      lease: { id: lease.id, expiresAt: lease.expiresAt, attempt: lease.attempt },
      run: {
        id: run.id,
        projectId: run.projectId,
        revisionId: run.revisionId,
        environmentId: run.environmentId,
        snapshot: run.snapshot,
        secrets: secretValues(run.projectId, secretNames),
      },
    };
  }

  function agentValidationPayload(validation: ElementValidation) {
    const document = documentFor(validation.projectId);
    const environments = Array.isArray(document.data.environments) ? document.data.environments.map(asRecord) : [];
    const environment = environments.find((item) => item.id === validation.environmentId);
    if (!environment) throw new PlatformError(404, "ENVIRONMENT_NOT_FOUND");
    return {
      type: "validation.start",
      validation: {
        id: validation.id,
        projectId: validation.projectId,
        environmentId: validation.environmentId,
        environment,
        element: validation.element,
      },
    };
  }

  function sendAgent(agentId: string, message: Record<string, unknown>) {
    const socket = sockets.get(agentId);
    if (!socket || socket.readyState !== socket.OPEN) return false;
    socket.send(json(message));
    return true;
  }

  function deliverElementValidations(agent: AgentRecord) {
    const rows = database
      .prepare(`SELECT id FROM element_validations WHERE agent_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1`)
      .all(agent.id) as Array<{ id: string }>;
    const validation = rows[0] ? elementValidationById(rows[0].id) : undefined;
    return validation ? sendAgent(agent.id, agentValidationPayload(validation)) : false;
  }

  function sendConfirmedDebugCommand(agentId: string, sessionId: string, command: string) {
    const commandId = randomUUID();
    return new Promise<{ accepted: boolean; reason?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        if (!pendingDebugCommands.delete(commandId)) return;
        resolve({ accepted: false, reason: "DEBUG_COMMAND_ACK_TIMEOUT" });
      }, 5_000);
      timeout.unref();
      pendingDebugCommands.set(commandId, { agentId, resolve, timeout });
      if (sendAgent(agentId, { type: "debug.command", sessionId, command, commandId })) return;
      clearTimeout(timeout);
      pendingDebugCommands.delete(commandId);
      resolve({ accepted: false, reason: "DEBUG_AGENT_DISCONNECTED" });
    });
  }

  function deliverDebugSessions(agent: AgentRecord) {
    const rows = database
      .prepare(`SELECT id FROM debug_sessions WHERE agent_id = ? AND status IN ('requested', 'active', 'paused', 'ending', 'expired') ORDER BY created_at ASC`)
      .all(agent.id) as Array<{ id: string }>;
    for (const row of rows) {
      const session = debugSessionById(row.id);
      if (session.status === "requested") {
        sendAgent(agent.id, debugSessionPayload(session));
      } else if (session.status === "expired") {
        sendAgent(agent.id, { type: "debug.command", sessionId: session.id, command: "stop", reason: "SESSION_TIMEOUT" });
      } else {
        sendAgent(agent.id, { type: "debug.reconnect", sessionId: session.id });
      }
    }
  }

  function claimLease(agent: AgentRecord) {
    recoverExpiredLeases();
    const row = database
      .prepare(`SELECT id, run_id, agent_id, status, expires_at, attempt FROM run_leases WHERE agent_id = ? AND status = 'offered' AND expires_at > ? ORDER BY created_at ASC LIMIT 1`)
      .get(agent.id, now()) as { id: string; run_id: string; agent_id: string; status: LeaseStatus; expires_at: string; attempt: number } | undefined;
    if (!row) return undefined;
    const lease: Lease = { id: row.id, runId: row.run_id, agentId: row.agent_id, status: row.status, expiresAt: row.expires_at, attempt: row.attempt };
    database.prepare(`UPDATE run_leases SET status = 'leased', expires_at = ?, updated_at = ? WHERE id = ? AND status = 'offered'`).run(leaseExpiresAt(), now(), lease.id);
    const updated = activeLeaseForRun(lease.runId);
    if (!updated || updated.status !== "leased") return undefined;
    database.prepare(`UPDATE platform_runs SET status = 'running', updated_at = ? WHERE id = ?`).run(now(), lease.runId);
    database.prepare(`UPDATE agents SET current_task = ? WHERE id = ?`).run(lease.runId, agent.id);
    appendRunEvent(lease.runId, "lease.claimed", { leaseId: lease.id, agentId: agent.id });
    return { ...updated, status: "leased" as const };
  }

  function processAgentMessage(agent: AgentRecord, raw: unknown) {
    const message = asRecord(raw);
    const type = typeof message.type === "string" ? message.type : "";
    if (type === "heartbeat") {
      updateAgentHeartbeat(agent, asRecord(message));
      recoverStaleElementValidations();
      dispatchWaitingRuns();
      expireDebugSessions();
      if (deliverElementValidations(agent)) return { type: "validation.dispatched", at: now() };
      const lease = claimLease(agent);
      return lease ? agentRunPayload(lease) : { type: "heartbeat.ack", at: now() };
    }
    if (type === "ready") {
      updateAgentHeartbeat(agent, asRecord(message));
      recoverStaleElementValidations();
      dispatchWaitingRuns();
      expireDebugSessions();
      deliverDebugSessions(agent);
      if (deliverElementValidations(agent)) return { type: "validation.dispatched", at: now() };
      const lease = claimLease(agent);
      return lease ? agentRunPayload(lease) : { type: "idle", at: now() };
    }
    if (type === "debug.command.ack") {
      const commandId = typeof message.commandId === "string" ? message.commandId : "";
      const pending = pendingDebugCommands.get(commandId);
      if (!pending || pending.agentId !== agent.id) return { type: "debug.command.ack", commandId, ignored: true };
      clearTimeout(pending.timeout);
      pendingDebugCommands.delete(commandId);
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
      const accepted = message.accepted === true;
      const reason = typeof message.reason === "string" ? message.reason.slice(0, 160) : undefined;
      if (sessionId) appendDebugEvent(sessionId, accepted ? "command.acknowledged" : "command.rejected", { command: message.command, commandId, reason });
      pending.resolve({ accepted, reason });
      return { type: "debug.command.ack", commandId, accepted };
    }
    if (type === "debug.ready") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
      const session = agentOwnsDebugSession(agent.id, sessionId);
      if (session.status === "expired" || session.status === "ended") {
        return { type: "debug.command", sessionId, command: "stop", reason: "SESSION_CLOSED" };
      }
      const updated = touchDebugSession(session, {
        status: "paused",
        currentStep: typeof message.currentStep === "number" && Number.isInteger(message.currentStep) ? message.currentStep : session.currentStep,
        currentUrl: typeof message.currentUrl === "string" ? message.currentUrl.slice(0, 2048) : session.currentUrl,
        browserContextId: typeof message.browserContextId === "string" ? message.browserContextId.slice(0, 160) : session.browserContextId,
      });
      database.prepare(`UPDATE agents SET current_task = ? WHERE id = ?`).run(session.id, agent.id);
      appendDebugEvent(session.id, "session.ready", { currentStep: updated.currentStep, currentUrl: updated.currentUrl });
      return { type: "debug.ready.ack", sessionId, status: updated.status };
    }
    if (type === "picker.captured") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
      const session = agentOwnsDebugSession(agent.id, sessionId);
      if (["ended", "failed", "expired"].includes(session.status)) return { type: "picker.rejected", sessionId, reason: "DEBUG_SESSION_CLOSED" };
      const candidates = normalizeLocatorCandidates(message.candidates);
      if (candidates.length === 0) return { type: "picker.rejected", sessionId, reason: "PICKER_CANDIDATES_REQUIRED" };
      const capture = { id: randomUUID(), target: typeof message.target === "string" ? message.target.slice(0, 240) : "" };
      database.prepare(`INSERT INTO picker_captures (id, session_id, candidates, target, status, captured_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(capture.id, session.id, json(candidates), capture.target, now());
      appendDebugEvent(session.id, "picker.captured", { captureId: capture.id, candidateCount: candidates.length, target: capture.target });
      return { type: "picker.captured.ack", sessionId, captureId: capture.id };
    }
    if (type === "picker.previewed") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
      const session = agentOwnsDebugSession(agent.id, sessionId);
      appendDebugEvent(session.id, "picker.previewed", { captureId: message.captureId, candidateIndex: message.candidateIndex, count: message.count });
      return { type: "picker.previewed.ack", sessionId };
    }
    if (type === "debug.state") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
      const session = agentOwnsDebugSession(agent.id, sessionId);
      if (["ended", "failed", "expired"].includes(session.status)) return { type: "debug.command", sessionId, command: "stop", reason: "SESSION_CLOSED" };
      const reportedStatus: DebugSessionStatus = message.status === "active" || message.status === "paused" ? message.status : session.status;
      const updated = touchDebugSession(session, {
        status: reportedStatus,
        currentStep: typeof message.currentStep === "number" && Number.isInteger(message.currentStep) ? message.currentStep : session.currentStep,
        currentUrl: typeof message.currentUrl === "string" ? message.currentUrl.slice(0, 2048) : session.currentUrl,
      });
      appendDebugEvent(session.id, "session.state", { status: updated.status, currentStep: updated.currentStep, currentUrl: updated.currentUrl });
      return { type: "debug.state.ack", sessionId };
    }
    if (type === "debug.event") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
      const session = agentOwnsDebugSession(agent.id, sessionId);
      if (["ended", "failed", "expired"].includes(session.status)) return { type: "debug.command", sessionId, command: "stop", reason: "SESSION_CLOSED" };
      const updated = touchDebugSession(session, {
        currentStep: typeof message.currentStep === "number" && Number.isInteger(message.currentStep) ? message.currentStep : session.currentStep,
        currentUrl: typeof message.currentUrl === "string" ? message.currentUrl.slice(0, 2048) : session.currentUrl,
      });
      appendDebugEvent(updated.id, typeof message.kind === "string" ? message.kind : "debug.event", asRecord(message.data));
      return { type: "debug.event.ack", sessionId };
    }
    if (type === "debug.ended") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
      const session = agentOwnsDebugSession(agent.id, sessionId);
      const status: DebugSessionStatus = session.status === "expired" ? "expired" : message.status === "failed" ? "failed" : "ended";
      database.prepare(`UPDATE debug_sessions SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), session.id);
      database.prepare(`UPDATE agents SET current_task = NULL WHERE id = ?`).run(agent.id);
      appendDebugEvent(session.id, "session.ended", { status, reason: typeof message.reason === "string" ? message.reason.slice(0, 500) : undefined });
      dispatchWaitingRuns();
      return { type: "debug.ended.ack", sessionId, status };
    }
    if (type === "lease.renew") {
      const leaseId = typeof message.leaseId === "string" ? message.leaseId : "";
      const lease = database
        .prepare(`SELECT id, run_id, agent_id, status, expires_at, attempt FROM run_leases WHERE id = ? AND agent_id = ?`)
        .get(leaseId, agent.id) as { id: string; run_id: string; agent_id: string; status: LeaseStatus; expires_at: string; attempt: number } | undefined;
      if (!lease || lease.status !== "leased") return { type: "lease.rejected", leaseId, reason: "LEASE_NOT_ACTIVE" };
      const run = runById(lease.run_id);
      if (run.cancellationRequested) return { type: "run.cancel", leaseId, runId: run.id };
      const expiresAt = leaseExpiresAt();
      database.prepare(`UPDATE run_leases SET expires_at = ?, updated_at = ? WHERE id = ?`).run(expiresAt, now(), lease.id);
      return { type: "lease.renewed", leaseId, expiresAt };
    }
    if (type === "run.event") {
      const leaseId = typeof message.leaseId === "string" ? message.leaseId : "";
      const lease = activeLeaseForAgent(agent.id, leaseId);
      if (!lease) return { type: "lease.rejected", leaseId, reason: "LEASE_NOT_ACTIVE" };
      const eventKind = typeof message.kind === "string" ? message.kind.slice(0, 80) : "agent.event";
      appendRunEvent(lease.runId, eventKind, redactRunValue(runById(lease.runId), asRecord(message.data)) as Record<string, unknown>);
      return { type: "event.ack", leaseId };
    }
    if (type === "run.complete") {
      const leaseId = typeof message.leaseId === "string" ? message.leaseId : "";
      const lease = activeLeaseForAgent(agent.id, leaseId);
      if (!lease) return { type: "lease.rejected", leaseId, reason: "LEASE_NOT_ACTIVE" };
      const run = runById(lease.runId);
      const requestedStatus = message.status === "success" || message.status === "failed" ? message.status : "failed";
      const status: PlatformRunStatus = run.cancellationRequested ? "canceled" : requestedStatus;
      const result = redactRunValue(run, asRecord(message.result)) as Record<string, unknown>;
      const allowedOutputs = publicFlowOutputNames(run);
      const suppliedOutputs = asRecord(result.flowOutputs);
      const publishedOutputs = Object.fromEntries(
        Object.entries(suppliedOutputs).filter(([name]) => allowedOutputs.has(name)),
      );
      if (Object.keys(publishedOutputs).length > 0) result.flowOutputs = publishedOutputs;
      else delete result.flowOutputs;
      const sensitiveFlowOutputs = Array.isArray(result.sensitiveFlowOutputs)
        ? result.sensitiveFlowOutputs.filter((item): item is string => typeof item === "string").slice(0, 200)
        : [];
      if (sensitiveFlowOutputs.length > 0) result.sensitiveFlowOutputs = sensitiveFlowOutputs;
      else delete result.sensitiveFlowOutputs;
      database.prepare(`UPDATE run_leases SET status = 'completed', updated_at = ? WHERE id = ?`).run(now(), lease.id);
      database.prepare(`UPDATE platform_runs SET status = ?, result = ?, updated_at = ? WHERE id = ?`).run(status, json(result), now(), run.id);
      database.prepare(`UPDATE agents SET current_task = NULL WHERE id = ?`).run(agent.id);
      persistFlowOutputs(run, result);
      appendRunEvent(run.id, "run.complete", { status, result });
      queueRunDeliveries(runById(run.id), status);
      dispatchWaitingRuns(run.projectId);
      return { type: "run.complete.ack", leaseId, status };
    }
    if (type === "validation.started") {
      const validationId = typeof message.validationId === "string" ? message.validationId : "";
      const validation = elementValidationById(validationId);
      if (validation.agentId !== agent.id) throw new PlatformError(403, "VALIDATION_AGENT_MISMATCH");
      if (validation.status !== "queued") return { type: "validation.rejected", validationId, reason: "VALIDATION_NOT_QUEUED" };
      database.prepare(`UPDATE element_validations SET status = 'running', updated_at = ? WHERE id = ?`).run(now(), validation.id);
      database.prepare(`UPDATE agents SET current_task = ? WHERE id = ?`).run(`validation:${validation.id}`, agent.id);
      return { type: "validation.started.ack", validationId };
    }
    if (type === "validation.complete") {
      const validationId = typeof message.validationId === "string" ? message.validationId : "";
      const validation = elementValidationById(validationId);
      if (validation.agentId !== agent.id) throw new PlatformError(403, "VALIDATION_AGENT_MISMATCH");
      const requestedStatus = message.status === "success" ? "success" : "failed";
      const result = asRecord(message.result);
      const count = Number(result.count);
      const normalized = {
        count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
        firstMatch: typeof result.firstMatch === "string" ? result.firstMatch.slice(0, 2_000) : undefined,
        elapsedMs: Number.isFinite(Number(result.elapsedMs)) ? Math.max(0, Math.floor(Number(result.elapsedMs))) : 0,
      };
      const error = typeof message.error === "string" ? message.error.slice(0, 500) : null;
      database.prepare(`UPDATE element_validations SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?`).run(requestedStatus, json(normalized), error, now(), validation.id);
      database.prepare(`UPDATE agents SET current_task = NULL WHERE id = ?`).run(agent.id);
      dispatchWaitingRuns(validation.projectId);
      return { type: "validation.complete.ack", validationId, status: requestedStatus };
    }
    return { type: "error", error: "AGENT_MESSAGE_UNSUPPORTED" };
  }

  function activeLeaseForAgent(agentId: string, leaseId: string) {
    const row = database
      .prepare(`SELECT id, run_id, agent_id, status, expires_at, attempt FROM run_leases WHERE id = ? AND agent_id = ? AND status = 'leased' AND expires_at > ?`)
      .get(leaseId, agentId, now()) as { id: string; run_id: string; agent_id: string; status: LeaseStatus; expires_at: string; attempt: number } | undefined;
    return row ? { id: row.id, runId: row.run_id, agentId: row.agent_id, status: row.status, expiresAt: row.expires_at, attempt: row.attempt } : undefined;
  }

  function createWorkspace(user: AuthUser, name: string) {
    const workspace = { id: randomUUID(), name: name.trim().slice(0, 120) || "My workspace", createdAt: now() };
    database.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)`).run(workspace.id, workspace.name, workspace.createdAt);
    database.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')`).run(workspace.id, user.id);
    audit(workspace.id, { type: "user", id: user.id }, "workspace.created", { type: "workspace", id: workspace.id }, { name: workspace.name });
    return workspace;
  }

  function createWorkspaceInvitation(workspaceId: string, userId: string, createdBy: string) {
    const token = `wsi_${randomBytes(32).toString("base64url")}`;
    const createdAt = now();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
    database.prepare(`
      INSERT INTO workspace_invitations (id, workspace_id, user_id, token_hash, expires_at, accepted_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET
        id = excluded.id,
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        accepted_at = NULL,
        created_by = excluded.created_by,
        created_at = excluded.created_at
    `).run(randomUUID(), workspaceId, userId, digest(token), expiresAt, createdBy, createdAt);
    return { token, expiresAt };
  }

  function projectResponse(row: { id: string; workspace_id: string; source_project_id?: string | null; slug: string; name: string; description: string; archived_at: string | null; created_at: string; updated_at: string }) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      sourceProjectId: row.source_project_id ?? undefined,
      slug: row.slug,
      name: row.name,
      description: row.description,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      recoverExpiredLeases();
      recoverStaleElementValidations();
      expireDebugSessions();
      processDueSchedules();
      if (url.pathname === "/api/platform/health" && request.method === "GET") {
        const agents = database.prepare(`SELECT COUNT(*) AS count FROM agents WHERE status = 'online'`).get() as { count: number };
        sendJson(response, 200, { ok: true, service: "platform", onlineAgents: agents.count });
        return true;
      }

      const publicWebhook = url.pathname.match(/^\/api\/platform\/webhooks\/([^/]+)$/);
      if (publicWebhook && request.method === "POST") {
        const triggerId = decodeURIComponent(publicWebhook[1]);
        const timestamp = Array.isArray(request.headers["x-autoflow-timestamp"]) ? request.headers["x-autoflow-timestamp"][0] : request.headers["x-autoflow-timestamp"];
        const signature = Array.isArray(request.headers["x-autoflow-signature"]) ? request.headers["x-autoflow-signature"][0] : request.headers["x-autoflow-signature"];
        const deliveryId = Array.isArray(request.headers["x-autoflow-delivery-id"]) ? request.headers["x-autoflow-delivery-id"][0] : request.headers["x-autoflow-delivery-id"];
        if (!timestamp || !signature || !deliveryId || !/^\d{10,13}$/.test(timestamp) || deliveryId.length > 160) {
          throw new PlatformError(401, "WEBHOOK_SIGNATURE_REQUIRED");
        }
        const timestampMs = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
        if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > webhookTimestampToleranceMs) {
          throw new PlatformError(401, "WEBHOOK_TIMESTAMP_INVALID");
        }
        const body = await readBody(request, 1_000_000);
        const trigger = database.prepare(`SELECT id, project_id, revision_id, environment_id, dataset_version_id, enabled, signing_secret_iv, signing_secret_tag, signing_secret_ciphertext FROM webhook_triggers WHERE id = ?`).get(triggerId) as { id: string; project_id: string; revision_id: string; environment_id: string; dataset_version_id: string | null; enabled: number; signing_secret_iv: string | null; signing_secret_tag: string | null; signing_secret_ciphertext: string | null } | undefined;
        if (!trigger || !trigger.enabled) throw new PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND");
        if (!trigger.signing_secret_iv || !trigger.signing_secret_tag || !trigger.signing_secret_ciphertext) throw new PlatformError(409, "WEBHOOK_SIGNING_SECRET_REQUIRED");
        const secret = decrypt({ iv: trigger.signing_secret_iv, tag: trigger.signing_secret_tag, ciphertext: trigger.signing_secret_ciphertext });
        if (!webhookSignatureMatches(secret, timestamp, body, signature)) throw new PlatformError(401, "WEBHOOK_SIGNATURE_INVALID");
        if (!allowWebhookRequest(trigger.id)) throw new PlatformError(429, "WEBHOOK_RATE_LIMITED");
        const delivery = database.prepare(`INSERT OR IGNORE INTO webhook_deliveries (trigger_id, delivery_id, received_at) VALUES (?, ?, ?)`).run(trigger.id, deliveryId, now());
        if (delivery.changes === 0) {
          sendJson(response, 202, { accepted: true, duplicate: true, runIds: [] });
          return true;
        }
        let queued: ReturnType<typeof queuePublishedRuns>;
        try {
          queued = queuePublishedRuns({ projectId: trigger.project_id, revisionId: trigger.revision_id, environmentId: trigger.environment_id, datasetVersionId: trigger.dataset_version_id ?? undefined, createdBy: `webhook:${trigger.id}`, source: "webhook", maxRuns: webhookMaxRuns });
        } catch (error) {
          database.prepare(`DELETE FROM webhook_deliveries WHERE trigger_id = ? AND delivery_id = ?`).run(trigger.id, deliveryId);
          throw error;
        }
        database.prepare(`UPDATE webhook_triggers SET last_triggered_at = ? WHERE id = ?`).run(now(), trigger.id);
        const project = projectFor(trigger.project_id);
        audit(project.workspace_id, { type: "system", id: `webhook:${trigger.id}` }, "webhook.triggered", { type: "webhook_trigger", id: trigger.id }, { runIds: queued.runIds }, trigger.project_id);
        sendJson(response, 202, { accepted: true, runIds: queued.runIds });
        return true;
      }

      if (url.pathname === "/api/auth/register" && request.method === "POST") {
        const body = await readJson<{ email?: string; name?: string; password?: string; invitationToken?: string }>(request);
        const email = body.email?.trim().toLowerCase();
        const password = body.password?.trim();
        if (!email || !email.includes("@") || !password || password.length < 8) throw new PlatformError(400, "REGISTER_INPUT_INVALID");
        let user = database.prepare(`SELECT id, email, name FROM platform_users WHERE email = ?`).get(email) as AuthUser | undefined;
        if (user) {
          const existingCredential = database.prepare(`SELECT user_id FROM platform_user_credentials WHERE user_id = ?`).get(user.id) as { user_id: string } | undefined;
          if (existingCredential) throw new PlatformError(409, "EMAIL_ALREADY_REGISTERED");
          const invitationToken = body.invitationToken?.trim();
          if (!invitationToken) throw new PlatformError(409, "INVITATION_VERIFICATION_REQUIRED");
          const invitation = database.prepare(`
            SELECT id FROM workspace_invitations
            WHERE user_id = ? AND token_hash = ? AND accepted_at IS NULL AND expires_at > ?
          `).get(user.id, digest(invitationToken), now()) as { id: string } | undefined;
          if (!invitation) throw new PlatformError(409, "INVITATION_TOKEN_INVALID");
          const created = now();
          database.prepare(`INSERT INTO platform_user_credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run(user.id, passwordHash(password), created, created);
          database.prepare(`UPDATE workspace_invitations SET accepted_at = ? WHERE id = ?`).run(created, invitation.id);
        } else {
          user = { id: randomUUID(), email, name: body.name?.trim().slice(0, 100) || email.split("@")[0] };
          database.prepare(`INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)`).run(user.id, user.email, user.name, now());
          const created = now();
          database.prepare(`INSERT INTO platform_user_credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run(user.id, passwordHash(password), created, created);
          createWorkspace(user, `${user.name}'s workspace`);
        }
        const session = createAuthSession(user);
        sendJson(response, 201, session);
        return true;
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const body = await readJson<{ email?: string; password?: string }>(request);
        const email = body.email?.trim().toLowerCase();
        const password = body.password?.trim();
        if (!email || !email.includes("@") || !password) throw new PlatformError(400, "LOGIN_INPUT_INVALID");
        const user = database.prepare(`SELECT id, email, name FROM platform_users WHERE email = ?`).get(email) as AuthUser | undefined;
        const credential = user ? database.prepare(`SELECT password_hash FROM platform_user_credentials WHERE user_id = ?`).get(user.id) as { password_hash: string } | undefined : undefined;
        if (!user || !credential || !passwordMatches(password, credential.password_hash)) throw new PlatformError(401, "LOGIN_INVALID");
        sendJson(response, 200, createAuthSession(user));
        return true;
      }

      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        const user = sessionUser(request);
        const workspaces = database
          .prepare(`SELECT w.id, w.name, w.created_at, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC`)
          .all(user.id) as Array<{ id: string; name: string; created_at: string; role: Role }>;
        sendJson(response, 200, { user, workspaces: workspaces.map((item) => ({ id: item.id, name: item.name, createdAt: item.created_at, role: item.role })) });
        return true;
      }

      if (url.pathname === "/api/workspaces" && request.method === "GET") {
        const user = sessionUser(request);
        const workspaces = database
          .prepare(`SELECT w.id, w.name, w.created_at, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC`)
          .all(user.id) as Array<{ id: string; name: string; created_at: string; role: Role }>;
        sendJson(response, 200, { workspaces: workspaces.map((item) => ({ id: item.id, name: item.name, createdAt: item.created_at, role: item.role })) });
        return true;
      }

      if (url.pathname === "/api/workspaces" && request.method === "POST") {
        const user = sessionUser(request);
        const body = await readJson<{ name?: string }>(request);
        if (!body.name?.trim()) throw new PlatformError(400, "WORKSPACE_NAME_REQUIRED");
        sendJson(response, 201, { workspace: createWorkspace(user, body.name) });
        return true;
      }

      const workspaceMembers = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members$/);
      if (workspaceMembers) {
        const user = sessionUser(request);
        const workspaceId = decodeURIComponent(workspaceMembers[1]);
        const actorRole = requireWorkspaceRole(workspaceId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          const members = database.prepare(
            `SELECT u.id, u.email, u.name, m.role FROM workspace_members m
             JOIN platform_users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, u.email`,
          ).all(workspaceId) as Array<{ id: string; email: string; name: string; role: Role }>;
          sendJson(response, 200, { members });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ email?: string; name?: string; role?: Role }>(request);
          const email = body.email?.trim().toLowerCase();
          const role = normalizeRole(body.role ?? "viewer");
          if (!email || !email.includes("@")) throw new PlatformError(400, "WORKSPACE_MEMBER_EMAIL_INVALID");
          if (role === "owner" && actorRole !== "owner") throw new PlatformError(403, "WORKSPACE_OWNER_REQUIRED");
          let member = database.prepare(`SELECT id, email, name FROM platform_users WHERE email = ?`).get(email) as AuthUser | undefined;
          if (!member) {
            member = { id: randomUUID(), email, name: body.name?.trim().slice(0, 100) || email.split("@")[0] };
            database.prepare(`INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)`).run(member.id, member.email, member.name, now());
          }
          const existing = database.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).get(workspaceId, member.id) as { role: Role } | undefined;
          if (existing?.role === "owner" && actorRole !== "owner") throw new PlatformError(403, "WORKSPACE_OWNER_REQUIRED");
          database.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`).run(workspaceId, member.id, role);
          const pendingInvitation = database.prepare(`SELECT user_id FROM platform_user_credentials WHERE user_id = ?`).get(member.id) as { user_id: string } | undefined;
          const invitation = pendingInvitation ? undefined : createWorkspaceInvitation(workspaceId, member.id, user.id);
          audit(workspaceId, { type: "user", id: user.id }, existing ? "workspace_member.role_changed" : "workspace_member.added", { type: "member", id: member.id }, { email, role });
          sendJson(response, existing ? 200 : 201, { member: { ...member, role }, invitationToken: invitation?.token, invitationExpiresAt: invitation?.expiresAt });
          return true;
        }
      }

      const workspaceMember = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/);
      if (workspaceMember && (request.method === "PATCH" || request.method === "DELETE")) {
        const user = sessionUser(request);
        const workspaceId = decodeURIComponent(workspaceMember[1]);
        const memberId = decodeURIComponent(workspaceMember[2]);
        const actorRole = requireWorkspaceRole(workspaceId, user.id, true);
        const member = database.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).get(workspaceId, memberId) as { role: Role } | undefined;
        if (!member) throw new PlatformError(404, "WORKSPACE_MEMBER_NOT_FOUND");
        if (member.role === "owner" && actorRole !== "owner") throw new PlatformError(403, "WORKSPACE_OWNER_REQUIRED");
        if (request.method === "PATCH") {
          const body = await readJson<{ role?: Role }>(request);
          const role = normalizeRole(body.role);
          if (role === "owner" && actorRole !== "owner") throw new PlatformError(403, "WORKSPACE_OWNER_REQUIRED");
          if (member.role === "owner" && role !== "owner") {
            const owners = database.prepare(`SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND role = 'owner'`).get(workspaceId) as { count: number };
            if (owners.count <= 1) throw new PlatformError(409, "WORKSPACE_OWNER_REQUIRED");
          }
          database.prepare(`UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`).run(role, workspaceId, memberId);
          audit(workspaceId, { type: "user", id: user.id }, "workspace_member.role_changed", { type: "member", id: memberId }, { role });
          sendJson(response, 200, { memberId, role });
          return true;
        }
        if (member.role === "owner") {
          const owners = database.prepare(`SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND role = 'owner'`).get(workspaceId) as { count: number };
          if (owners.count <= 1) throw new PlatformError(409, "WORKSPACE_OWNER_REQUIRED");
        }
        database.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).run(workspaceId, memberId);
        audit(workspaceId, { type: "user", id: user.id }, "workspace_member.removed", { type: "member", id: memberId });
        sendJson(response, 200, { memberId, removed: true });
        return true;
      }

      const workspaceProjects = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/projects$/);
      if (workspaceProjects) {
        const user = sessionUser(request);
        const workspaceId = decodeURIComponent(workspaceProjects[1]);
        if (request.method === "GET") {
          requireWorkspaceRole(workspaceId, user.id);
          const projects = database
            .prepare(`SELECT id, workspace_id, source_project_id, slug, name, description, archived_at, created_at, updated_at FROM platform_projects WHERE workspace_id = ? AND archived_at IS NULL ORDER BY updated_at DESC`)
            .all(workspaceId) as Array<{ id: string; workspace_id: string; source_project_id: string | null; slug: string; name: string; description: string; archived_at: string | null; created_at: string; updated_at: string }>;
          sendJson(response, 200, { projects: projects.map(projectResponse) });
          return true;
        }
        if (request.method === "POST") {
          requireWorkspaceRole(workspaceId, user.id, true);
          const body = await readJson<{ name?: string; description?: string; slug?: string }>(request);
          if (!body.name?.trim()) throw new PlatformError(400, "PROJECT_NAME_REQUIRED");
          const project = {
            id: randomUUID(),
            workspaceId,
            slug: cleanProjectSlug(body.slug ?? body.name),
            name: body.name.trim().slice(0, 160),
            description: body.description?.trim().slice(0, 1000) ?? "",
            createdAt: now(),
          };
          try {
            database.prepare(`INSERT INTO platform_projects (id, workspace_id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(project.id, project.workspaceId, project.slug, project.name, project.description, project.createdAt, project.createdAt);
          } catch {
            throw new PlatformError(409, "PROJECT_SLUG_EXISTS");
          }
          putDocument(project.id, {});
          audit(workspaceId, { type: "user", id: user.id }, "project.created", { type: "project", id: project.id }, { name: project.name }, project.id);
          sendJson(response, 201, { project });
          return true;
        }
      }

      const importRoute = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/imports\/local-storage$/);
      if (importRoute && request.method === "POST") {
        const user = sessionUser(request);
        const workspaceId = decodeURIComponent(importRoute[1]);
        requireWorkspaceRole(workspaceId, user.id, true);
        const body = await readJson<{ sourceId?: string; data?: Record<string, unknown> }>(request, 5_000_000);
        const sourceId = body.sourceId?.trim();
        if (!sourceId) throw new PlatformError(400, "IMPORT_SOURCE_ID_REQUIRED");
        const existing = database.prepare(`SELECT result FROM platform_imports WHERE workspace_id = ? AND source_id = ?`).get(workspaceId, sourceId) as { result: string } | undefined;
        const existingProjects = existing ? parseJson<{ projects?: Array<{ sourceProjectId: string; projectId: string }> }>(existing.result, {}) : {};
        const existingMap = new Map((existingProjects.projects ?? []).map((item) => [item.sourceProjectId, item.projectId]));
        const source = asRecord(body.data);
        const projects = Array.isArray(source.projects) ? source.projects.map(asRecord) : [];
        const importedProjects: Array<{ sourceProjectId: string; projectId: string }> = [];
        let createdProjects = 0;
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const sourceProject of projects) {
            const name = typeof sourceProject.name === "string" ? sourceProject.name.trim() : "";
            const sourceProjectId = typeof sourceProject.id === "string" ? sourceProject.id : randomUUID();
            if (!name) continue;
            let projectId = existingMap.get(sourceProjectId);
            if (projectId) {
              const current = database.prepare(`SELECT id FROM platform_projects WHERE id = ? AND workspace_id = ?`).get(projectId, workspaceId) as { id: string } | undefined;
              if (!current) projectId = undefined;
            }
            if (!projectId) {
              const existingSource = database
                .prepare(`SELECT id FROM platform_projects WHERE workspace_id = ? AND source_project_id = ?`)
                .get(workspaceId, sourceProjectId) as { id: string } | undefined;
              projectId = existingSource?.id;
            }
            if (!projectId) {
              projectId = randomUUID();
              let slug = cleanProjectSlug(`${name}-${sourceProjectId.slice(0, 6)}`);
              let suffix = 2;
              while (database.prepare(`SELECT id FROM platform_projects WHERE workspace_id = ? AND slug = ?`).get(workspaceId, slug)) {
                slug = `${cleanProjectSlug(name)}-${suffix++}`;
              }
              database.prepare(`INSERT INTO platform_projects (id, workspace_id, source_project_id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(projectId, workspaceId, sourceProjectId, slug, name.slice(0, 160), typeof sourceProject.description === "string" ? sourceProject.description.slice(0, 1000) : "", now(), now());
              createdProjects += 1;
            } else {
              database.prepare(`UPDATE platform_projects SET source_project_id = COALESCE(source_project_id, ?), archived_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`)
                .run(sourceProjectId, now(), projectId, workspaceId);
            }
            const data = {
              sourceProjectId,
              flows: asRecord(source.flowsByProject)[sourceProjectId] ?? [],
              elements: asRecord(source.elementsByProject)[sourceProjectId] ?? [],
              variables: asRecord(source.variablesByProject)[sourceProjectId] ?? [],
              environments: asRecord(source.environmentsByProject)[sourceProjectId] ?? [],
              activeEnvironmentId: asRecord(source.activeEnvironmentByProject)[sourceProjectId] ?? "",
              members: asRecord(source.membersByProject)[sourceProjectId] ?? [],
            };
            const document = documentFor(projectId);
            if (document.version === 0) {
              putDocument(projectId, data);
            } else if (typeof document.data.sourceProjectId !== "string") {
              putDocument(projectId, { ...document.data, sourceProjectId }, document.version);
            }
            importedProjects.push({ sourceProjectId, projectId });
          }
          const result = { projects: importedProjects };
          database.prepare(`INSERT INTO platform_imports (id, workspace_id, source_id, imported_at, result) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, source_id) DO UPDATE SET imported_at = excluded.imported_at, result = excluded.result`)
            .run(randomUUID(), workspaceId, sourceId, now(), json(result));
          database.exec("COMMIT");
          audit(workspaceId, { type: "user", id: user.id }, "workspace.local_storage_imported", { type: "import", id: sourceId }, { count: importedProjects.length });
          sendJson(response, createdProjects > 0 ? 201 : 200, { imported: createdProjects > 0, ...result });
          return true;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }

      const projectBase = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)$/);
      if (projectBase) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(projectBase[1]);
        const { project } = request.method === "GET" ? requireProjectRole(projectId, user.id) : requireProjectAdmin(projectId, user.id);
        if (request.method === "GET") {
          sendJson(response, 200, { project: projectResponse(project) });
          return true;
        }
        if (request.method === "PATCH") {
          const body = await readJson<{ name?: string; description?: string; archived?: boolean }>(request);
          const name = body.name?.trim().slice(0, 160) || project.name;
          const description = body.description === undefined ? project.description : body.description.trim().slice(0, 1000);
          const archivedAt = body.archived === true ? now() : body.archived === false ? null : project.archived_at;
          database.prepare(`UPDATE platform_projects SET name = ?, description = ?, archived_at = ?, updated_at = ? WHERE id = ?`).run(name, description, archivedAt, now(), projectId);
          audit(project.workspace_id, { type: "user", id: user.id }, "project.updated", { type: "project", id: projectId }, { archived: body.archived }, projectId);
          sendJson(response, 200, { project: projectResponse(projectFor(projectId)) });
          return true;
        }
      }

      const projectDocument = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/document$/);
      if (projectDocument) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(projectDocument[1]);
        const { project } = requireProjectRole(projectId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          sendJson(response, 200, documentFor(projectId));
          return true;
        }
        if (request.method === "PUT") {
          const body = await readJson<{ data?: Record<string, unknown>; expectedVersion?: number }>(request, 5_000_000);
          if (!body.data) throw new PlatformError(400, "DOCUMENT_REQUIRED");
          const result = putDocument(projectId, asRecord(body.data), body.expectedVersion);
          database.prepare(`UPDATE platform_projects SET updated_at = ? WHERE id = ?`).run(now(), projectId);
          audit(project.workspace_id, { type: "user", id: user.id }, "project.document_saved", { type: "project", id: projectId }, { version: result.version }, projectId);
          sendJson(response, 200, result);
          return true;
        }
      }

      const revisionRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/revisions$/);
      if (revisionRoot) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(revisionRoot[1]);
        const { project } = requireProjectRole(projectId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          const revisions = database.prepare(`SELECT id, flow_id, flow_name, environment_id, revision_number, status, checksum, created_by, created_at, published_at, flow_snapshot FROM flow_revisions WHERE project_id = ? ORDER BY revision_number DESC`).all(projectId) as Array<{ id: string; flow_id: string | null; flow_name: string | null; environment_id: string | null; revision_number: number; status: RevisionStatus; checksum: string; created_by: string; created_at: string; published_at: string | null; flow_snapshot: string }>;
          sendJson(response, 200, {
            revisions: revisions.map((item) => {
              const flow = parseJson<Record<string, unknown>>(item.flow_snapshot, {});
              const steps = Array.isArray(flow.steps) ? flow.steps : [];
              return {
                id: item.id,
                flowId: item.flow_id ?? (typeof flow.id === "string" ? flow.id : undefined),
                flowName: item.flow_name ?? (typeof flow.name === "string" ? flow.name : undefined),
                revisionNumber: item.revision_number,
                status: item.status,
                checksum: item.checksum,
                createdBy: item.created_by,
                createdAt: item.created_at,
                publishedAt: item.published_at,
                environmentId: item.environment_id ?? undefined,
                stepCount: steps.length,
              };
            }),
          });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ flow?: Record<string, unknown>; environment?: Record<string, unknown>; elements?: unknown; dataset?: unknown; datasetVersionId?: string; secretNames?: unknown }>(request, 5_000_000);
          if (!body.flow || !body.environment) throw new PlatformError(400, "REVISION_SNAPSHOT_INCOMPLETE");
          requireChromiumEnvironment(asRecord(body.environment));
          const flowId = typeof body.flow.id === "string" ? body.flow.id.trim() : "";
          if (!flowId) throw new PlatformError(400, "FLOW_ID_REQUIRED");
          const flowName = typeof body.flow.name === "string" ? body.flow.name.trim().slice(0, 240) : "";
          const environmentId = typeof body.environment.id === "string" ? body.environment.id.trim() : "";
          if (!environmentId) throw new PlatformError(400, "REVISION_ENVIRONMENT_REQUIRED");
          const secretNames = Array.isArray(body.secretNames)
            ? body.secretNames.filter((item): item is string => typeof item === "string")
            : [];
          const datasetVersion = body.datasetVersionId ? datasetVersionFor(projectId, body.datasetVersionId) : undefined;
          const dataset = datasetVersion
            ? { datasetId: datasetVersion.datasetId, versionId: datasetVersion.id, versionNumber: datasetVersion.versionNumber, checksum: datasetVersion.checksum, columns: datasetVersion.columns, rowCount: datasetVersion.rowCount }
            : body.dataset ?? null;
          const flowSnapshot: Record<string, unknown> = { ...asRecord(body.flow), secretNames };
          const flowStepCount = Array.isArray(flowSnapshot.steps) ? flowSnapshot.steps.length : 0;
          const snapshot = {
            flow: flowSnapshot,
            environment: asRecord(body.environment),
            elements: Array.isArray(body.elements) ? body.elements : [],
            dataset,
            secretNames,
          };
          const rows = database.prepare(`SELECT revision_number FROM flow_revisions WHERE project_id = ?`).all(projectId) as Array<{ revision_number: number }>;
          const revision = { id: randomUUID(), number: revisionNumber(rows), checksum: digest(json(snapshot)), createdAt: now() };
          database.prepare(`INSERT INTO flow_revisions (id, project_id, flow_id, flow_name, environment_id, revision_number, status, flow_snapshot, environment_snapshot, element_snapshot, dataset_snapshot, checksum, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
            .run(revision.id, projectId, flowId, flowName || null, environmentId, revision.number, json(snapshot.flow), json(snapshot.environment), json(snapshot.elements), json(snapshot.dataset), revision.checksum, user.id, revision.createdAt);
          audit(project.workspace_id, { type: "user", id: user.id }, "flow_revision.created", { type: "flow_revision", id: revision.id }, { revisionNumber: revision.number }, projectId);
          sendJson(response, 201, { revision: { id: revision.id, flowId, flowName: flowName || undefined, environmentId, stepCount: flowStepCount, revisionNumber: revision.number, status: "draft", checksum: revision.checksum, createdAt: revision.createdAt } });
          return true;
        }
      }

      const revisionAction = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/revisions\/([^/]+)\/(publish|rollback)$/);
      if (revisionAction && request.method === "POST") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(revisionAction[1]);
        const revisionId = decodeURIComponent(revisionAction[2]);
        const action = revisionAction[3];
        const { project } = requireProjectAdmin(projectId, user.id);
        const revision = database.prepare(`SELECT id, status, flow_id, environment_id FROM flow_revisions WHERE id = ? AND project_id = ?`).get(revisionId, projectId) as { id: string; status: RevisionStatus; flow_id: string | null; environment_id: string | null } | undefined;
        if (!revision) throw new PlatformError(404, "REVISION_NOT_FOUND");
        if (!revision.flow_id || !revision.environment_id) throw new PlatformError(409, "REVISION_SCOPE_REQUIRED");
        database.exec("BEGIN IMMEDIATE");
        try {
          database.prepare(`UPDATE flow_revisions SET status = 'superseded' WHERE project_id = ? AND flow_id = ? AND environment_id = ? AND status = 'published'`).run(projectId, revision.flow_id, revision.environment_id);
          database.prepare(`UPDATE flow_revisions SET status = 'published', published_at = ? WHERE id = ?`).run(now(), revisionId);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        audit(project.workspace_id, { type: "user", id: user.id }, action === "publish" ? "flow_revision.published" : "flow_revision.rolled_back", { type: "flow_revision", id: revisionId }, {}, projectId);
        sendJson(response, 200, { revisionId, status: "published", action });
        return true;
      }

      const projectSecrets = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/secrets$/);
      if (projectSecrets) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(projectSecrets[1]);
        const { project } = request.method === "GET" ? requireProjectRole(projectId, user.id) : requireProjectAdmin(projectId, user.id);
        if (request.method === "GET") {
          const secrets = database.prepare(`SELECT id, name, key_version, created_at, updated_at FROM project_secrets WHERE project_id = ? ORDER BY name`).all(projectId) as Array<{ id: string; name: string; key_version: number; created_at: string; updated_at: string }>;
          sendJson(response, 200, { secrets: secrets.map((item) => ({ id: item.id, name: item.name, keyVersion: item.key_version, createdAt: item.created_at, updatedAt: item.updated_at })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ name?: string; value?: string }>(request);
          const name = body.name?.trim();
          if (!name || !body.value) throw new PlatformError(400, "SECRET_INPUT_INVALID");
          const encrypted = encrypt(body.value);
          const existing = database.prepare(`SELECT id, key_version, created_at FROM project_secrets WHERE project_id = ? AND name = ?`).get(projectId, name) as { id: string; key_version: number; created_at: string } | undefined;
          const id = existing?.id ?? randomUUID();
          const keyVersion = (existing?.key_version ?? 0) + 1;
          database.prepare(`INSERT INTO project_secrets (id, project_id, name, key_version, iv, tag, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET key_version = excluded.key_version, iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
            .run(id, projectId, name, keyVersion, encrypted.iv, encrypted.tag, encrypted.ciphertext, existing?.created_at ?? now(), now());
          audit(project.workspace_id, { type: "user", id: user.id }, "secret.rotated", { type: "secret", id }, { name, keyVersion }, projectId);
          sendJson(response, 201, { secret: { id, name, keyVersion } });
          return true;
        }
      }

      const auditRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/audit-events$/);
      if (auditRoute && request.method === "GET") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(auditRoute[1]);
        requireProjectRole(projectId, user.id);
        const events = database.prepare(`SELECT id, actor_type, actor_id, action, target_type, target_id, detail, created_at FROM audit_events WHERE project_id = ? ORDER BY created_at DESC LIMIT 500`).all(projectId) as Array<{ id: string; actor_type: string; actor_id: string; action: string; target_type: string; target_id: string; detail: string; created_at: string }>;
        sendJson(response, 200, { events: events.map((item) => ({ id: item.id, actorType: item.actor_type, actorId: item.actor_id, action: item.action, targetType: item.target_type, targetId: item.target_id, detail: parseJson(item.detail, {}), createdAt: item.created_at })) });
        return true;
      }

      const analyticsRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/analytics$/);
      if (analyticsRoute && request.method === "GET") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(analyticsRoute[1]);
        requireProjectRole(projectId, user.id);
        sendJson(response, 200, { analytics: projectAnalytics(projectId) });
        return true;
      }

      const datasetRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/datasets$/);
      if (datasetRoot) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(datasetRoot[1]);
        const { project } = requireProjectRole(projectId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          const datasets = database.prepare(
            `SELECT d.id, d.name, d.description, d.created_at, d.updated_at,
                    v.id AS version_id, v.version_number, v.columns_json, v.row_count, v.checksum, v.source_name, v.created_at AS version_created_at
             FROM datasets d LEFT JOIN dataset_versions v ON v.id = (
               SELECT id FROM dataset_versions WHERE dataset_id = d.id ORDER BY version_number DESC LIMIT 1
             ) WHERE d.project_id = ? ORDER BY d.updated_at DESC`,
          ).all(projectId) as Array<{ id: string; name: string; description: string; created_at: string; updated_at: string; version_id: string | null; version_number: number | null; columns_json: string | null; row_count: number | null; checksum: string | null; source_name: string | null; version_created_at: string | null }>;
          sendJson(response, 200, {
            datasets: datasets.map((dataset) => ({
              id: dataset.id,
              name: dataset.name,
              description: dataset.description,
              createdAt: dataset.created_at,
              updatedAt: dataset.updated_at,
              latestVersion: dataset.version_id ? {
                id: dataset.version_id,
                datasetId: dataset.id,
                projectId,
                versionNumber: dataset.version_number,
                columns: parseJson<string[]>(dataset.columns_json, []),
                rowCount: dataset.row_count,
                checksum: dataset.checksum,
                sourceName: dataset.source_name,
                createdAt: dataset.version_created_at,
              } : undefined,
            })),
          });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ name?: string; description?: string; fileName?: string; contentBase64?: string }>(request, 18_000_000);
          const name = body.name?.trim().slice(0, 160);
          if (!name || !body.fileName || !body.contentBase64) throw new PlatformError(400, "DATASET_IMPORT_INPUT_INVALID");
          const parsed = await parseDatasetUpload(body.fileName, body.contentBase64);
          const dataset = { id: randomUUID(), name, createdAt: now() };
          try {
            database.prepare(`INSERT INTO datasets (id, project_id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(dataset.id, projectId, dataset.name, body.description?.trim().slice(0, 1_000) ?? "", user.id, dataset.createdAt, dataset.createdAt);
          } catch {
            throw new PlatformError(409, "DATASET_NAME_EXISTS");
          }
          const version = { id: randomUUID(), number: 1, checksum: digest(json({ columns: parsed.columns, rows: parsed.rows })), createdAt: now() };
          database.prepare(`INSERT INTO dataset_versions (id, dataset_id, version_number, columns_json, row_count, checksum, source_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(version.id, dataset.id, version.number, json(parsed.columns), parsed.rows.length, version.checksum, parsed.sourceName, user.id, version.createdAt);
          const insert = database.prepare(`INSERT INTO dataset_rows (id, dataset_version_id, row_number, data_json) VALUES (?, ?, ?, ?)`);
          for (const [index, row] of parsed.rows.entries()) insert.run(randomUUID(), version.id, index + 1, json(row));
          audit(project.workspace_id, { type: "user", id: user.id }, "dataset.imported", { type: "dataset", id: dataset.id }, { versionId: version.id, rows: parsed.rows.length, sourceName: parsed.sourceName }, projectId);
          sendJson(response, 201, { dataset: { id: dataset.id, name: dataset.name, description: body.description?.trim() ?? "", createdAt: dataset.createdAt }, version: datasetVersionFor(projectId, version.id) });
          return true;
        }
      }

      const datasetVersionRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/datasets\/([^/]+)\/versions$/);
      if (datasetVersionRoot) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(datasetVersionRoot[1]);
        const datasetId = decodeURIComponent(datasetVersionRoot[2]);
        const { project } = requireProjectRole(projectId, user.id, request.method !== "GET");
        const dataset = database.prepare(`SELECT id, name FROM datasets WHERE id = ? AND project_id = ?`).get(datasetId, projectId) as { id: string; name: string } | undefined;
        if (!dataset) throw new PlatformError(404, "DATASET_NOT_FOUND");
        if (request.method === "GET") {
          const versions = database.prepare(
            `SELECT v.id, v.dataset_id, d.project_id, v.version_number, v.columns_json, v.row_count, v.checksum, v.source_name, v.created_at
             FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.dataset_id = ? ORDER BY v.version_number DESC`,
          ).all(datasetId) as Array<{ id: string; dataset_id: string; project_id: string; version_number: number; columns_json: string; row_count: number; checksum: string; source_name: string; created_at: string }>;
          sendJson(response, 200, { versions: versions.map(datasetVersionResponse) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ fileName?: string; contentBase64?: string }>(request, 18_000_000);
          if (!body.fileName || !body.contentBase64) throw new PlatformError(400, "DATASET_IMPORT_INPUT_INVALID");
          const parsed = await parseDatasetUpload(body.fileName, body.contentBase64);
          const latest = database.prepare(`SELECT MAX(version_number) AS number FROM dataset_versions WHERE dataset_id = ?`).get(datasetId) as { number: number | null };
          const version = { id: randomUUID(), number: Number(latest.number ?? 0) + 1, checksum: digest(json({ columns: parsed.columns, rows: parsed.rows })), createdAt: now() };
          database.prepare(`INSERT INTO dataset_versions (id, dataset_id, version_number, columns_json, row_count, checksum, source_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(version.id, datasetId, version.number, json(parsed.columns), parsed.rows.length, version.checksum, parsed.sourceName, user.id, version.createdAt);
          const insert = database.prepare(`INSERT INTO dataset_rows (id, dataset_version_id, row_number, data_json) VALUES (?, ?, ?, ?)`);
          for (const [index, row] of parsed.rows.entries()) insert.run(randomUUID(), version.id, index + 1, json(row));
          database.prepare(`UPDATE datasets SET updated_at = ? WHERE id = ?`).run(now(), datasetId);
          audit(project.workspace_id, { type: "user", id: user.id }, "dataset.version_imported", { type: "dataset_version", id: version.id }, { datasetId, version: version.number, rows: parsed.rows.length }, projectId);
          sendJson(response, 201, { version: datasetVersionFor(projectId, version.id) });
          return true;
        }
      }

      const datasetVersionDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/dataset-versions\/([^/]+)$/);
      if (datasetVersionDetail && request.method === "GET") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(datasetVersionDetail[1]);
        const version = datasetVersionFor(projectId, decodeURIComponent(datasetVersionDetail[2]));
        requireProjectRole(projectId, user.id);
        sendJson(response, 200, { version, rows: datasetRowsFor(version.id).slice(0, 100), truncated: version.rowCount > 100 });
        return true;
      }

      const scheduleRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/schedules$/);
      if (scheduleRoot) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(scheduleRoot[1]);
        const { project } = request.method === "GET" ? requireProjectRole(projectId, user.id) : requireProjectAdmin(projectId, user.id);
        if (request.method === "GET") {
          const schedules = database.prepare(`SELECT id, revision_id, environment_id, dataset_version_id, name, cron_expression, timezone, enabled, last_run_at, next_run_at, created_at, updated_at FROM schedules WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as Array<{ id: string; revision_id: string; environment_id: string; dataset_version_id: string | null; name: string; cron_expression: string; timezone: string; enabled: number; last_run_at: string | null; next_run_at: string; created_at: string; updated_at: string }>;
          sendJson(response, 200, { schedules: schedules.map((item) => ({ id: item.id, revisionId: item.revision_id, environmentId: item.environment_id, datasetVersionId: item.dataset_version_id, name: item.name, cron: item.cron_expression, timezone: item.timezone, enabled: Boolean(item.enabled), lastRunAt: item.last_run_at, nextRunAt: item.next_run_at, createdAt: item.created_at, updatedAt: item.updated_at })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ name?: string; revisionId?: string; environmentId?: string; datasetVersionId?: string; cron?: string; timezone?: string }>(request);
          const name = body.name?.trim().slice(0, 160);
          const cron = body.cron?.trim();
          const timezone = body.timezone?.trim() || "Asia/Shanghai";
          if (!name || !cron || !body.environmentId) throw new PlatformError(400, "SCHEDULE_INPUT_INVALID");
          const revision = publishedRevisionFor(projectId, body.revisionId);
          requireRevisionEnvironment(revision, body.environmentId);
          if (body.datasetVersionId) datasetVersionFor(projectId, body.datasetVersionId);
          const schedule = { id: randomUUID(), nextRunAt: nextCronTime(cron, timezone), createdAt: now() };
          database.prepare(`INSERT INTO schedules (id, project_id, revision_id, environment_id, dataset_version_id, name, cron_expression, timezone, enabled, next_run_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
            .run(schedule.id, projectId, revision.id, body.environmentId, body.datasetVersionId ?? null, name, cron, timezone, schedule.nextRunAt, user.id, schedule.createdAt, schedule.createdAt);
          audit(project.workspace_id, { type: "user", id: user.id }, "schedule.created", { type: "schedule", id: schedule.id }, { revisionId: revision.id, environmentId: body.environmentId, datasetVersionId: body.datasetVersionId, cron, timezone }, projectId);
          sendJson(response, 201, { schedule: { id: schedule.id, name, revisionId: revision.id, environmentId: body.environmentId, datasetVersionId: body.datasetVersionId ?? null, cron, timezone, enabled: true, nextRunAt: schedule.nextRunAt } });
          return true;
        }
      }

      const scheduleAction = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/schedules\/([^/]+)\/(enable|disable|run)$/);
      if (scheduleAction && request.method === "POST") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(scheduleAction[1]);
        const scheduleId = decodeURIComponent(scheduleAction[2]);
        const action = scheduleAction[3];
        const { project } = requireProjectAdmin(projectId, user.id);
        const schedule = database.prepare(`SELECT id, revision_id, environment_id, dataset_version_id FROM schedules WHERE id = ? AND project_id = ?`).get(scheduleId, projectId) as { id: string; revision_id: string; environment_id: string; dataset_version_id: string | null } | undefined;
        if (!schedule) throw new PlatformError(404, "SCHEDULE_NOT_FOUND");
        if (action === "run") {
          const queued = queuePublishedRuns({ projectId, revisionId: schedule.revision_id, environmentId: schedule.environment_id, datasetVersionId: schedule.dataset_version_id ?? undefined, createdBy: `schedule:${schedule.id}`, source: "schedule" });
          database.prepare(`UPDATE schedules SET last_run_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), schedule.id);
          audit(project.workspace_id, { type: "user", id: user.id }, "schedule.run_requested", { type: "schedule", id: schedule.id }, { runIds: queued.runIds }, projectId);
          sendJson(response, 202, { runIds: queued.runIds });
          return true;
        }
        database.prepare(`UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?`).run(action === "enable" ? 1 : 0, now(), schedule.id);
        audit(project.workspace_id, { type: "user", id: user.id }, action === "enable" ? "schedule.enabled" : "schedule.disabled", { type: "schedule", id: schedule.id }, {}, projectId);
        sendJson(response, 200, { scheduleId: schedule.id, enabled: action === "enable" });
        return true;
      }

      const webhookRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/webhook-triggers$/);
      if (webhookRoot) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(webhookRoot[1]);
        const { project } = request.method === "GET" ? requireProjectRole(projectId, user.id) : requireProjectAdmin(projectId, user.id);
        if (request.method === "GET") {
          const triggers = database.prepare(`SELECT id, revision_id, environment_id, dataset_version_id, name, enabled, created_at, last_triggered_at FROM webhook_triggers WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as Array<{ id: string; revision_id: string; environment_id: string; dataset_version_id: string | null; name: string; enabled: number; created_at: string; last_triggered_at: string | null }>;
          sendJson(response, 200, { triggers: triggers.map((item) => ({ id: item.id, revisionId: item.revision_id, environmentId: item.environment_id, datasetVersionId: item.dataset_version_id, name: item.name, enabled: Boolean(item.enabled), createdAt: item.created_at, lastTriggeredAt: item.last_triggered_at })) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ name?: string; revisionId?: string; environmentId?: string; datasetVersionId?: string }>(request);
          const name = body.name?.trim().slice(0, 160);
          if (!name || !body.environmentId) throw new PlatformError(400, "WEBHOOK_TRIGGER_INPUT_INVALID");
          const revision = publishedRevisionFor(projectId, body.revisionId);
          requireRevisionEnvironment(revision, body.environmentId);
          if (body.datasetVersionId) datasetVersionFor(projectId, body.datasetVersionId);
          const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
          const encryptedSecret = encrypt(signingSecret);
          const trigger = { id: randomUUID(), createdAt: now() };
          database.prepare(`INSERT INTO webhook_triggers (id, project_id, revision_id, environment_id, dataset_version_id, name, token_hash, signing_secret_iv, signing_secret_tag, signing_secret_ciphertext, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
            .run(trigger.id, projectId, revision.id, body.environmentId, body.datasetVersionId ?? null, name, digest(randomBytes(32).toString("base64url")), encryptedSecret.iv, encryptedSecret.tag, encryptedSecret.ciphertext, user.id, trigger.createdAt);
          audit(project.workspace_id, { type: "user", id: user.id }, "webhook_trigger.created", { type: "webhook_trigger", id: trigger.id }, { revisionId: revision.id, environmentId: body.environmentId }, projectId);
          sendJson(response, 201, { trigger: { id: trigger.id, name, revisionId: revision.id, environmentId: body.environmentId, datasetVersionId: body.datasetVersionId ?? null, enabled: true, createdAt: trigger.createdAt }, triggerUrl: `/api/platform/webhooks/${encodeURIComponent(trigger.id)}`, signingSecret });
          return true;
        }
      }

      const webhookAction = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/webhook-triggers\/([^/]+)\/(enable|disable)$/);
      if (webhookAction && request.method === "POST") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(webhookAction[1]);
        const triggerId = decodeURIComponent(webhookAction[2]);
        const action = webhookAction[3];
        const { project } = requireProjectAdmin(projectId, user.id);
        const result = database.prepare(`UPDATE webhook_triggers SET enabled = ? WHERE id = ? AND project_id = ?`).run(action === "enable" ? 1 : 0, triggerId, projectId);
        if (result.changes === 0) throw new PlatformError(404, "WEBHOOK_TRIGGER_NOT_FOUND");
        audit(project.workspace_id, { type: "user", id: user.id }, action === "enable" ? "webhook_trigger.enabled" : "webhook_trigger.disabled", { type: "webhook_trigger", id: triggerId }, {}, projectId);
        sendJson(response, 200, { triggerId, enabled: action === "enable" });
        return true;
      }

      const notificationChannelRoot = url.pathname.match(/^\/api\/platform\/workspaces\/([^/]+)\/notification-channels$/);
      if (notificationChannelRoot) {
        const user = sessionUser(request);
        const workspaceId = decodeURIComponent(notificationChannelRoot[1]);
        requireWorkspaceRole(workspaceId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          const channels = database.prepare(`SELECT id, name, channel_type, enabled, created_at, updated_at FROM notification_channels WHERE workspace_id = ? ORDER BY name`).all(workspaceId) as Array<{ id: string; name: string; channel_type: NotificationChannelType; enabled: number; created_at: string; updated_at: string }>;
          sendJson(response, 200, { channels: channels.map((item) => ({ id: item.id, name: item.name, type: item.channel_type, enabled: Boolean(item.enabled), createdAt: item.created_at, updatedAt: item.updated_at })) });
          return true;
        }
        if (request.method === "POST") {
          requireWorkspaceRole(workspaceId, user.id, true);
          const body = await readJson<{ name?: string; type?: NotificationChannelType; config?: Record<string, unknown> }>(request);
          const name = body.name?.trim().slice(0, 160);
          const types: NotificationChannelType[] = ["webhook", "feishu", "dingtalk", "wecom", "email"];
          if (!name || !body.type || !types.includes(body.type) || !body.config || typeof body.config.url !== "string") {
            throw new PlatformError(400, "NOTIFICATION_CHANNEL_INPUT_INVALID");
          }
          let endpoint: ValidatedNotificationTarget;
          try {
            endpoint = await notificationTarget(body.config.url);
          } catch {
            throw new PlatformError(400, "NOTIFICATION_URL_INVALID");
          }
          const encrypted = encrypt(json({ url: endpoint.url.toString(), headers: asRecord(body.config.headers) }));
          const channel = { id: randomUUID(), createdAt: now() };
          try {
            database.prepare(`INSERT INTO notification_channels (id, workspace_id, name, channel_type, config_iv, config_tag, config_ciphertext, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
              .run(channel.id, workspaceId, name, body.type, encrypted.iv, encrypted.tag, encrypted.ciphertext, user.id, channel.createdAt, channel.createdAt);
          } catch {
            throw new PlatformError(409, "NOTIFICATION_CHANNEL_NAME_EXISTS");
          }
          audit(workspaceId, { type: "user", id: user.id }, "notification_channel.created", { type: "notification_channel", id: channel.id }, { name, type: body.type });
          sendJson(response, 201, { channel: { id: channel.id, name, type: body.type, enabled: true, createdAt: channel.createdAt } });
          return true;
        }
      }

      const notificationSubscriptions = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/notification-subscriptions$/);
      if (notificationSubscriptions) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(notificationSubscriptions[1]);
        const { project } = request.method === "GET" ? requireProjectRole(projectId, user.id) : requireProjectAdmin(projectId, user.id);
        if (request.method === "GET") {
          const subscriptions = database.prepare(
            `SELECT s.channel_id, s.on_success, s.on_failure, c.name, c.channel_type, c.enabled
             FROM notification_subscriptions s JOIN notification_channels c ON c.id = s.channel_id
             WHERE s.project_id = ? ORDER BY c.name`,
          ).all(projectId) as Array<{ channel_id: string; on_success: number; on_failure: number; name: string; channel_type: NotificationChannelType; enabled: number }>;
          sendJson(response, 200, { subscriptions: subscriptions.map((item) => ({ channelId: item.channel_id, name: item.name, type: item.channel_type, channelEnabled: Boolean(item.enabled), onSuccess: Boolean(item.on_success), onFailure: Boolean(item.on_failure) })) });
          return true;
        }
        if (request.method === "PUT") {
          const body = await readJson<{ channelId?: string; onSuccess?: boolean; onFailure?: boolean }>(request);
          if (!body.channelId) throw new PlatformError(400, "NOTIFICATION_SUBSCRIPTION_INPUT_INVALID");
          const channel = database.prepare(`SELECT id FROM notification_channels WHERE id = ? AND workspace_id = ?`).get(body.channelId, project.workspace_id) as { id: string } | undefined;
          if (!channel) throw new PlatformError(404, "NOTIFICATION_CHANNEL_NOT_FOUND");
          database.prepare(
            `INSERT INTO notification_subscriptions (project_id, channel_id, on_success, on_failure) VALUES (?, ?, ?, ?)
             ON CONFLICT(project_id, channel_id) DO UPDATE SET on_success = excluded.on_success, on_failure = excluded.on_failure`,
          ).run(projectId, channel.id, body.onSuccess ? 1 : 0, body.onFailure === false ? 0 : 1);
          audit(project.workspace_id, { type: "user", id: user.id }, "notification_subscription.saved", { type: "notification_channel", id: channel.id }, { onSuccess: Boolean(body.onSuccess), onFailure: body.onFailure !== false }, projectId);
          sendJson(response, 200, { channelId: channel.id, onSuccess: Boolean(body.onSuccess), onFailure: body.onFailure !== false });
          return true;
        }
      }

      const deliveryRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/deliveries$/);
      if (deliveryRoute && request.method === "GET") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(deliveryRoute[1]);
        requireProjectRole(projectId, user.id);
        const deliveries = database.prepare(
          `SELECT d.id, d.run_id, d.status, d.attempt_count, d.response_code, d.error, d.created_at, d.delivered_at, c.name, c.channel_type
           FROM deliveries d JOIN platform_runs r ON r.id = d.run_id JOIN notification_channels c ON c.id = d.channel_id
           WHERE r.project_id = ? ORDER BY d.created_at DESC LIMIT 200`,
        ).all(projectId) as Array<{ id: string; run_id: string; status: DeliveryStatus; attempt_count: number; response_code: number | null; error: string | null; created_at: string; delivered_at: string | null; name: string; channel_type: NotificationChannelType }>;
        sendJson(response, 200, { deliveries: deliveries.map((item) => ({ id: item.id, runId: item.run_id, status: item.status, attempts: item.attempt_count, responseCode: item.response_code, error: item.error, createdAt: item.created_at, deliveredAt: item.delivered_at, channel: { name: item.name, type: item.channel_type } })) });
        return true;
      }

      if (url.pathname === "/api/agent-tokens" && request.method === "POST") {
        const user = sessionUser(request);
        const body = await readJson<{ workspaceId?: string; expiresInMinutes?: number }>(request);
        if (!body.workspaceId) throw new PlatformError(400, "WORKSPACE_REQUIRED");
        requireWorkspaceRole(body.workspaceId, user.id, true);
        const minutes = Math.max(1, Math.min(24 * 60, Number(body.expiresInMinutes ?? 30)));
        const token = `agt_${randomBytes(24).toString("base64url")}`;
        const item = { id: randomUUID(), expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() };
        database.prepare(`INSERT INTO agent_tokens (id, workspace_id, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(item.id, body.workspaceId, digest(token), item.expiresAt, user.id, now());
        audit(body.workspaceId, { type: "user", id: user.id }, "agent_token.created", { type: "agent_token", id: item.id }, { expiresAt: item.expiresAt });
        sendJson(response, 201, { registrationToken: token, expiresAt: item.expiresAt });
        return true;
      }

      if (url.pathname === "/api/agents/register" && request.method === "POST") {
        const body = await readJson<{ registrationToken?: string; name?: string; browserVersion?: string; os?: string; maxConcurrency?: number }>(request);
        const registrationToken = body.registrationToken?.trim();
        if (!registrationToken || !body.name?.trim()) throw new PlatformError(400, "AGENT_REGISTRATION_INPUT_INVALID");
        const token = database.prepare(`SELECT id, workspace_id, expires_at, used_at, revoked_at FROM agent_tokens WHERE token_hash = ?`).get(digest(registrationToken)) as { id: string; workspace_id: string; expires_at: string; used_at: string | null; revoked_at: string | null } | undefined;
        if (!token || token.used_at || token.revoked_at || token.expires_at <= now()) throw new PlatformError(401, "AGENT_REGISTRATION_TOKEN_INVALID");
        const maxConcurrency = Number(body.maxConcurrency ?? 1);
        if (maxConcurrency !== 1) throw new PlatformError(400, "AGENT_SINGLE_CONCURRENCY_REQUIRED");
        const agent = { id: randomUUID(), workspaceId: token.workspace_id, name: body.name.trim().slice(0, 120), credential: `agc_${randomBytes(32).toString("base64url")}`, createdAt: now() };
        database.exec("BEGIN IMMEDIATE");
        try {
          const consumed = database.prepare(`UPDATE agent_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).run(now(), token.id, now());
          if (consumed.changes !== 1) throw new PlatformError(401, "AGENT_REGISTRATION_TOKEN_INVALID");
          database.prepare(`INSERT INTO agents (id, workspace_id, name, credential_hash, status, browser_version, os, max_concurrency, created_at) VALUES (?, ?, ?, ?, 'offline', ?, ?, 1, ?)`)
            .run(agent.id, agent.workspaceId, agent.name, digest(agent.credential), body.browserVersion?.slice(0, 160) ?? "Chromium", body.os?.slice(0, 160) ?? "unknown", agent.createdAt);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        audit(agent.workspaceId, { type: "agent", id: agent.id }, "agent.registered", { type: "agent", id: agent.id }, { name: agent.name });
        sendJson(response, 201, { agent: { id: agent.id, workspaceId: agent.workspaceId, name: agent.name, status: "offline", maxConcurrency: 1 }, credential: agent.credential });
        return true;
      }

      if (url.pathname === "/api/agents" && request.method === "GET") {
        const user = sessionUser(request);
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new PlatformError(400, "WORKSPACE_REQUIRED");
        requireWorkspaceRole(workspaceId, user.id);
        const agents = database.prepare(`SELECT id, workspace_id, name, status, browser_version, os, max_concurrency, current_task, last_seen_at, created_at FROM agents WHERE workspace_id = ? ORDER BY created_at DESC`).all(workspaceId) as Array<AgentRecord & { workspace_id: string; browser_version: string; max_concurrency: number; current_task: string | null; last_seen_at: string | null; created_at: string }>;
        sendJson(response, 200, { agents: agents.map(mapAgent) });
        return true;
      }

      const heartbeatRoute = url.pathname.match(/^\/api\/agents\/([^/]+)\/heartbeat$/);
      if (heartbeatRoute && request.method === "POST") {
        const agent = agentByCredential(authorization(request));
        if (agent.id !== decodeURIComponent(heartbeatRoute[1])) throw new PlatformError(403, "AGENT_ID_MISMATCH");
        const body = await readJson<Record<string, unknown>>(request);
        const updated = updateAgentHeartbeat(agent, body);
        dispatchWaitingRuns();
        sendJson(response, 200, { agent: updated, heartbeatIntervalSeconds: 15 });
        return true;
      }

      const agentDisableRoute = url.pathname.match(/^\/api\/agents\/([^/]+)\/(disable|revoke)$/);
      if (agentDisableRoute && request.method === "POST") {
        const user = sessionUser(request);
        const agentId = decodeURIComponent(agentDisableRoute[1]);
        const action = agentDisableRoute[2];
        const agent = database.prepare(`SELECT id, workspace_id FROM agents WHERE id = ?`).get(agentId) as { id: string; workspace_id: string } | undefined;
        if (!agent) throw new PlatformError(404, "AGENT_NOT_FOUND");
        requireWorkspaceRole(agent.workspace_id, user.id, true);
        database.prepare(`UPDATE agents SET status = 'disabled', revoked_at = CASE WHEN ? = 'revoke' THEN ? ELSE revoked_at END WHERE id = ?`).run(action, now(), agentId);
        sockets.get(agentId)?.close(4003, "disabled");
        audit(agent.workspace_id, { type: "user", id: user.id }, `agent.${action}d`, { type: "agent", id: agentId });
        sendJson(response, 200, { agentId, status: "disabled", revoked: action === "revoke" });
        return true;
      }

      const bindingRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/agent-bindings$/);
      if (bindingRoute) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(bindingRoute[1]);
        const { project } = request.method === "GET" ? requireProjectRole(projectId, user.id) : requireProjectAdmin(projectId, user.id);
        if (request.method === "GET") {
          const bindings = database.prepare(`SELECT b.environment_id, a.id, a.name, a.status, a.browser_version, a.last_seen_at FROM agent_bindings b JOIN agents a ON a.id = b.agent_id WHERE b.project_id = ? AND b.is_default = 1 ORDER BY b.environment_id, a.name`).all(projectId) as Array<{ environment_id: string; id: string; name: string; status: string; browser_version: string; last_seen_at: string | null }>;
          sendJson(response, 200, { bindings: bindings.map((item) => ({ environmentId: item.environment_id, agent: { id: item.id, name: item.name, status: item.status, browserVersion: item.browser_version, lastSeenAt: item.last_seen_at } })) });
          return true;
        }
        if (request.method === "PUT") {
          const body = await readJson<{ environmentId?: string; agentId?: string }>(request);
          if (!body.environmentId || !body.agentId) throw new PlatformError(400, "AGENT_BINDING_INPUT_INVALID");
          const document = documentFor(projectId);
          const environments = Array.isArray(document.data.environments) ? document.data.environments.map(asRecord) : [];
          const environment = environments.find((item) => item.id === body.environmentId);
          if (!environment) throw new PlatformError(404, "ENVIRONMENT_NOT_FOUND");
          requireChromiumEnvironment(environment);
          const agent = database.prepare(`SELECT workspace_id FROM agents WHERE id = ?`).get(body.agentId) as { workspace_id: string } | undefined;
          if (!agent) throw new PlatformError(404, "AGENT_NOT_FOUND");
          if (agent.workspace_id !== project.workspace_id) throw new PlatformError(409, "AGENT_WORKSPACE_MISMATCH");
          database.exec("BEGIN IMMEDIATE");
          try {
            database.prepare(`UPDATE agent_bindings SET is_default = 0 WHERE project_id = ? AND environment_id = ?`).run(projectId, body.environmentId);
            database.prepare(`INSERT INTO agent_bindings (project_id, environment_id, agent_id, is_default, created_at) VALUES (?, ?, ?, 1, ?)
              ON CONFLICT(project_id, environment_id, agent_id) DO UPDATE SET is_default = 1, created_at = excluded.created_at`).run(projectId, body.environmentId, body.agentId, now());
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
          audit(project.workspace_id, { type: "user", id: user.id }, "agent.bound", { type: "agent", id: body.agentId }, { environmentId: body.environmentId }, projectId);
          sendJson(response, 201, { projectId, environmentId: body.environmentId, agentId: body.agentId });
          return true;
        }
      }

      const debugSessionRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions$/);
      if (debugSessionRoot) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(debugSessionRoot[1]);
        const { project } = requireProjectRole(projectId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          const rows = database
            .prepare(`SELECT id FROM debug_sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`)
            .all(projectId) as Array<{ id: string }>;
          sendJson(response, 200, { sessions: rows.map((row) => debugSessionResponse(debugSessionById(row.id))) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ revisionId?: string; environmentId?: string; startStep?: number }>(request);
          const revision = body.revisionId
            ? database
                .prepare(`SELECT id, flow_snapshot, environment_snapshot, element_snapshot, dataset_snapshot, checksum FROM flow_revisions WHERE id = ? AND project_id = ? AND status = 'published'`)
                .get(body.revisionId, projectId) as { id: string; flow_snapshot: string; environment_snapshot: string; element_snapshot: string; dataset_snapshot: string; checksum: string } | undefined
            : database
                .prepare(`SELECT id, flow_snapshot, environment_snapshot, element_snapshot, dataset_snapshot, checksum FROM flow_revisions WHERE project_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1`)
                .get(projectId) as { id: string; flow_snapshot: string; environment_snapshot: string; element_snapshot: string; dataset_snapshot: string; checksum: string } | undefined;
          if (!revision) throw new PlatformError(409, "PUBLISHED_REVISION_REQUIRED");
           const environment = parseJson<Record<string, unknown>>(revision.environment_snapshot, {});
           const environmentId = body.environmentId ?? (typeof environment.id === "string" ? environment.id : "");
           if (!environmentId) throw new PlatformError(400, "ENVIRONMENT_REQUIRED");
            requireRevisionEnvironment(revision, environmentId);
            requireChromiumEnvironment(environment);
          const agent = candidateAgent(projectId, environmentId);
          if (!agent || !sockets.has(agent.id)) throw new PlatformError(409, "AGENT_UNAVAILABLE");
          const snapshot = {
            flowRevisionId: revision.id,
            flowRevisionChecksum: revision.checksum,
            environmentId,
            flow: parseJson<Record<string, unknown>>(revision.flow_snapshot, {}),
            environment,
            elements: parseJson<unknown[]>(revision.element_snapshot, []),
            dataset: parseJson<unknown>(revision.dataset_snapshot, null),
            secretNames: parseJson<Record<string, unknown>>(revision.flow_snapshot, {}).secretNames ?? [],
            agent: { id: agent.id, name: agent.name, browserVersion: agent.browserVersion, os: agent.os, maxConcurrency: agent.maxConcurrency },
          };
          const createdAt = now();
          const maxExpiresAt = new Date(Date.now() + debugMaxDurationMs).toISOString();
          const session = {
            id: randomUUID(),
            projectId,
            revisionId: revision.id,
            environmentId,
            agentId: agent.id,
            currentStep: Math.max(0, Math.floor(Number(body.startStep ?? 0))),
            createdAt,
            maxExpiresAt,
          };
          database
            .prepare(
              `INSERT INTO debug_sessions (id, project_id, revision_id, environment_id, agent_id, status, snapshot, current_step, idle_expires_at, max_expires_at, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              session.id,
              session.projectId,
              session.revisionId,
              session.environmentId,
              session.agentId,
              json(snapshot),
              session.currentStep,
              nextDebugIdleExpiry(maxExpiresAt),
              session.maxExpiresAt,
              user.id,
              session.createdAt,
              session.createdAt,
            );
          const persisted = debugSessionById(session.id);
          if (!sendAgent(agent.id, debugSessionPayload(persisted))) {
            database.prepare(`DELETE FROM debug_sessions WHERE id = ?`).run(session.id);
            throw new PlatformError(409, "AGENT_UNAVAILABLE");
          }
          appendDebugEvent(session.id, "session.requested", { revisionId: session.revisionId, environmentId, agentId: agent.id, currentStep: session.currentStep });
          audit(project.workspace_id, { type: "user", id: user.id }, "debug_session.created", { type: "debug_session", id: session.id }, { revisionId: session.revisionId, environmentId, agentId: agent.id }, projectId);
          sendJson(response, 202, { session: debugSessionResponse(debugSessionById(session.id)) });
          return true;
        }
      }

      const debugCommandRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/commands$/);
      if (debugCommandRoute && request.method === "POST") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(debugCommandRoute[1]);
        const sessionId = decodeURIComponent(debugCommandRoute[2]);
        const { project } = requireProjectRole(projectId, user.id, true);
        const session = debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        const body = await readJson<{ command?: string }>(request);
        const command = body.command;
        if (!command || !["start", "continue", "runCurrent", "skip", "pause", "retry", "stop"].includes(command)) {
          throw new PlatformError(400, "DEBUG_COMMAND_INVALID");
        }
        if (["ended", "failed", "expired"].includes(session.status)) throw new PlatformError(409, "DEBUG_SESSION_CLOSED");
        if (session.status === "requested" && command !== "stop") {
          throw new PlatformError(409, "DEBUG_SESSION_NOT_READY");
        }
        const acknowledgement = await sendConfirmedDebugCommand(session.agentId, sessionId, command);
        if (!acknowledgement.accepted) throw new PlatformError(acknowledgement.reason === "DEBUG_COMMAND_ACK_TIMEOUT" ? 504 : 409, acknowledgement.reason ?? "DEBUG_COMMAND_REJECTED");
        const updated = touchDebugSession(session, {
          status: command === "stop" ? "ending" : "active",
          currentStep: command === "start" ? 0 : session.currentStep,
        });
        appendDebugEvent(sessionId, "command.requested", { command, actorId: user.id });
        audit(project.workspace_id, { type: "user", id: user.id }, "debug_session.commanded", { type: "debug_session", id: sessionId }, { command }, projectId);
        sendJson(response, 202, { session: debugSessionResponse(updated) });
        return true;
      }

      const pickerEnableRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/picker\/enable$/);
      if (pickerEnableRoute && request.method === "POST") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(pickerEnableRoute[1]);
        const sessionId = decodeURIComponent(pickerEnableRoute[2]);
        const { project } = requireProjectRole(projectId, user.id, true);
        const session = debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        if (["ended", "failed", "expired"].includes(session.status)) throw new PlatformError(409, "DEBUG_SESSION_CLOSED");
        if (!sendAgent(session.agentId, { type: "picker.enable", sessionId })) throw new PlatformError(409, "DEBUG_AGENT_DISCONNECTED");
        appendDebugEvent(session.id, "picker.enabled", { actorId: user.id });
        audit(project.workspace_id, { type: "user", id: user.id }, "picker.enabled", { type: "debug_session", id: session.id }, {}, projectId);
        sendJson(response, 202, { session: debugSessionResponse(session) });
        return true;
      }

      const pickerCaptureRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/picker-captures$/);
      if (pickerCaptureRoot && request.method === "GET") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(pickerCaptureRoot[1]);
        const sessionId = decodeURIComponent(pickerCaptureRoot[2]);
        requireProjectRole(projectId, user.id);
        const session = debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        const captures = database.prepare(`SELECT id, session_id, candidates, target, status, captured_at, confirmed_at FROM picker_captures WHERE session_id = ? ORDER BY captured_at DESC LIMIT 100`)
          .all(sessionId) as Array<{ id: string; session_id: string; candidates: string; target: string; status: string; captured_at: string; confirmed_at: string | null }>;
        sendJson(response, 200, { captures: captures.map(pickerCaptureResponse) });
        return true;
      }

      const pickerPreviewRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/picker-captures\/([^/]+)\/preview$/);
      if (pickerPreviewRoute && request.method === "POST") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(pickerPreviewRoute[1]);
        const sessionId = decodeURIComponent(pickerPreviewRoute[2]);
        const captureId = decodeURIComponent(pickerPreviewRoute[3]);
        requireProjectRole(projectId, user.id, true);
        const session = debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        const capture = database.prepare(`SELECT id, session_id, candidates, target, status, captured_at, confirmed_at FROM picker_captures WHERE id = ? AND session_id = ?`).get(captureId, sessionId) as { id: string; session_id: string; candidates: string; target: string; status: string; captured_at: string; confirmed_at: string | null } | undefined;
        if (!capture) throw new PlatformError(404, "PICKER_CAPTURE_NOT_FOUND");
        const body = await readJson<{ candidateIndex?: number }>(request);
        const candidates = parseJson<LocatorCandidate[]>(capture.candidates, []);
        const candidateIndex = Number(body.candidateIndex);
        const candidate = candidates[candidateIndex];
        if (!Number.isInteger(candidateIndex) || !candidate) throw new PlatformError(400, "PICKER_CANDIDATE_INVALID");
        if (!sendAgent(session.agentId, { type: "picker.preview", sessionId, captureId, candidateIndex, candidate })) throw new PlatformError(409, "DEBUG_AGENT_DISCONNECTED");
        sendJson(response, 202, { capture: pickerCaptureResponse(capture), candidateIndex });
        return true;
      }

      const pickerConfirmRoute = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)\/picker-captures\/([^/]+)\/confirm$/);
      if (pickerConfirmRoute && request.method === "POST") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(pickerConfirmRoute[1]);
        const sessionId = decodeURIComponent(pickerConfirmRoute[2]);
        const captureId = decodeURIComponent(pickerConfirmRoute[3]);
        const { project } = requireProjectRole(projectId, user.id, true);
        const session = debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        const capture = database.prepare(`SELECT id, session_id, candidates, target, status, captured_at, confirmed_at FROM picker_captures WHERE id = ? AND session_id = ?`).get(captureId, sessionId) as { id: string; session_id: string; candidates: string; target: string; status: string; captured_at: string; confirmed_at: string | null } | undefined;
        if (!capture) throw new PlatformError(404, "PICKER_CAPTURE_NOT_FOUND");
        if (capture.status !== "pending") throw new PlatformError(409, "PICKER_CAPTURE_ALREADY_CONFIRMED");
        const body = await readJson<{ candidateIndex?: number; target?: "element" | "step"; name?: string; flowId?: string; stepId?: string }>(request);
        const candidates = parseJson<LocatorCandidate[]>(capture.candidates, []);
        const candidateIndex = Number(body.candidateIndex);
        const candidate = candidates[candidateIndex];
        if (!Number.isInteger(candidateIndex) || !candidate || (body.target !== "element" && body.target !== "step")) throw new PlatformError(400, "PICKER_CONFIRMATION_INVALID");
        const document = documentFor(projectId);
        const elements: unknown[] = Array.isArray(document.data.elements) ? [...document.data.elements] : [];
        const elementName = body.name?.trim().slice(0, 160) || capture.target || candidate.label;
        let path = "/";
        try {
          path = session.currentUrl ? new URL(session.currentUrl).pathname || "/" : "/";
        } catch {
          path = "/";
        }
        const element = {
          id: `element-${randomUUID()}`,
          name: elementName,
          description: "Captured from a debug browser session",
          path,
          method: candidate.method,
          value: candidate.value,
          environment: session.environmentId,
          validation: candidate.count === 1 ? "verified" : "unverified",
          updatedAt: now(),
        };
        elements.push(element);
        const nextData: Record<string, unknown> = { ...document.data, elements };
        if (body.target === "step") {
          const flows: Array<Record<string, unknown>> = Array.isArray(document.data.flows)
            ? document.data.flows.map((flow: unknown) => asRecord(flow))
            : [];
          const flow = flows.find((item) => item.id === body.flowId);
          if (!flow || !body.stepId) throw new PlatformError(400, "PICKER_STEP_TARGET_REQUIRED");
          const steps: Array<Record<string, unknown>> = Array.isArray(flow.steps)
            ? flow.steps.map((step: unknown) => asRecord(step))
            : [];
          const stepIndex = steps.findIndex((step) => step.id === body.stepId);
          if (stepIndex < 0) throw new PlatformError(404, "FLOW_STEP_NOT_FOUND");
          steps[stepIndex] = { ...steps[stepIndex], element: element.name };
          flow.steps = steps;
          nextData.flows = flows;
        }
        const saved = putDocument(projectId, nextData, document.version);
        database.prepare(`UPDATE picker_captures SET status = 'confirmed', confirmed_at = ? WHERE id = ?`).run(now(), capture.id);
        appendDebugEvent(session.id, "picker.confirmed", { captureId: capture.id, candidateIndex, target: body.target, elementId: element.id });
        audit(project.workspace_id, { type: "user", id: user.id }, "picker.confirmed", { type: "element", id: element.id }, { captureId: capture.id, candidateIndex, target: body.target, documentVersion: saved.version }, projectId);
        sendJson(response, 201, { element, documentVersion: saved.version, target: body.target });
        return true;
      }

      const debugSessionDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/debug-sessions\/([^/]+)$/);
      if (debugSessionDetail && request.method === "GET") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(debugSessionDetail[1]);
        const sessionId = decodeURIComponent(debugSessionDetail[2]);
        requireProjectRole(projectId, user.id);
        const session = debugSessionById(sessionId);
        if (session.projectId !== projectId) throw new PlatformError(404, "DEBUG_SESSION_NOT_FOUND");
        sendJson(response, 200, { session: debugSessionResponse(session) });
        return true;
      }

      const debugArtifactUpload = url.pathname.match(/^\/api\/agents\/([^/]+)\/debug-sessions\/([^/]+)\/artifacts$/);
      if (debugArtifactUpload && request.method === "POST") {
        const agent = agentByCredential(authorization(request));
        if (agent.id !== decodeURIComponent(debugArtifactUpload[1])) throw new PlatformError(403, "AGENT_ID_MISMATCH");
        const session = agentOwnsDebugSession(agent.id, decodeURIComponent(debugArtifactUpload[2]));
        if (["ended", "failed", "expired"].includes(session.status)) throw new PlatformError(409, "DEBUG_SESSION_CLOSED");
        const body = await readJson<{ name?: string; contentType?: string; contentBase64?: string }>(request, 26_000_000);
        if (!body.contentBase64) throw new PlatformError(400, "ARTIFACT_CONTENT_REQUIRED");
        const content = Buffer.from(body.contentBase64, "base64");
        if (content.length === 0 || content.length > 18_000_000) throw new PlatformError(413, "ARTIFACT_TOO_LARGE");
        await mkdir(platformArtifactDirectory, { recursive: true });
        const artifact = { id: randomUUID(), name: safeArtifactName(body.name ?? "debug-artifact.bin"), contentType: body.contentType?.slice(0, 120) ?? "application/octet-stream" };
        const path = join(platformArtifactDirectory, `${artifact.id}-${artifact.name}`);
        await writeFile(path, content);
        database.prepare(`INSERT INTO debug_artifacts (id, session_id, project_id, name, content_type, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(artifact.id, session.id, session.projectId, artifact.name, artifact.contentType, path, now());
        appendDebugEvent(session.id, "artifact.uploaded", { artifactId: artifact.id, name: artifact.name });
        sendJson(response, 201, { artifact: { id: artifact.id, name: artifact.name, contentType: artifact.contentType } });
        return true;
      }

      const debugArtifact = url.pathname.match(/^\/api\/platform\/debug-artifacts\/([^/]+)$/);
      if (debugArtifact && request.method === "GET") {
        const user = sessionUser(request);
        const artifact = database.prepare(`SELECT id, name, content_type, path, project_id FROM debug_artifacts WHERE id = ?`).get(decodeURIComponent(debugArtifact[1])) as { id: string; name: string; content_type: string; path: string; project_id: string } | undefined;
        if (!artifact) throw new PlatformError(404, "ARTIFACT_NOT_FOUND");
        requireProjectRole(artifact.project_id, user.id);
        response.writeHead(200, { "content-type": artifact.content_type, "content-disposition": `inline; filename="${safeArtifactName(artifact.name)}"` });
        createReadStream(artifact.path).on("error", () => response.destroy()).pipe(response);
        return true;
      }

      const platformRunRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/runs$/);
      if (platformRunRoot) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(platformRunRoot[1]);
        const { project } = requireProjectRole(projectId, user.id, request.method !== "GET");
        if (request.method === "GET") {
          const rows = database.prepare(`SELECT id FROM platform_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 200`).all(projectId) as Array<{ id: string }>;
          sendJson(response, 200, { runs: rows.map((row) => runResponse(runById(row.id))) });
          return true;
        }
        if (request.method === "POST") {
          const body = await readJson<{ revisionId?: string; environmentId?: string; datasetVersionId?: string; upToStepId?: string }>(request);
          const queued = queuePublishedRuns({ projectId, revisionId: body.revisionId, environmentId: body.environmentId, datasetVersionId: body.datasetVersionId, upToStepId: body.upToStepId, createdBy: user.id, source: "manual" });
          const runs = queued.runIds.map((runId) => runResponse(runById(runId)));
          audit(project.workspace_id, { type: "user", id: user.id }, "run.created", { type: "run_batch", id: queued.runIds[0] ?? randomUUID() }, { revisionId: queued.revision.id, environmentId: queued.environmentId, datasetVersionId: queued.datasetVersionId, runIds: queued.runIds }, projectId);
          sendJson(response, 202, { run: runs[0], runs, runIds: queued.runIds, leaseOffered: runs.some((run) => run.status === "dispatched") });
          return true;
        }
      }

      const validationRoot = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/element-validations$/);
      if (validationRoot) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(validationRoot[1]);
        const { project } = requireProjectRole(projectId, user.id, request.method !== "GET");
        if (request.method === "POST") {
          const body = await readJson<{ environmentId?: string; element?: Record<string, unknown> }>(request);
          if (!body.environmentId || !body.element) throw new PlatformError(400, "ELEMENT_VALIDATION_INPUT_INVALID");
          const document = documentFor(projectId);
          const environments = Array.isArray(document.data.environments) ? document.data.environments.map(asRecord) : [];
          const environment = environments.find((item) => item.id === body.environmentId);
          if (!environment) throw new PlatformError(404, "ENVIRONMENT_NOT_FOUND");
          requireChromiumEnvironment(environment);
          const element = asRecord(body.element);
          requireSameOriginElementPath(environment, element);
          const agent = candidateAgent(projectId, body.environmentId);
          if (!agent || !sockets.has(agent.id)) throw new PlatformError(409, "AGENT_UNAVAILABLE");
          const validation = { id: randomUUID(), createdAt: now() };
          database.prepare(`INSERT INTO element_validations (id, project_id, environment_id, agent_id, status, element_snapshot, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
            .run(validation.id, projectId, body.environmentId, agent.id, json(element), user.id, validation.createdAt, validation.createdAt);
          const persisted = elementValidationById(validation.id);
          if (!sendAgent(agent.id, agentValidationPayload(persisted))) {
            database.prepare(`UPDATE element_validations SET status = 'failed', error = 'AGENT_UNAVAILABLE', updated_at = ? WHERE id = ?`).run(now(), validation.id);
            throw new PlatformError(409, "AGENT_UNAVAILABLE");
          }
          audit(project.workspace_id, { type: "user", id: user.id }, "element.validation_started", { type: "element_validation", id: validation.id }, { environmentId: body.environmentId, elementId: body.element.id }, projectId);
          sendJson(response, 202, { validation: elementValidationById(validation.id) });
          return true;
        }
      }

      const validationDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/element-validations\/([^/]+)$/);
      if (validationDetail && request.method === "GET") {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(validationDetail[1]);
        requireProjectRole(projectId, user.id);
        const validation = elementValidationById(decodeURIComponent(validationDetail[2]));
        if (validation.projectId !== projectId) throw new PlatformError(404, "ELEMENT_VALIDATION_NOT_FOUND");
        sendJson(response, 200, { validation });
        return true;
      }

      const platformRunDetail = url.pathname.match(/^\/api\/platform\/projects\/([^/]+)\/runs\/([^/]+)(?:\/(cancel))?$/);
      if (platformRunDetail) {
        const user = sessionUser(request);
        const projectId = decodeURIComponent(platformRunDetail[1]);
        const runId = decodeURIComponent(platformRunDetail[2]);
        const action = platformRunDetail[3];
        requireProjectRole(projectId, user.id, request.method !== "GET");
        const run = runById(runId);
        if (run.projectId !== projectId) throw new PlatformError(404, "RUN_NOT_FOUND");
        if (request.method === "GET" && !action) {
          sendJson(response, 200, { run: runResponse(run) });
          return true;
        }
        if (request.method === "POST" && action === "cancel") {
          database.prepare(`UPDATE platform_runs SET cancellation_requested = 1, status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END, updated_at = ? WHERE id = ?`).run(now(), run.id);
          const lease = activeLeaseForRun(run.id);
          if (lease) {
            sendAgent(lease.agentId, { type: "run.cancel", leaseId: lease.id, runId: run.id });
          }
          appendRunEvent(run.id, "run.cancel_requested", { actorId: user.id });
          sendJson(response, 202, { run: runResponse(runById(run.id)) });
          return true;
        }
      }

      const uploadRoute = url.pathname.match(/^\/api\/agents\/([^/]+)\/leases\/([^/]+)\/artifacts$/);
      if (uploadRoute && request.method === "POST") {
        const agent = agentByCredential(authorization(request));
        if (agent.id !== decodeURIComponent(uploadRoute[1])) throw new PlatformError(403, "AGENT_ID_MISMATCH");
        const lease = activeLeaseForAgent(agent.id, decodeURIComponent(uploadRoute[2]));
        if (!lease) throw new PlatformError(409, "LEASE_NOT_ACTIVE");
        const body = await readJson<{ name?: string; contentType?: string; contentBase64?: string }>(request, 26_000_000);
        if (!body.contentBase64) throw new PlatformError(400, "ARTIFACT_CONTENT_REQUIRED");
        const content = Buffer.from(body.contentBase64, "base64");
        if (content.length === 0 || content.length > 18_000_000) throw new PlatformError(413, "ARTIFACT_TOO_LARGE");
        const run = runById(lease.runId);
        await mkdir(platformArtifactDirectory, { recursive: true });
        const artifact = { id: randomUUID(), name: safeArtifactName(body.name ?? "artifact.bin"), contentType: body.contentType?.slice(0, 120) ?? "application/octet-stream" };
        const path = join(platformArtifactDirectory, `${artifact.id}-${artifact.name}`);
        await writeFile(path, content);
        database.prepare(`INSERT INTO platform_artifacts (id, run_id, project_id, name, content_type, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(artifact.id, run.id, run.projectId, artifact.name, artifact.contentType, path, now());
        appendRunEvent(run.id, "artifact.uploaded", { artifactId: artifact.id, name: artifact.name });
        sendJson(response, 201, { artifact: { id: artifact.id, name: artifact.name, contentType: artifact.contentType } });
        return true;
      }

      const platformArtifact = url.pathname.match(/^\/api\/platform\/artifacts\/([^/]+)$/);
      if (platformArtifact && request.method === "GET") {
        const user = sessionUser(request);
        const artifactId = decodeURIComponent(platformArtifact[1]);
        const artifact = database.prepare(`SELECT a.id, a.name, a.content_type, a.path, a.project_id FROM platform_artifacts a WHERE a.id = ?`).get(artifactId) as { id: string; name: string; content_type: string; path: string; project_id: string } | undefined;
        if (!artifact) throw new PlatformError(404, "ARTIFACT_NOT_FOUND");
        requireProjectRole(artifact.project_id, user.id);
        response.writeHead(200, { "content-type": artifact.content_type, "content-disposition": `inline; filename="${safeArtifactName(artifact.name)}"` });
        createReadStream(artifact.path).on("error", () => response.destroy()).pipe(response);
        return true;
      }

      return false;
    } catch (error) {
      const platformError = error instanceof PlatformError ? error : new PlatformError(500, "PLATFORM_INTERNAL_ERROR");
      sendError(response, platformError.status, platformError.code);
      return true;
    }
  }

  webSocketServer.on("connection", (socket: WebSocket, _request: IncomingMessage, agent: AgentRecord) => {
    sockets.get(agent.id)?.close(4001, "replaced");
    sockets.set(agent.id, socket);
    updateAgentHeartbeat(agent, {});
    dispatchWaitingRuns();
    expireDebugSessions();
    socket.send(json({ type: "connected", agentId: agent.id, heartbeatIntervalSeconds: 15, leaseDurationSeconds: Math.round(agentLeaseDurationMs / 1000) }));
    deliverDebugSessions(agent);
    const validationDelivered = deliverElementValidations(agent);
    const lease = validationDelivered ? undefined : claimLease(agent);
    if (lease) socket.send(json(agentRunPayload(lease)));
    socket.on("message", (payload: RawData) => {
      try {
        const reply = processAgentMessage(agent, parseJson(payload.toString("utf8"), {}));
        socket.send(json(reply));
      } catch (error) {
        const platformError = error instanceof PlatformError ? error : new PlatformError(500, "AGENT_MESSAGE_FAILED");
        socket.send(json({ type: "error", error: platformError.code }));
      }
    });
    socket.on("close", () => {
      if (sockets.get(agent.id) !== socket) return;
      sockets.delete(agent.id);
      database.prepare(`UPDATE agents SET status = 'offline', current_task = NULL WHERE id = ? AND status != 'disabled'`).run(agent.id);
      database.prepare(`UPDATE element_validations SET status = 'failed', error = 'AGENT_CONNECTION_LOST', updated_at = ? WHERE agent_id = ? AND status IN ('queued', 'running')`).run(now(), agent.id);
      const interruptedSessions = database
        .prepare(`SELECT id FROM debug_sessions WHERE agent_id = ? AND status IN ('requested', 'active', 'paused', 'ending')`)
        .all(agent.id) as Array<{ id: string }>;
      for (const session of interruptedSessions) {
        database.prepare(`UPDATE debug_sessions SET status = 'failed', updated_at = ? WHERE id = ?`).run(now(), session.id);
        appendDebugEvent(session.id, "session.failed", { reason: "AGENT_CONNECTION_LOST" });
      }
      for (const [commandId, pending] of pendingDebugCommands) {
        if (pending.agentId !== agent.id) continue;
        clearTimeout(pending.timeout);
        pendingDebugCommands.delete(commandId);
        pending.resolve({ accepted: false, reason: "DEBUG_AGENT_DISCONNECTED" });
      }
      dispatchWaitingRuns();
    });
  });

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== "/api/agents/connect") return false;
    try {
      const agent = agentByCredential(authorization(request));
      if (url.searchParams.get("agentId") !== agent.id) throw new PlatformError(403, "AGENT_ID_MISMATCH");
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request, agent);
      });
      return true;
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
  }

  const maintenanceTimer = setInterval(() => {
    try {
      recoverExpiredLeases();
      recoverStaleElementValidations();
      expireDebugSessions();
      processDueSchedules();
      void deliverPendingNotifications();
    } catch {
      // Request handling and the next interval both retry transient maintenance failures.
    }
  }, 10_000);
  maintenanceTimer.unref();

  return { handle, handleUpgrade };
}
