// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runMigrations, runPlatformMigrations } from "./platform-migrations";

const minimalLegacySchema = `
  CREATE TABLE IF NOT EXISTS webhook_triggers (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS notification_channels (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS agent_bindings (project_id TEXT, environment_id TEXT, agent_id TEXT);
  CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, workspace_id TEXT);
  CREATE TABLE IF NOT EXISTS platform_projects (id TEXT PRIMARY KEY, workspace_id TEXT);
  CREATE TABLE IF NOT EXISTS platform_users (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS project_documents (project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS flow_revisions (
    id TEXT PRIMARY KEY,
    flow_snapshot TEXT NOT NULL,
    environment_snapshot TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS platform_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL);
`;

describe("platform database migrations", () => {
  it("initializes and records an empty database exactly once", () => {
    const database = new DatabaseSync(":memory:");
    runPlatformMigrations(database, minimalLegacySchema);
    runPlatformMigrations(database, minimalLegacySchema);
    const rows = database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([
      { version: 1, name: "bootstrap-platform-schema" },
      { version: 2, name: "upgrade-legacy-columns" },
      { version: 3, name: "resource-level-project-data" },
      { version: 4, name: "managed-execution-and-review" },
      { version: 5, name: "automation-idempotency-and-archival" },
      { version: 6, name: "internal-template-library" },
      { version: 7, name: "managed-validation-artifacts" },
      { version: 8, name: "blank-debug-sessions" },
      { version: 9, name: "drop-agent-and-debug-tables" },
      { version: 10, name: "drop-dead-tables-and-columns" },
    ]);
    const columns = database.prepare("PRAGMA table_info(flow_revisions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["flow_id", "flow_name", "environment_id"]));
    database.close();
  });

  it("drops agent and debug tables at v9 while keeping agents", () => {
    const database = new DatabaseSync(":memory:");
    runPlatformMigrations(database, minimalLegacySchema);
    for (const table of ["picker_captures", "debug_session_events", "debug_artifacts", "debug_sessions", "run_leases", "agent_bindings", "agent_tokens"]) {
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
    }
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get()).toBeTruthy();
    database.close();
  });

  it("upgrades an existing unversioned database", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(minimalLegacySchema);
    database.prepare("INSERT INTO flow_revisions (id, flow_snapshot, environment_snapshot) VALUES (?, ?, ?)")
      .run("revision-1", JSON.stringify({ id: "flow-1", name: "Legacy flow" }), JSON.stringify({ id: "environment-1" }));
    runPlatformMigrations(database, minimalLegacySchema);
    expect(database.prepare("SELECT flow_id, flow_name, environment_id FROM flow_revisions WHERE id = ?").get("revision-1"))
      .toEqual({ flow_id: "flow-1", flow_name: "Legacy flow", environment_id: "environment-1" });
    database.close();
  });

  it("rebuilds webhook_triggers without losing archived_at or foreign-key deliveries", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(minimalLegacySchema);
    database.exec(`
      DROP TABLE webhook_triggers;
      CREATE TABLE webhook_triggers (
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
        last_triggered_at TEXT,
        archived_at TEXT,
        token_hash TEXT UNIQUE
      );
      CREATE TABLE dataset_versions (id TEXT PRIMARY KEY);
      CREATE TABLE element_validations (id TEXT PRIMARY KEY);
      CREATE TABLE webhook_deliveries (
        trigger_id TEXT NOT NULL REFERENCES webhook_triggers(id),
        delivery_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (trigger_id, delivery_id)
      );
    `);
    database.prepare("INSERT INTO workspaces (id) VALUES (?)").run("workspace-1");
    database.prepare("INSERT INTO platform_projects (id, workspace_id) VALUES (?, ?)").run("project-1", "workspace-1");
    database.prepare("INSERT INTO flow_revisions (id, flow_snapshot, environment_snapshot) VALUES (?, ?, ?)")
      .run("revision-1", JSON.stringify({ id: "flow-1", name: "Legacy flow" }), JSON.stringify({ id: "environment-1" }));
    database.prepare("INSERT INTO dataset_versions (id) VALUES (?)").run("dataset-version-1");
    database.prepare(`
      INSERT INTO webhook_triggers (
        id, project_id, revision_id, environment_id, dataset_version_id, name,
        signing_secret_iv, signing_secret_tag, signing_secret_ciphertext, enabled,
        created_by, created_at, last_triggered_at, archived_at, token_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      "trigger-1", "project-1", "revision-1", "environment-1", "dataset-version-1", "Legacy trigger",
      "iv", "tag", "cipher", "user-1", "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "legacy-token-hash",
    );
    database.prepare("INSERT INTO webhook_deliveries (trigger_id, delivery_id, received_at) VALUES (?, ?, ?)")
      .run("trigger-1", "delivery-1", "2026-01-02T00:00:00.000Z");

    expect(() => runPlatformMigrations(database, minimalLegacySchema)).not.toThrow();

    const columns = database.prepare("PRAGMA table_info(webhook_triggers)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "archived_at")).toBe(true);
    expect(columns.some((column) => column.name === "token_hash")).toBe(false);
    expect(database.prepare("SELECT archived_at FROM webhook_triggers WHERE id = ?").get("trigger-1"))
      .toEqual({ archived_at: "2026-03-01T00:00:00.000Z" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE trigger_id = ?").get("trigger-1"))
      .toEqual({ count: 1 });
    database.close();
  });

  it("rolls back a failed migration and does not mark it applied", () => {
    const database = new DatabaseSync(":memory:");
    expect(() => runMigrations(database, [{
      version: 99,
      name: "intentional-failure",
      up(target) {
        target.exec("CREATE TABLE incomplete_change (id TEXT)");
        throw new Error("stop");
      },
    }])).toThrow("Database migration 99");
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'incomplete_change'").get()).toBeUndefined();
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 99").get()).toBeUndefined();
    database.close();
  });
});
