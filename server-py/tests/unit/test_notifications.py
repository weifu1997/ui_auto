import autoflow.services as services_module
from autoflow.core import json, now
from autoflow.services import AuthUser, PlatformServices


def test_deliver_pending_notification_marks_delivered_and_audits(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        user = AuthUser("notify-owner", "notify@example.test", "Notify")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user.id, user.email, user.name, now()),
        )
        workspace = services.create_workspace(user, "Notify workspace")
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "notify-project",
                workspace["id"],
                "notify-project",
                "Notify project",
                "",
                now(),
                now(),
            ),
        )
        services.database.execute(
            """
            INSERT INTO agents (
              id, workspace_id, name, credential_hash, status,
              browser_version, os, max_concurrency, created_at
            ) VALUES (?, ?, 'ManagedRunner', ?, 'disabled', 'bundled',
                      'Windows', 1, ?)
            """,
            (
                "notify-agent",
                workspace["id"],
                "hash",
                now(),
            ),
        )
        services.database.execute(
            """
            INSERT INTO flow_revisions (
              id, project_id, flow_id, flow_name, environment_id,
              revision_number, status, flow_snapshot, environment_snapshot,
              element_snapshot, dataset_snapshot, checksum, created_by,
              created_at, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "notify-revision",
                "notify-project",
                "flow-1",
                "Flow",
                "env-1",
                1,
                '{"steps": []}',
                '{"id":"env-1","browser":"Chromium"}',
                "[]",
                "{}",
                "checksum",
                user.id,
                now(),
                now(),
            ),
        )
        services.database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id,
              executor_type, status, snapshot, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'managed', 'success', '{}', ?, ?, ?)
            """,
            (
                "notify-run",
                "notify-project",
                "notify-revision",
                "env-1",
                "notify-agent",
                user.id,
                now(),
                now(),
            ),
        )
        encrypted = services.encrypt(
            json({"url": "http://127.0.0.1:8787/api/auth/logout"})
        )
        services.database.execute(
            """
            INSERT INTO notification_channels (
              id, workspace_id, name, channel_type, config_iv, config_tag,
              config_ciphertext, enabled, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, 'webhook', ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                "notify-channel",
                workspace["id"],
                "Notify",
                encrypted["iv"],
                encrypted["tag"],
                encrypted["ciphertext"],
                user.id,
                now(),
                now(),
            ),
        )
        services.database.execute(
            """
            INSERT INTO deliveries (
              id, channel_id, run_id, status, attempt_count, payload,
              created_at, updated_at
            ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
            """,
            (
                "notify-delivery",
                "notify-channel",
                "notify-run",
                json(
                    {
                        "status": "success",
                        "runId": "notify-run",
                        "environmentId": "env-1",
                    }
                ),
                now(),
                now(),
            ),
        )

        original_post = services_module._post_notification
        original_target = services.notification_target
        services_module._post_notification = lambda _target, _headers, _body: {
            "status": 200,
            "body": "{}",
        }
        services.notification_target = lambda value: {
            "url": value,
            "address": "127.0.0.1",
        }
        try:
            services.deliver_pending_notifications()
        finally:
            services_module._post_notification = original_post
            services.notification_target = original_target

        delivery = services.database.execute(
            "SELECT status, attempt_count, response_code, error FROM deliveries WHERE id = ?",
            ("notify-delivery",),
        ).fetchone()
        assert delivery[0] == "delivered"
        assert delivery[1] == 1
        assert delivery[2] == 200
        assert delivery[3] is None
        audit = services.database.execute(
            """
            SELECT action, detail FROM audit_events
            WHERE target_id = ? AND action = 'notification.delivered'
            """,
            ("notify-channel",),
        ).fetchone()
        assert audit is not None
        assert "notify-channel" in audit[1] or "Notify" in audit[1]
    finally:
        services.close()
