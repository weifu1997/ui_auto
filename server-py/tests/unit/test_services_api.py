from autoflow.services import AuthUser, PlatformServices
from autoflow.core import json


def test_auth_workspace_document_and_resource_services(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        user = AuthUser("user-1", "owner@example.test", "Owner")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user.id, user.email, user.name, "2026-08-15T00:00:00.000Z"),
        )
        services.database.execute(
            """
            INSERT INTO platform_user_credentials (
              user_id, password_hash, created_at, updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            (user.id, "hash", "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:00.000Z"),
        )
        workspace = services.create_workspace(user, "Owner workspace")
        assert workspace["name"] == "Owner workspace"
        assert services.workspaces_for_user(user.id)[0]["id"] == workspace["id"]

        session = services.create_auth_session(user)
        assert services.session_user(
            {"authorization": f"Bearer {session['token']}"}
        ).id == user.id

        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "project-1",
                workspace["id"],
                "project-1",
                "Project 1",
                "",
                "2026-08-15T00:00:00.000Z",
                "2026-08-15T00:00:00.000Z",
            ),
        )
        document = services.put_document(
            "project-1",
            {
                "environments": [
                    {
                        "id": "internal",
                        "name": "Internal",
                        "baseUrl": "https://internal.example.test",
                        "browser": "Chromium",
                    }
                ]
            },
        )
        assert document["version"] == 1
        resources = services.database.execute(
            """
            SELECT resource_id FROM project_resources
            WHERE project_id = ? AND resource_type = 'environments'
            """,
            ("project-1",),
        ).fetchall()
        assert [row[0] for row in resources] == ["internal"]

        encrypted = services.encrypt("secret-value")
        assert services.decrypt(encrypted) == "secret-value"
    finally:
        services.close()


def test_workspace_isolation_and_resource_version_conflict(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        user = AuthUser("user-2", "owner2@example.test", "Owner2")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user.id, user.email, user.name, "2026-08-15T00:00:00.000Z"),
        )
        services.database.execute(
            """
            INSERT INTO platform_user_credentials (
              user_id, password_hash, created_at, updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            (user.id, "hash", "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:00.000Z"),
        )
        workspace = services.create_workspace(user, "Workspace")
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "project-2",
                workspace["id"],
                "project-2",
                "Project 2",
                "",
                "2026-08-15T00:00:00.000Z",
                "2026-08-15T00:00:00.000Z",
            ),
        )
        services.database.execute(
            """
            INSERT INTO project_resources (
              project_id, resource_type, resource_id, data, version,
              updated_at, updated_by
            ) VALUES (?, 'variables', ?, ?, 1, ?, ?)
            """,
            (
                "project-2",
                "login-password",
                '{"id":"login-password","name":"login_password","value":"","secret":true}',
                "2026-08-15T00:00:00.000Z",
                user.id,
            ),
        )
        cursor = services.database.execute(
            """
            UPDATE project_resources
            SET data = ?, version = version + 1, updated_at = ?, updated_by = ?
            WHERE project_id = ? AND resource_type = 'variables'
              AND resource_id = ? AND version = ?
            """,
            (
                '{"id":"login-password","name":"login_password","value":"","secret":true,"description":"rotated"}',
                "2026-08-15T00:01:00.000Z",
                user.id,
                "project-2",
                "login-password",
                1,
            ),
        )
        assert cursor.rowcount == 1
        conflict = services.database.execute(
            """
            UPDATE project_resources
            SET data = ?, version = version + 1, updated_at = ?, updated_by = ?
            WHERE project_id = ? AND resource_type = 'variables'
              AND resource_id = ? AND version = ?
            """,
            (
                '{"id":"login-password","name":"login_password","value":"","secret":true,"description":"stale"}',
                "2026-08-15T00:02:00.000Z",
                user.id,
                "project-2",
                "login-password",
                1,
            ),
        )
        assert conflict.rowcount == 0
        row = services.database.execute(
            """
            SELECT data FROM project_resources
            WHERE project_id = ? AND resource_type = 'variables'
              AND resource_id = ?
            """,
            ("project-2", "login-password"),
        ).fetchone()
        assert "rotated" in row[0]
        assert "stale" not in row[0]
        stranger = AuthUser("stranger-1", "stranger@example.test", "Stranger")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (stranger.id, stranger.email, stranger.name, "2026-08-15T00:00:00.000Z"),
        )
        services.database.execute(
            """
            INSERT INTO platform_user_credentials (
              user_id, password_hash, created_at, updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            (
                stranger.id,
                "hash",
                "2026-08-15T00:00:00.000Z",
                "2026-08-15T00:00:00.000Z",
            ),
        )
        from autoflow.http import PlatformError

        try:
            services.require_workspace_role(workspace["id"], stranger.id)
            raise AssertionError("stranger should not access another workspace")
        except PlatformError as exc:
            assert exc.status == 403
            assert exc.code == "WORKSPACE_ACCESS_DENIED"
    finally:
        services.close()


def test_project_analytics_summary_trend_and_impact(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        user = AuthUser("analytics-owner", "analytics@example.test", "Analytics")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user.id, user.email, user.name, "2026-08-10T00:00:00.000Z"),
        )
        workspace = services.create_workspace(user, "Analytics workspace")
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "analytics-project",
                workspace["id"],
                "analytics-project",
                "Analytics project",
                "",
                "2026-08-10T00:00:00.000Z",
                "2026-08-10T00:00:00.000Z",
            ),
        )
        services.database.execute(
            """
            INSERT INTO agents (
              id, workspace_id, name, credential_hash, status,
              browser_version, os, max_concurrency, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "analytics-agent",
                workspace["id"],
                "Managed",
                "hash",
                "online",
                "chromium",
                "linux",
                1,
                "2026-08-10T00:00:00.000Z",
            ),
        )
        snapshot = {
            "flow": {
                "id": "flow-1",
                "steps": [{"id": "step-1", "element": "element-1"}],
            },
            "elements": [{"id": "element-1", "name": "Login button"}],
        }
        services.database.execute(
            """
            INSERT INTO flow_revisions (
              id, project_id, flow_id, flow_name, environment_id,
              revision_number, status, flow_snapshot, environment_snapshot,
              element_snapshot, dataset_snapshot, checksum, created_by,
              created_at, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "revision-1",
                "analytics-project",
                "flow-1",
                "Flow",
                "env-1",
                1,
                "published",
                '{"steps": []}',
                "{}",
                "[]",
                "{}",
                "checksum",
                user.id,
                "2026-08-10T00:00:00.000Z",
                "2026-08-10T00:00:00.000Z",
            ),
        )

        def insert_run(
            run_id: str,
            status: str,
            created_at: str,
        ) -> None:
            services.database.execute(
                """
                INSERT INTO platform_runs (
                  id, project_id, revision_id, environment_id, agent_id,
                  status, snapshot, cancellation_requested, result,
                  created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    "analytics-project",
                    "revision-1",
                    "env-1",
                    "analytics-agent",
                    status,
                    json(snapshot),
                    0,
                    None,
                    user.id,
                    created_at,
                    created_at,
                ),
            )

        insert_run("run-failed", "failed", "2026-08-14T00:00:00.000Z")
        insert_run("run-success", "success", "2026-08-15T00:00:00.000Z")
        services.database.execute(
            """
            INSERT INTO platform_run_events (run_id, kind, data, created_at)
            VALUES
              (?, 'run.started', '{}', '2026-08-14T00:00:00.000Z'),
              (?, 'step.completed',
               '{"stepId":"step-1","title":"Login","durationMs":1200}',
               '2026-08-14T00:00:01.000Z'),
              (?, 'run.failed',
               '{"stepId":"step-1","message":"Timeout","code":"TIMEOUT"}',
               '2026-08-14T00:00:03.000Z'),
              (?, 'run.started', '{}', '2026-08-15T00:00:00.000Z'),
              (?, 'run.complete', '{}', '2026-08-15T00:00:02.000Z')
            """,
            (
                "run-failed",
                "run-failed",
                "run-failed",
                "run-success",
                "run-success",
            ),
        )
        services.audit(
            workspace["id"],
            {"type": "system", "id": "schedule:one"},
            "schedule.triggered",
            {"type": "schedule", "id": "schedule-one"},
            {"runIds": ["run-failed"]},
            "analytics-project",
        )
        services.audit(
            workspace["id"],
            {"type": "system", "id": "schedule:one"},
            "schedule.triggered",
            {"type": "schedule", "id": "schedule-one"},
            {"runIds": ["run-success"]},
            "analytics-project",
        )
        services.audit(
            workspace["id"],
            {"type": "system", "id": "schedule:one"},
            "schedule.skipped",
            {"type": "schedule", "id": "schedule-one"},
            {"error": "SCHEDULE_TRIGGER_FAILED"},
            "analytics-project",
        )

        analytics = services.project_analytics(
            "analytics-project", {"windowDays": 30}
        )
        assert analytics["summary"]["totalRuns"] == 2
        assert analytics["summary"]["successRate"] == 50
        assert analytics["summary"]["failedRuns"] == 1
        assert analytics["summary"]["canceledRuns"] == 0
        assert [point["date"] for point in analytics["trend"]] == [
            "2026-08-14",
            "2026-08-15",
        ]
        assert analytics["failureCategories"] == [
            {"category": "timeout", "count": 1, "dimension": "message"}
        ]
        assert analytics["slowSteps"] == [
            {
                "stepId": "step-1",
                "title": "Login",
                "count": 1,
                "averageMs": 1200,
                "maxMs": 1200,
            }
        ]
        assert analytics["elementImpact"] == [
            {
                "elementId": "element-1",
                "name": "Login button",
                "runCount": 2,
                "flowCount": 1,
                "failedRuns": 1,
                "lastUsedAt": "2026-08-15T00:00:00.000Z",
            }
        ]
        assert analytics["scheduleHealth"] == {
            "triggered": 2,
            "skipped": 1,
            "successRate": 67,
        }
        assert len(analytics["runDurations"]) == 2
    finally:
        services.close()
