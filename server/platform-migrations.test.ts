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
    ]);
    const columns = database.prepare("PRAGMA table_info(flow_revisions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["flow_id", "flow_name", "environment_id"]));
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
