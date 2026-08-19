"""SQLite migration engine matching server/platform-migrations.ts."""

from __future__ import annotations

import json as _json
import sqlite3
import uuid
from typing import Any, Callable

from .core import now


def _split_sql(sql: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    for line in sql.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("--"):
            continue
        current.append(line)
        if stripped.endswith(";"):
            statements.append("\n".join(current))
            current = []
    if current:
        statements.append("\n".join(current))
    return statements


def exec_sql(database: sqlite3.Connection, sql: str) -> None:
    for statement in _split_sql(sql):
        if statement.strip():
            database.execute(statement)


def applied_versions(database: sqlite3.Connection) -> set[int]:
    return {
        int(row[0])
        for row in database.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall()
    }


def run_migrations(
    database: sqlite3.Connection,
    migrations: list[dict[str, Any]],
) -> None:
    database.isolation_level = None
    exec_sql(
        database,
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        """,
    )
    applied = applied_versions(database)
    ordered = sorted(migrations, key=lambda migration: migration["version"])
    if len({migration["version"] for migration in ordered}) != len(ordered):
        raise RuntimeError("Duplicate database migration version")

    for migration in ordered:
        version = migration["version"]
        name = migration["name"]
        if version in applied:
            continue
        if migration.get("noTransaction"):
            migration["up"](database)
            database.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                (version, name, now()),
            )
            continue
        database.execute("BEGIN IMMEDIATE")
        try:
            migration["up"](database)
            database.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                (version, name, now()),
            )
            database.execute("COMMIT")
        except Exception as error:
            database.execute("ROLLBACK")
            raise RuntimeError(
                f"Database migration {version} ({name}) failed"
            ) from error


def ensure_column(
    database: sqlite3.Connection,
    table: str,
    column: str,
    definition: str,
) -> None:
    columns = {
        row[1]
        for row in database.execute(f"PRAGMA table_info({table})").fetchall()
    }
    if column not in columns:
        database.execute(
            f"ALTER TABLE {table} ADD COLUMN {column} {definition}"
        )


def parse_object(value: str) -> dict[str, Any]:
    try:
        parsed = _json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def upgrade_legacy_columns(database: sqlite3.Connection) -> None:
    ensure_column(database, "webhook_triggers", "signing_secret_iv", "TEXT")
    ensure_column(database, "webhook_triggers", "signing_secret_tag", "TEXT")
    ensure_column(
        database, "webhook_triggers", "signing_secret_ciphertext", "TEXT"
    )
    ensure_column(database, "deliveries", "next_attempt_at", "TEXT")
    ensure_column(database, "platform_projects", "source_project_id", "TEXT")
    ensure_column(database, "flow_revisions", "flow_id", "TEXT")
    ensure_column(database, "flow_revisions", "flow_name", "TEXT")
    ensure_column(database, "flow_revisions", "environment_id", "TEXT")

    revisions = database.execute(
        """
        SELECT id, flow_snapshot, environment_snapshot
        FROM flow_revisions
        WHERE flow_id IS NULL OR environment_id IS NULL
        """
    ).fetchall()
    update_sql = """
        UPDATE flow_revisions
        SET flow_id = ?, flow_name = ?, environment_id = ?
        WHERE id = ?
    """
    update_revision = database.cursor()
    for revision in revisions:
        flow = parse_object(revision[1])
        environment = parse_object(revision[2])
        update_revision.execute(
            update_sql,
            (
                flow.get("id") if isinstance(flow.get("id"), str) else None,
                str(flow.get("name"))[:240]
                if isinstance(flow.get("name"), str)
                else None,
                environment.get("id")
                if isinstance(environment.get("id"), str)
                else None,
                revision[0],
            )
        )

    exec_sql(
        database,
        """
        CREATE UNIQUE INDEX IF NOT EXISTS platform_projects_workspace_source
          ON platform_projects (workspace_id, source_project_id)
          WHERE source_project_id IS NOT NULL;
        """,
    )


RESOURCE_COLLECTIONS = ("flows", "elements", "variables", "environments")


def migrate_project_document_resources(
    database: sqlite3.Connection,
    project_id: str,
    document: dict[str, Any],
    actor_id: str = "system:migration",
) -> None:
    timestamp = now()
    insert_sql = """
        INSERT OR IGNORE INTO project_resources
          (project_id, resource_type, resource_id, data, version, updated_at, updated_by)
        VALUES (?, ?, ?, ?, 1, ?, ?)
    """
    insert = database.cursor()
    for collection in RESOURCE_COLLECTIONS:
        resources = document.get(collection)
        if not isinstance(resources, list):
            continue
        for index, value in enumerate(resources):
            if not isinstance(value, dict):
                continue
            resource = dict(value)
            resource_id = resource.get("id")
            if not isinstance(resource_id, str) or not resource_id.strip():
                resource_id = f"{collection}-{index + 1}-{uuid.uuid4()}"
            resource["id"] = resource_id
            insert.execute(
                insert_sql,
                (
                    project_id,
                    collection,
                    resource_id,
                    _json.dumps(resource, separators=(",", ":")),
                    timestamp,
                    actor_id,
                )
            )
    settings = {
        "activeEnvironmentId": (
            document.get("activeEnvironmentId")
            if isinstance(document.get("activeEnvironmentId"), str)
            else ""
        )
    }
    database.execute(
        """
        INSERT OR IGNORE INTO project_settings
          (project_id, data, version, updated_at, updated_by)
        VALUES (?, ?, 1, ?, ?)
        """,
        (
            project_id,
            _json.dumps(settings, separators=(",", ":")),
            timestamp,
            actor_id,
        ),
    )


def create_resource_model(database: sqlite3.Connection) -> None:
    ensure_column(
        database, "platform_users", "enabled", "INTEGER NOT NULL DEFAULT 1"
    )
    exec_sql(
        database,
        """
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
        """,
    )
    documents = database.execute(
        "SELECT project_id, data FROM project_documents"
    ).fetchall()
    for project_id, data in documents:
        migrate_project_document_resources(
            database, project_id, parse_object(data)
        )


def add_managed_execution_and_review(database: sqlite3.Connection) -> None:
    ensure_column(
        database,
        "platform_runs",
        "executor_type",
        "TEXT NOT NULL DEFAULT 'agent'",
    )
    ensure_column(database, "platform_runs", "retry_of_run_id", "TEXT")
    ensure_column(database, "flow_revisions", "submitted_at", "TEXT")
    ensure_column(database, "flow_revisions", "reviewed_by", "TEXT")
    ensure_column(database, "flow_revisions", "review_note", "TEXT")
    database.execute(
        """
        CREATE INDEX IF NOT EXISTS platform_runs_executor_status
          ON platform_runs (executor_type, status, created_at)
        """
    )


def add_automation_governance(database: sqlite3.Connection) -> None:
    ensure_column(database, "platform_runs", "dispatch_key", "TEXT")
    ensure_column(database, "datasets", "archived_at", "TEXT")
    ensure_column(database, "schedules", "archived_at", "TEXT")
    ensure_column(database, "webhook_triggers", "archived_at", "TEXT")
    ensure_column(database, "notification_channels", "archived_at", "TEXT")
    database.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS platform_runs_dispatch_key
          ON platform_runs (dispatch_key) WHERE dispatch_key IS NOT NULL
        """
    )


def add_template_library(database: sqlite3.Connection) -> None:
    exec_sql(
        database,
        """
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
        CREATE INDEX IF NOT EXISTS internal_templates_search
          ON internal_templates (workspace_id, deleted_at, category, updated_at DESC);
        """,
    )


def add_managed_validation_artifacts(database: sqlite3.Connection) -> None:
    exec_sql(
        database,
        """
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
        """,
    )


def allow_blank_debug_sessions(database: sqlite3.Connection) -> None:
    tables = database.execute(
        """
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'debug_sessions'
        """
    ).fetchall()
    if not tables:
        return
    columns = {
        row[1]: row
        for row in database.execute("PRAGMA table_info(debug_sessions)").fetchall()
    }
    revision = columns.get("revision_id")
    if revision and revision[3] == 0:
        return
    database.execute("PRAGMA foreign_keys = OFF")
    try:
        database.execute("BEGIN IMMEDIATE")
        exec_sql(
            database,
            """
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
            INSERT INTO debug_sessions_new (
              id, project_id, revision_id, environment_id, agent_id, status,
              snapshot, current_step, current_url, browser_context_id,
              idle_expires_at, max_expires_at, created_by, created_at, updated_at
            )
            SELECT
              id, project_id, revision_id, environment_id, agent_id, status,
              snapshot, current_step, current_url, browser_context_id,
              idle_expires_at, max_expires_at, created_by, created_at, updated_at
            FROM debug_sessions;
            DROP TABLE debug_sessions;
            ALTER TABLE debug_sessions_new RENAME TO debug_sessions;
            """,
        )
        database.execute("COMMIT")
    except Exception:
        database.execute("ROLLBACK")
        raise
    finally:
        database.execute("PRAGMA foreign_keys = ON")


def drop_agent_and_debug_tables(database: sqlite3.Connection) -> None:
    database.execute("PRAGMA foreign_keys = OFF")
    try:
        database.execute("BEGIN IMMEDIATE")
        exec_sql(
            database,
            """
            DROP TABLE IF EXISTS picker_captures;
            DROP TABLE IF EXISTS debug_session_events;
            DROP TABLE IF EXISTS debug_artifacts;
            DROP TABLE IF EXISTS debug_sessions;
            DROP TABLE IF EXISTS run_leases;
            DROP TABLE IF EXISTS agent_bindings;
            DROP TABLE IF EXISTS agent_tokens;
            """,
        )
        database.execute("COMMIT")
    except Exception:
        database.execute("ROLLBACK")
        raise
    finally:
        database.execute("PRAGMA foreign_keys = ON")


def drop_dead_tables_and_columns(database: sqlite3.Connection) -> None:
    database.execute("PRAGMA foreign_keys = OFF")
    try:
        database.execute("BEGIN IMMEDIATE")
        exec_sql(
            database,
            """
            DROP TABLE IF EXISTS workspace_invitations;
            DROP TABLE IF EXISTS agent_tokens;
            DROP TABLE IF EXISTS agent_bindings;
            DROP TABLE IF EXISTS run_leases;
            DROP TABLE IF EXISTS debug_sessions;
            DROP TABLE IF EXISTS debug_session_events;
            DROP TABLE IF EXISTS debug_artifacts;
            DROP TABLE IF EXISTS picker_captures;
            """,
        )
        webhook_columns = {
            row[1]
            for row in database.execute(
                "PRAGMA table_info(webhook_triggers)"
            ).fetchall()
        }
        if "token_hash" in webhook_columns:
            exec_sql(
                database,
                """
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
                  last_triggered_at TEXT,
                  archived_at TEXT
                );
                INSERT INTO webhook_triggers_new (
                  id, project_id, revision_id, environment_id, dataset_version_id,
                  name, signing_secret_iv, signing_secret_tag, signing_secret_ciphertext,
                  enabled, created_by, created_at, last_triggered_at, archived_at
                )
                SELECT
                  id, project_id, revision_id, environment_id, dataset_version_id,
                  name, signing_secret_iv, signing_secret_tag, signing_secret_ciphertext,
                  enabled, created_by, created_at, last_triggered_at, archived_at
                FROM webhook_triggers;
                DROP TABLE webhook_triggers;
                ALTER TABLE webhook_triggers_new RENAME TO webhook_triggers;
                CREATE INDEX IF NOT EXISTS webhook_triggers_project
                  ON webhook_triggers (project_id, enabled);
                """,
            )
        database.execute("COMMIT")
    except Exception:
        database.execute("ROLLBACK")
        raise
    finally:
        database.execute("PRAGMA foreign_keys = ON")

    def has_table(table: str) -> bool:
        return bool(
            database.execute(
                """
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name = ?
                """,
                (table,),
            ).fetchone()
        )

    def has_columns(table: str, columns: list[str]) -> bool:
        if not has_table(table):
            return False
        found = {
            row[1]
            for row in database.execute(f"PRAGMA table_info({table})").fetchall()
        }
        return all(column in found for column in columns)

    if has_columns("audit_events", ["project_id", "created_at"]):
        database.execute(
            """
            CREATE INDEX IF NOT EXISTS audit_events_project
              ON audit_events (project_id, created_at DESC)
            """
        )
    if has_columns("platform_run_events", ["run_id", "id"]):
        database.execute(
            """
            CREATE INDEX IF NOT EXISTS platform_run_events_run
              ON platform_run_events (run_id, id)
            """
        )
    if has_columns("deliveries", ["status", "next_attempt_at"]):
        database.execute(
            """
            CREATE INDEX IF NOT EXISTS deliveries_due
              ON deliveries (status, next_attempt_at)
            """
        )


def add_run_batches(database: sqlite3.Connection) -> None:
    ensure_column(database, "platform_runs", "batch_id", "TEXT")
    ensure_column(database, "platform_runs", "batch_item_index", "INTEGER")
    exec_sql(
        database,
        """
        CREATE TABLE IF NOT EXISTS run_batches (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES platform_projects(id),
          environment_id TEXT NOT NULL,
          client_request_id TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          retry_of_batch_id TEXT REFERENCES run_batches(id),
          requested_flow_ids TEXT NOT NULL,
          cancellation_requested INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (project_id, client_request_id)
        );
        CREATE INDEX IF NOT EXISTS run_batches_project
          ON run_batches (project_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS platform_runs_batch_item
          ON platform_runs (batch_id, batch_item_index)
          WHERE batch_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS platform_runs_batch_status
          ON platform_runs (batch_id, status);
        """,
    )


def add_identity_membership_rbac(database: sqlite3.Connection) -> None:
    """Normalize legacy roles and add controlled local-account primitives."""
    ensure_column(database, "platform_users", "enabled", "INTEGER NOT NULL DEFAULT 1")
    ensure_column(database, "platform_users", "global_role", "TEXT")
    exec_sql(
        database,
        """
        CREATE TABLE IF NOT EXISTS workspace_members (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          user_id TEXT NOT NULL REFERENCES platform_users(id),
          role TEXT NOT NULL,
          PRIMARY KEY (workspace_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS platform_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES platform_users(id),
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        """,
    )
    database.execute(
        """
        UPDATE workspace_members
        SET role = CASE lower(role)
          WHEN 'owner' THEN 'admin'
          WHEN 'admin' THEN 'admin'
          ELSE 'member'
        END
        """
    )
    database.execute(
        """
        UPDATE platform_users
        SET global_role = NULL
        WHERE global_role IS NOT NULL AND global_role != 'super_admin'
        """
    )
    # Session tokens do not carry role data, but revocation makes the migration
    # boundary explicit and prevents a browser from continuing an old session.
    database.execute("DELETE FROM platform_sessions")
    exec_sql(
        database,
        """
        CREATE TABLE IF NOT EXISTS workspace_invitations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES platform_users(id),
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          consumed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES platform_users(id),
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES platform_users(id),
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          consumed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS workspace_invitations_workspace
          ON workspace_invitations (workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS workspace_invitations_email
          ON workspace_invitations (email, expires_at);
        CREATE INDEX IF NOT EXISTS password_reset_tokens_user
          ON password_reset_tokens (user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS workspace_members_role
          ON workspace_members (workspace_id, role);
        CREATE INDEX IF NOT EXISTS platform_users_global_role
          ON platform_users (global_role, enabled);
        """,
    )


def add_deployment_audit_events(database: sqlite3.Connection) -> None:
    """Add a deployment ledger for security actions without a workspace."""
    exec_sql(
        database,
        """
        CREATE TABLE IF NOT EXISTS deployment_audit_events (
          id TEXT PRIMARY KEY,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          detail TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS deployment_audit_events_created
          ON deployment_audit_events (created_at DESC);
        """,
    )


def run_platform_migrations(
    database: sqlite3.Connection,
    bootstrap_schema: str,
) -> None:
    database.isolation_level = None
    database.execute("PRAGMA journal_mode = WAL")
    database.execute("PRAGMA foreign_keys = ON")
    database.execute("PRAGMA busy_timeout = 5000")
    run_migrations(
        database,
        [
            {
                "version": 1,
                "name": "bootstrap-platform-schema",
                "up": lambda target: exec_sql(target, bootstrap_schema),
            },
            {"version": 2, "name": "upgrade-legacy-columns", "up": upgrade_legacy_columns},
            {"version": 3, "name": "resource-level-project-data", "up": create_resource_model},
            {
                "version": 4,
                "name": "managed-execution-and-review",
                "up": add_managed_execution_and_review,
            },
            {
                "version": 5,
                "name": "automation-idempotency-and-archival",
                "up": add_automation_governance,
            },
            {"version": 6, "name": "internal-template-library", "up": add_template_library},
            {
                "version": 7,
                "name": "managed-validation-artifacts",
                "up": add_managed_validation_artifacts,
            },
            {
                "version": 8,
                "name": "blank-debug-sessions",
                "up": allow_blank_debug_sessions,
                "noTransaction": True,
            },
            {
                "version": 9,
                "name": "drop-agent-and-debug-tables",
                "up": drop_agent_and_debug_tables,
                "noTransaction": True,
            },
            {
                "version": 10,
                "name": "drop-dead-tables-and-columns",
                "up": drop_dead_tables_and_columns,
                "noTransaction": True,
            },
            {
                "version": 11,
                "name": "run-batches",
                "up": add_run_batches,
            },
            {
                "version": 12,
                "name": "local-accounts-membership-rbac",
                "up": add_identity_membership_rbac,
            },
            {
                "version": 13,
                "name": "deployment-security-audit",
                "up": add_deployment_audit_events,
            },
        ],
    )
    ensure_column(database, "webhook_triggers", "archived_at", "TEXT")
    ensure_column(database, "schedules", "archived_at", "TEXT")
    ensure_column(database, "datasets", "archived_at", "TEXT")
    ensure_column(database, "notification_channels", "archived_at", "TEXT")
