import sqlite3

import pytest

from autoflow.migrations import run_migrations, run_platform_migrations


MINIMAL_LEGACY_SCHEMA = """
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
  CREATE TABLE IF NOT EXISTS platform_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
"""


def _columns(database: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in database.execute(f"PRAGMA table_info({table})").fetchall()]


def test_run_platform_migrations_records_exactly_once():
    database = sqlite3.connect(":memory:")
    try:
        run_platform_migrations(database, MINIMAL_LEGACY_SCHEMA)
        run_platform_migrations(database, MINIMAL_LEGACY_SCHEMA)
        rows = database.execute(
            "SELECT version, name FROM schema_migrations ORDER BY version"
        ).fetchall()
        assert rows == [
            (1, "bootstrap-platform-schema"),
            (2, "upgrade-legacy-columns"),
            (3, "resource-level-project-data"),
            (4, "managed-execution-and-review"),
            (5, "automation-idempotency-and-archival"),
            (6, "internal-template-library"),
            (7, "managed-validation-artifacts"),
            (8, "blank-debug-sessions"),
            (9, "drop-agent-and-debug-tables"),
            (10, "drop-dead-tables-and-columns"),
            (11, "run-batches"),
            (12, "local-accounts-membership-rbac"),
            (13, "deployment-security-audit"),
            (14, "scope-run-dispatch-key-uniqueness"),
            (15, "recording-sessions-metadata"),
            (16, "externalize-run-snapshots"),
        ]
        columns = _columns(database, "flow_revisions")
        assert "flow_id" in columns
        assert "flow_name" in columns
        assert "environment_id" in columns
        assert "global_role" in _columns(database, "platform_users")
        assert "workspace_invitations" in {
            row[0]
            for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert "deployment_audit_events" in {
            row[0]
            for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        index_names = {
            row[0]
            for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }
        assert "platform_runs_dispatch_key" not in index_names
        assert "platform_runs_dispatch_key_project" in index_names
    finally:
        database.close()


def test_run_platform_migrations_drops_agent_and_debug_tables():
    database = sqlite3.connect(":memory:")
    try:
        run_platform_migrations(database, MINIMAL_LEGACY_SCHEMA)
        tables = {
            row[0]
            for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        for table in (
            "picker_captures",
            "debug_session_events",
            "debug_artifacts",
            "debug_sessions",
            "run_leases",
            "agent_bindings",
            "agent_tokens",
        ):
            assert table not in tables
        assert "agents" in tables
    finally:
        database.close()


def test_upgrades_existing_unversioned_database():
    database = sqlite3.connect(":memory:")
    try:
        database.executescript(MINIMAL_LEGACY_SCHEMA)
        database.execute(
            """
            INSERT INTO flow_revisions (id, flow_snapshot, environment_snapshot)
            VALUES (?, ?, ?)
            """,
            (
                "revision-1",
                '{"id":"flow-1","name":"Legacy flow"}',
                '{"id":"environment-1"}',
            ),
        )
        run_platform_migrations(database, MINIMAL_LEGACY_SCHEMA)
        row = database.execute(
            """
            SELECT flow_id, flow_name, environment_id
            FROM flow_revisions WHERE id = ?
            """,
            ("revision-1",),
        ).fetchone()
        assert row == ("flow-1", "Legacy flow", "environment-1")
    finally:
        database.close()


def test_rebuilds_webhook_triggers_without_losing_data():
    database = sqlite3.connect(":memory:")
    try:
        database.executescript(MINIMAL_LEGACY_SCHEMA)
        database.executescript(
            """
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
            """
        )
        database.execute("INSERT INTO workspaces (id) VALUES (?)", ("workspace-1",))
        database.execute(
            "INSERT INTO platform_projects (id, workspace_id) VALUES (?, ?)",
            ("project-1", "workspace-1"),
        )
        database.execute(
            """
            INSERT INTO flow_revisions (id, flow_snapshot, environment_snapshot)
            VALUES (?, ?, ?)
            """,
            (
                "revision-1",
                '{"id":"flow-1","name":"Legacy flow"}',
                '{"id":"environment-1"}',
            ),
        )
        database.execute(
            "INSERT INTO dataset_versions (id) VALUES (?)",
            ("dataset-version-1",),
        )
        database.execute(
            """
            INSERT INTO webhook_triggers (
              id, project_id, revision_id, environment_id, dataset_version_id, name,
              signing_secret_iv, signing_secret_tag, signing_secret_ciphertext, enabled,
              created_by, created_at, last_triggered_at, archived_at, token_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
            """,
            (
                "trigger-1",
                "project-1",
                "revision-1",
                "environment-1",
                "dataset-version-1",
                "Legacy trigger",
                "iv",
                "tag",
                "cipher",
                "user-1",
                "2026-01-01T00:00:00.000Z",
                "2026-02-01T00:00:00.000Z",
                "2026-03-01T00:00:00.000Z",
                "legacy-token-hash",
            ),
        )
        database.execute(
            """
            INSERT INTO webhook_deliveries (trigger_id, delivery_id, received_at)
            VALUES (?, ?, ?)
            """,
            ("trigger-1", "delivery-1", "2026-01-02T00:00:00.000Z"),
        )

        run_platform_migrations(database, MINIMAL_LEGACY_SCHEMA)
        columns = _columns(database, "webhook_triggers")
        assert "archived_at" in columns
        assert "token_hash" not in columns
        archived = database.execute(
            "SELECT archived_at FROM webhook_triggers WHERE id = ?",
            ("trigger-1",),
        ).fetchone()
        assert archived == ("2026-03-01T00:00:00.000Z",)
        count = database.execute(
            "SELECT COUNT(*) FROM webhook_deliveries WHERE trigger_id = ?",
            ("trigger-1",),
        ).fetchone()
        assert count == (1,)
    finally:
        database.close()


def test_rolls_back_failed_migration():
    def failing_up(target):
        target.execute("CREATE TABLE incomplete_change (id TEXT)")
        raise RuntimeError("stop")

    database = sqlite3.connect(":memory:")
    try:
        with pytest.raises(RuntimeError, match="Database migration 99"):
            run_migrations(
                database,
                [
                    {
                        "version": 99,
                        "name": "intentional-failure",
                        "up": failing_up,
                    }
                ],
            )
        tables = {
            row[0]
            for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert "incomplete_change" not in tables
        rows = database.execute(
            "SELECT version FROM schema_migrations WHERE version = 99"
        ).fetchall()
        assert rows == []
    finally:
        database.close()
