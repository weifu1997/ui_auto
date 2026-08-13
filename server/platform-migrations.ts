import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type DatabaseMigration = {
  version: number;
  name: string;
  up: (database: DatabaseSync) => void;
  /** Run outside the default BEGIN/COMMIT wrapper (needed for PRAGMA foreign_keys toggles). */
  noTransaction?: boolean;
};

function appliedVersions(database: DatabaseSync) {
  return new Set(
    (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
      .map((row) => row.version),
  );
}

export function runMigrations(database: DatabaseSync, migrations: DatabaseMigration[]) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = appliedVersions(database);
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  if (new Set(ordered.map((migration) => migration.version)).size !== ordered.length) {
    throw new Error("Duplicate database migration version");
  }

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    if (migration.noTransaction) {
      migration.up(database);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.up(database);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Database migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
}

function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function parseObject(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function upgradeLegacyColumns(database: DatabaseSync) {
  ensureColumn(database, "webhook_triggers", "signing_secret_iv", "TEXT");
  ensureColumn(database, "webhook_triggers", "signing_secret_tag", "TEXT");
  ensureColumn(database, "webhook_triggers", "signing_secret_ciphertext", "TEXT");
  ensureColumn(database, "deliveries", "next_attempt_at", "TEXT");
  ensureColumn(database, "platform_projects", "source_project_id", "TEXT");
  ensureColumn(database, "flow_revisions", "flow_id", "TEXT");
  ensureColumn(database, "flow_revisions", "flow_name", "TEXT");
  ensureColumn(database, "flow_revisions", "environment_id", "TEXT");

  const revisions = database
    .prepare("SELECT id, flow_snapshot, environment_snapshot FROM flow_revisions WHERE flow_id IS NULL OR environment_id IS NULL")
    .all() as Array<{ id: string; flow_snapshot: string; environment_snapshot: string }>;
  const updateRevision = database.prepare("UPDATE flow_revisions SET flow_id = ?, flow_name = ?, environment_id = ? WHERE id = ?");
  for (const revision of revisions) {
    const flow = parseObject(revision.flow_snapshot);
    const environment = parseObject(revision.environment_snapshot);
    updateRevision.run(
      typeof flow.id === "string" ? flow.id : null,
      typeof flow.name === "string" ? flow.name.slice(0, 240) : null,
      typeof environment.id === "string" ? environment.id : null,
      revision.id,
    );
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS platform_projects_workspace_source
      ON platform_projects (workspace_id, source_project_id) WHERE source_project_id IS NOT NULL;
  `);
}

const resourceCollections = ["flows", "elements", "variables", "environments"] as const;

export function migrateProjectDocumentResources(
  database: DatabaseSync,
  projectId: string,
  document: Record<string, unknown>,
  actorId = "system:migration",
) {
  const timestamp = new Date().toISOString();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO project_resources
      (project_id, resource_type, resource_id, data, version, updated_at, updated_by)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  for (const collection of resourceCollections) {
    const resources = Array.isArray(document[collection]) ? document[collection] : [];
    for (const [index, value] of resources.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const resource = value as Record<string, unknown>;
      const resourceId = typeof resource.id === "string" && resource.id.trim()
        ? resource.id
        : `${collection}-${index + 1}-${randomUUID()}`;
      insert.run(projectId, collection, resourceId, JSON.stringify({ ...resource, id: resourceId }), timestamp, actorId);
    }
  }
  const settings = {
    activeEnvironmentId: typeof document.activeEnvironmentId === "string" ? document.activeEnvironmentId : "",
  };
  database.prepare(`
    INSERT OR IGNORE INTO project_settings (project_id, data, version, updated_at, updated_by)
    VALUES (?, ?, 1, ?, ?)
  `).run(projectId, JSON.stringify(settings), timestamp, actorId);
}

function createResourceModel(database: DatabaseSync) {
  ensureColumn(database, "platform_users", "enabled", "INTEGER NOT NULL DEFAULT 1");
  database.exec(`
    CREATE TABLE IF NOT EXISTS project_resources (
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      data TEXT NOT NULL,
      version INTEGER NOT NULL,
      archived_at TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (project_id, resource_type, resource_id),
      CHECK (resource_type IN ('flows', 'elements', 'variables', 'environments'))
    );
    CREATE TABLE IF NOT EXISTS project_settings (
      project_id TEXT PRIMARY KEY REFERENCES platform_projects(id),
      data TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_resources_list
      ON project_resources (project_id, resource_type, archived_at, updated_at DESC);
  `);
  const documents = database.prepare("SELECT project_id, data FROM project_documents").all() as Array<{ project_id: string; data: string }>;
  for (const document of documents) {
    migrateProjectDocumentResources(database, document.project_id, parseObject(document.data));
  }
}

function addManagedExecutionAndReview(database: DatabaseSync) {
  ensureColumn(database, "platform_runs", "executor_type", "TEXT NOT NULL DEFAULT 'agent'");
  ensureColumn(database, "platform_runs", "retry_of_run_id", "TEXT");
  ensureColumn(database, "flow_revisions", "submitted_at", "TEXT");
  ensureColumn(database, "flow_revisions", "reviewed_by", "TEXT");
  ensureColumn(database, "flow_revisions", "review_note", "TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS platform_runs_executor_status ON platform_runs (executor_type, status, created_at)");
}

function addAutomationGovernance(database: DatabaseSync) {
  ensureColumn(database, "platform_runs", "dispatch_key", "TEXT");
  ensureColumn(database, "datasets", "archived_at", "TEXT");
  ensureColumn(database, "schedules", "archived_at", "TEXT");
  ensureColumn(database, "webhook_triggers", "archived_at", "TEXT");
  ensureColumn(database, "notification_channels", "archived_at", "TEXT");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS platform_runs_dispatch_key ON platform_runs (dispatch_key) WHERE dispatch_key IS NOT NULL");
}

function addTemplateLibrary(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS internal_templates (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      source_project_id TEXT NOT NULL REFERENCES platform_projects(id),
      source_revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS template_favorites (
      template_id TEXT NOT NULL REFERENCES internal_templates(id),
      user_id TEXT NOT NULL REFERENCES platform_users(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (template_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS internal_templates_search ON internal_templates (workspace_id, deleted_at, category, updated_at DESC);
  `);
}

function addManagedValidationArtifacts(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS element_validation_artifacts (
      id TEXT PRIMARY KEY,
      validation_id TEXT NOT NULL REFERENCES element_validations(id),
      project_id TEXT NOT NULL REFERENCES platform_projects(id),
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS element_validation_artifacts_validation
      ON element_validation_artifacts (validation_id, created_at);
  `);
}

function allowBlankDebugSessions(database: DatabaseSync) {
  const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'debug_sessions'`).all();
  if (tables.length === 0) return; // Schema does not include debug_sessions yet (e.g. minimal test schema).
  const columns = database.prepare(`PRAGMA table_info(debug_sessions)`).all() as Array<{ name: string; notnull: number }>;
  const revision = columns.find((column) => column.name === "revision_id");
  if (revision && revision.notnull === 0) return; // Already nullable.
  // Rebuild debug_sessions so revision_id can be NULL (blank sessions have no published revision).
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(`
      CREATE TABLE debug_sessions_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES platform_projects(id),
        revision_id TEXT REFERENCES flow_revisions(id),
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
      INSERT INTO debug_sessions_new (id, project_id, revision_id, environment_id, agent_id, status, snapshot, current_step, current_url, browser_context_id, idle_expires_at, max_expires_at, created_by, created_at, updated_at)
        SELECT id, project_id, revision_id, environment_id, agent_id, status, snapshot, current_step, current_url, browser_context_id, idle_expires_at, max_expires_at, created_by, created_at, updated_at FROM debug_sessions;
      DROP TABLE debug_sessions;
      ALTER TABLE debug_sessions_new RENAME TO debug_sessions;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

export function runPlatformMigrations(database: DatabaseSync, bootstrapSchema: string) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  runMigrations(database, [
    { version: 1, name: "bootstrap-platform-schema", up: (target) => target.exec(bootstrapSchema) },
    { version: 2, name: "upgrade-legacy-columns", up: upgradeLegacyColumns },
    { version: 3, name: "resource-level-project-data", up: createResourceModel },
    { version: 4, name: "managed-execution-and-review", up: addManagedExecutionAndReview },
    { version: 5, name: "automation-idempotency-and-archival", up: addAutomationGovernance },
    { version: 6, name: "internal-template-library", up: addTemplateLibrary },
    { version: 7, name: "managed-validation-artifacts", up: addManagedValidationArtifacts },
    { version: 8, name: "blank-debug-sessions", up: allowBlankDebugSessions, noTransaction: true },
    { version: 9, name: "drop-agent-and-debug-tables", up: dropAgentAndDebugTables },
    { version: 10, name: "drop-dead-tables-and-columns", up: dropDeadTablesAndColumns },
  ]);
}

// 清理代码库已无任何读写的死表/死列（老库在 bootstrap 裁剪后仍残留这些对象）。
function dropDeadTablesAndColumns(database: DatabaseSync) {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      DROP TABLE IF EXISTS workspace_invitations;
      DROP TABLE IF EXISTS agent_tokens;
      DROP TABLE IF EXISTS agent_bindings;
      DROP TABLE IF EXISTS run_leases;
      DROP TABLE IF EXISTS debug_sessions;
      DROP TABLE IF EXISTS debug_session_events;
      DROP TABLE IF EXISTS debug_artifacts;
      DROP TABLE IF EXISTS picker_captures;
    `);
    const columns = database.prepare(`PRAGMA table_info(webhook_triggers)`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "token_hash")) {
      // SQLite 不允许 DROP 带 UNIQUE 约束的列：重建 webhook_triggers 表（不含 token_hash）。
      // webhook_deliveries 的 REFERENCES webhook_triggers(id) 在表重建后自动指向新表。
      database.exec(`
        CREATE TABLE webhook_triggers_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES platform_projects(id),
          revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
          environment_id TEXT NOT NULL,
          dataset_version_id TEXT REFERENCES dataset_versions(id),
          name TEXT NOT NULL,
          signing_secret_iv TEXT,
          signing_secret_tag TEXT,
          signing_secret_ciphertext TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_triggered_at TEXT
        );
        INSERT INTO webhook_triggers_new (id, project_id, revision_id, environment_id, dataset_version_id, name, signing_secret_iv, signing_secret_tag, signing_secret_ciphertext, enabled, created_by, created_at, last_triggered_at)
          SELECT id, project_id, revision_id, environment_id, dataset_version_id, name, signing_secret_iv, signing_secret_tag, signing_secret_ciphertext, enabled, created_by, created_at, last_triggered_at FROM webhook_triggers;
        DROP TABLE webhook_triggers;
        ALTER TABLE webhook_triggers_new RENAME TO webhook_triggers;
        CREATE INDEX IF NOT EXISTS webhook_triggers_project ON webhook_triggers (project_id, enabled);
      `);
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
  // 高频查询索引（老库补齐，与 bootstrap 保持一致；表/列不存在时跳过，兼容 minimal 测试 schema）。
  const hasTable = (table: string) => Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  const hasColumns = (table: string, columns: string[]) => {
    const found = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    return columns.every((column) => found.has(column));
  };
  if (hasTable("audit_events") && hasColumns("audit_events", ["project_id", "created_at"])) {
    database.exec("CREATE INDEX IF NOT EXISTS audit_events_project ON audit_events (project_id, created_at DESC)");
  }
  if (hasTable("platform_run_events") && hasColumns("platform_run_events", ["run_id", "id"])) {
    database.exec("CREATE INDEX IF NOT EXISTS platform_run_events_run ON platform_run_events (run_id, id)");
  }
  if (hasTable("deliveries") && hasColumns("deliveries", ["status", "next_attempt_at"])) {
    database.exec("CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at)");
  }
}

// 方案C：单机部署移除分布式 Agent 远程执行与远程调试会话（见 docs/决策-内网部署形态与平台裁剪.md）。
// agents 表保留（ManagedRunner 伪代理行由 managed 执行路径写入），仅清理协议专属表。
function dropAgentAndDebugTables(database: DatabaseSync) {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      DROP TABLE IF EXISTS picker_captures;
      DROP TABLE IF EXISTS debug_session_events;
      DROP TABLE IF EXISTS debug_artifacts;
      DROP TABLE IF EXISTS debug_sessions;
      DROP TABLE IF EXISTS run_leases;
      DROP TABLE IF EXISTS agent_bindings;
      DROP TABLE IF EXISTS agent_tokens;
    `);
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
