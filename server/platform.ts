import {
  PlatformError,
  agentLeaseDurationMs,
  agentOfflineAfterMs,
  allowInsecureNotificationTargets,
  allowPrivateNotificationTargets,
  asRecord,
  authorization,
  debugIdleTimeoutMs,
  digest,
  failureCategory,
  json,
  leaseExpiresAt,
  nextCronTime,
  normalizeDatasetRows,
  normalizeLocatorCandidates,
  notificationMaxAttempts,
  notificationRetryBaseMs,
  now,
  parseCsv,
  parseJson,
  publicFlowOutputNames,
  publicIpAddress,
  safeArtifactName,
  webhookRateLimitPerMinute,
} from "./platform-core";
import type {
  AgentRecord,
  AuthUser,
  DatasetVersionRecord,
  DebugSession,
  DebugSessionStatus,
  DeliveryStatus,
  ElementValidation,
  ElementValidationStatus,
  Lease,
  LeaseStatus,
  LocatorCandidate,
  NotificationChannelType,
  PlatformApi,
  PlatformRun,
  PlatformRunStatus,
  ProjectDocument,
  PublishedRevision,
  Role,
  ValidatedNotificationTarget,
} from "./platform-core";
import { createPlatformHandler } from "./platform-handler";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import type { WebSocket, RawData } from "ws";
import { WebSocketServer } from "ws";
import { readSheet } from "read-excel-file/node";

function createPlatformServices(dataDirectory: string) {
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

  function allowWebhookRequest(triggerId: string) {
    const cutoff = Date.now() - 60_000;
    const requests = (webhookRequests.get(triggerId) ?? []).filter((time) => time > cutoff);
    if (requests.length >= webhookRateLimitPerMinute) return false;
    requests.push(Date.now());
    webhookRequests.set(triggerId, requests);
    return true;
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

  return {
    activeLeaseForAgent,
    activeLeaseForRun,
    agentByCredential,
    agentOwnsDebugSession,
    agentValidationPayload,
    allowWebhookRequest,
    appendDebugEvent,
    appendRunEvent,
    audit,
    candidateAgent,
    createAuthSession,
    createWorkspace,
    createWorkspaceInvitation,
    datasetRowsFor,
    datasetVersionFor,
    debugSessionById,
    debugSessionPayload,
    debugSessionResponse,
    decrypt,
    dispatchWaitingRuns,
    documentFor,
    elementValidationById,
    encrypt,
    expireDebugSessions,
    nextDebugIdleExpiry,
    normalizeRole,
    notificationTarget,
    parseDatasetUpload,
    pickerCaptureResponse,
    processDueSchedules,
    projectAnalytics,
    projectFor,
    projectResponse,
    publishedRevisionFor,
    putDocument,
    queuePublishedRuns,
    recoverExpiredLeases,
    recoverStaleElementValidations,
    requireChromiumEnvironment,
    requireProjectAdmin,
    requireProjectRole,
    requireRevisionEnvironment,
    requireSameOriginElementPath,
    requireWorkspaceRole,
    runById,
    runResponse,
    sendAgent,
    sendConfirmedDebugCommand,
    sessionUser,
    touchDebugSession,
    updateAgentHeartbeat,
    datasetVersionResponse,
    mapAgent,
    database,
    sockets,
    pendingDebugCommands,
    webSocketServer,
    webhookRequests,
    keyMaterial,
  };
}

export type PlatformServices = ReturnType<typeof createPlatformServices>;

export function createPlatformApi(dataDirectory: string): PlatformApi {
  return createPlatformHandler(createPlatformServices(dataDirectory));
}
