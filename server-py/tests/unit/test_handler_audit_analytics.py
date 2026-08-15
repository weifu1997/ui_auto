import asyncio
import base64
import hashlib
import hmac
import json
import time

from starlette.requests import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices


def test_platform_route_contracts(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        router = create_platform_router(services)
        user = AuthUser("http-user", "http@example.test", "HTTP")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user.id, user.email, user.name, now()),
        )
        workspace = services.create_workspace(user, "HTTP workspace")
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "http-project",
                workspace["id"],
                "http-project",
                "HTTP project",
                "",
                now(),
                now(),
            ),
        )
        session = services.create_auth_session(user)
        audit_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/audit-events"
        )
        analytics_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/analytics"
        )
        settings_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/settings"
        )
        secrets_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/secrets"
        )
        revisions_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/revisions"
        )
        revision_action_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/revisions/{revision_id}/{action}"
        )
        templates_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None) == "/api/platform/templates"
        )
        template_detail_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None) == "/api/platform/templates/{template_id}"
        )
        template_favorite_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/templates/{template_id}/favorite"
        )
        template_apply_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/templates/{template_id}/apply"
        )
        datasets_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/datasets"
        )
        dataset_versions_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/datasets/{dataset_id}/versions"
        )
        dataset_version_detail_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/dataset-versions/{version_id}"
        )
        schedules_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/schedules"
        )
        schedule_action_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/schedules/{schedule_id}/{action}"
        )
        webhook_triggers_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/webhook-triggers"
        )
        webhook_action_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == (
                "/api/platform/projects/{project_id}/webhook-triggers/"
                "{trigger_id}/{action}"
            )
        )
        public_webhook_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/webhooks/{trigger_id}"
        )
        notification_channels_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/workspaces/{workspace_id}/notification-channels"
        )
        notification_channel_detail_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == (
                "/api/platform/workspaces/{workspace_id}/notification-channels/"
                "{channel_id}"
            )
        )
        notification_subscriptions_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/notification-subscriptions"
        )
        deliveries_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/deliveries"
        )
        platform_runs_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/runs"
        )
        local_storage_import_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/workspaces/{workspace_id}/imports/local-storage"
        )
        platform_run_detail_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/runs/{run_id}"
        )
        platform_run_cancel_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/runs/{run_id}/cancel"
        )
        platform_run_retry_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/runs/{run_id}/retry"
        )
        element_validations_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/element-validations"
        )
        element_validation_detail_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == (
                "/api/platform/projects/{project_id}/element-validations/"
                "{validation_id}"
            )
        )

        async def call_route(
            route,
            project_id: str,
            method: str = "GET",
            body: bytes | None = None,
            query_string: bytes = b"",
            headers: list[tuple[bytes, bytes]] | None = None,
            **path_params: str,
        ):
            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": f"/api/platform/projects/{project_id}",
                "raw_path": f"/api/platform/projects/{project_id}".encode(),
                "query_string": query_string,
                "headers": [
                    (b"authorization", f"Bearer {session['token']}".encode()),
                    *(headers or []),
                ],
                "client": ("127.0.0.1", 1234),
                "server": ("127.0.0.1", 8787),
            }

            async def receive():
                return {
                    "type": "http.request",
                    "body": body or b"",
                    "more_body": False,
                }

            endpoint_params = dict(path_params)
            if "{project_id}" in getattr(route, "path", ""):
                endpoint_params["project_id"] = project_id
            return await route.endpoint(Request(scope, receive=receive), **endpoint_params)

        audit_response = asyncio.run(call_route(audit_route, "http-project"))
        assert audit_response.status_code == 200
        audit = json.loads(audit_response.body)
        assert audit["page"] == 1
        assert audit["pageSize"] == 20
        assert audit["total"] >= 0
        assert isinstance(audit["events"], list)

        analytics_response = asyncio.run(call_route(analytics_route, "http-project"))
        assert analytics_response.status_code == 200
        analytics = json.loads(analytics_response.body)["analytics"]
        assert analytics["summary"]["totalRuns"] == 0
        assert "previous" in analytics
        assert "trend" in analytics
        assert "scheduleHealth" in analytics

        settings_response = asyncio.run(call_route(settings_route, "http-project"))
        assert settings_response.status_code == 200
        assert json.loads(settings_response.body)["settings"]["version"] == 0

        update_settings_response = asyncio.run(
            call_route(
                settings_route,
                "http-project",
                method="PUT",
                body=b'{"data":{"theme":"dark"},"expectedVersion":0}',
            )
        )
        assert update_settings_response.status_code == 200
        settings = json.loads(update_settings_response.body)["settings"]
        assert settings["data"] == {"theme": "dark"}
        assert settings["version"] == 1

        create_secret_response = asyncio.run(
            call_route(
                secrets_route,
                "http-project",
                method="POST",
                body=b'{"name":"api-key","value":"top-secret"}',
            )
        )
        assert create_secret_response.status_code == 201
        created_secret = json.loads(create_secret_response.body)["secret"]
        assert created_secret["name"] == "api-key"
        assert created_secret["keyVersion"] == 1

        list_secrets_response = asyncio.run(
            call_route(secrets_route, "http-project")
        )
        assert list_secrets_response.status_code == 200
        secrets = json.loads(list_secrets_response.body)["secrets"]
        assert secrets == [
            {
                "id": created_secret["id"],
                "name": "api-key",
                "keyVersion": 1,
                "createdAt": secrets[0]["createdAt"],
                "updatedAt": secrets[0]["updatedAt"],
            }
        ]

        create_revision_response = asyncio.run(
            call_route(
                revisions_route,
                "http-project",
                method="POST",
                body=(
                    b'{"flow":{"id":"flow-1","name":"Flow","steps":[{"id":"step-1"}]},'
                    b'"environment":{"id":"env-1","browser":"Chromium",'
                    b'"baseUrl":"https://example.test"},"elements":[]}'
                ),
            )
        )
        assert create_revision_response.status_code == 201
        created_revision = json.loads(create_revision_response.body)["revision"]
        assert created_revision["revisionNumber"] == 1
        assert created_revision["status"] == "published"
        assert created_revision["stepCount"] == 1

        list_revisions_response = asyncio.run(
            call_route(revisions_route, "http-project")
        )
        assert list_revisions_response.status_code == 200
        revisions = json.loads(list_revisions_response.body)["revisions"]
        assert len(revisions) == 1
        assert revisions[0]["id"] == created_revision["id"]

        publish_response = asyncio.run(
            call_route(
                revision_action_route,
                "http-project",
                method="POST",
                body=b'{"note":"publish"}',
                revision_id=created_revision["id"],
                action="publish",
            )
        )
        assert publish_response.status_code == 200
        assert json.loads(publish_response.body)["status"] == "published"

        rollback_response = asyncio.run(
            call_route(
                revision_action_route,
                "http-project",
                method="POST",
                body=b'{"note":"rollback"}',
                revision_id=created_revision["id"],
                action="rollback",
            )
        )
        assert rollback_response.status_code == 201
        rollback = json.loads(rollback_response.body)
        assert rollback["sourceRevisionId"] == created_revision["id"]
        assert rollback["status"] == "published"

        list_revisions_after = asyncio.run(
            call_route(revisions_route, "http-project")
        )
        assert list_revisions_after.status_code == 200
        assert len(json.loads(list_revisions_after.body)["revisions"]) == 2

        create_template_response = asyncio.run(
            call_route(
                templates_route,
                "http-project",
                method="POST",
                body=json.dumps(
                    {
                        "projectId": "http-project",
                        "revisionId": rollback["revisionId"],
                        "name": "Login template",
                        "description": "",
                        "category": "通用",
                    }
                ).encode(),
                query_string=f"workspaceId={workspace['id']}".encode(),
            )
        )
        assert create_template_response.status_code == 201
        template = json.loads(create_template_response.body)["template"]
        assert template["name"] == "Login template"

        list_templates_response = asyncio.run(
            call_route(
                templates_route,
                "http-project",
                query_string=f"workspaceId={workspace['id']}&q=Login".encode(),
            )
        )
        assert list_templates_response.status_code == 200
        templates = json.loads(list_templates_response.body)["templates"]
        assert [item["id"] for item in templates] == [template["id"]]

        get_template_response = asyncio.run(
            call_route(
                template_detail_route,
                "http-project",
                template_id=template["id"],
            )
        )
        assert get_template_response.status_code == 200
        template_snapshot = json.loads(get_template_response.body)["template"][
            "snapshot"
        ]
        assert template_snapshot["flow"]["id"] == "flow-1"

        patch_template_response = asyncio.run(
            call_route(
                template_detail_route,
                "http-project",
                method="PATCH",
                body=b'{"name":"Renamed template"}',
                template_id=template["id"],
            )
        )
        assert patch_template_response.status_code == 200
        assert json.loads(patch_template_response.body)["template"]["name"] == (
            "Renamed template"
        )

        favorite_response = asyncio.run(
            call_route(
                template_favorite_route,
                "http-project",
                method="POST",
                template_id=template["id"],
            )
        )
        assert favorite_response.status_code == 200
        assert json.loads(favorite_response.body)["favorite"] is True

        apply_template_response = asyncio.run(
            call_route(
                template_apply_route,
                "http-project",
                method="POST",
                body=b'{"projectId":"http-project"}',
                template_id=template["id"],
            )
        )
        assert apply_template_response.status_code == 201
        applied = json.loads(apply_template_response.body)
        assert applied["projectId"] == "http-project"
        assert len(applied["created"]["flows"]) == 1

        csv_payload = base64.b64encode(
            b"name,email\nAlice,alice@example.test\nBob,bob@example.test"
        ).decode()
        create_dataset_response = asyncio.run(
            call_route(
                datasets_route,
                "http-project",
                method="POST",
                body=json.dumps(
                    {
                        "name": "Contacts",
                        "description": "",
                        "fileName": "contacts.csv",
                        "contentBase64": csv_payload,
                    }
                ).encode(),
            )
        )
        assert create_dataset_response.status_code == 201
        dataset = json.loads(create_dataset_response.body)["dataset"]
        dataset_version = json.loads(create_dataset_response.body)["version"]
        assert dataset["name"] == "Contacts"
        assert dataset_version["versionNumber"] == 1
        assert dataset_version["rowCount"] == 2

        list_datasets_response = asyncio.run(
            call_route(datasets_route, "http-project")
        )
        assert list_datasets_response.status_code == 200
        datasets = json.loads(list_datasets_response.body)["datasets"]
        assert [item["id"] for item in datasets] == [dataset["id"]]
        assert datasets[0]["latestVersion"]["rowCount"] == 2

        version_detail_response = asyncio.run(
            call_route(
                dataset_version_detail_route,
                "http-project",
                version_id=dataset_version["id"],
            )
        )
        assert version_detail_response.status_code == 200
        version_detail = json.loads(version_detail_response.body)
        assert len(version_detail["rows"]) == 2
        assert version_detail["truncated"] is False

        create_dataset_version_response = asyncio.run(
            call_route(
                dataset_versions_route,
                "http-project",
                method="POST",
                body=json.dumps(
                    {
                        "fileName": "contacts-v2.csv",
                        "contentBase64": csv_payload,
                    }
                ).encode(),
                dataset_id=dataset["id"],
            )
        )
        assert create_dataset_version_response.status_code == 201
        assert (
            json.loads(create_dataset_version_response.body)["version"][
                "versionNumber"
            ]
            == 2
        )

        create_schedule_response = asyncio.run(
            call_route(
                schedules_route,
                "http-project",
                method="POST",
                body=json.dumps(
                    {
                        "name": "Nightly",
                        "revisionId": rollback["revisionId"],
                        "environmentId": "env-1",
                        "cron": "0 0 * * *",
                        "timezone": "Asia/Shanghai",
                    }
                ).encode(),
            )
        )
        assert create_schedule_response.status_code == 201
        schedule = json.loads(create_schedule_response.body)["schedule"]
        assert schedule["enabled"] is True

        services.database.execute(
            "UPDATE schedules SET next_run_at = ? WHERE id = ?",
            ("2000-01-01T00:00:00.000Z", schedule["id"]),
        )
        services.process_due_schedules()
        schedule_run_count = services.database.execute(
            """
            SELECT COUNT(*) FROM platform_runs
            WHERE project_id = ? AND created_by = ?
            """,
            ("http-project", f"schedule:{schedule['id']}"),
        ).fetchone()[0]
        assert schedule_run_count == 1

        disable_schedule_response = asyncio.run(
            call_route(
                schedule_action_route,
                "http-project",
                method="POST",
                schedule_id=schedule["id"],
                action="disable",
            )
        )
        assert disable_schedule_response.status_code == 200
        assert json.loads(disable_schedule_response.body)["enabled"] is False

        run_schedule_response = asyncio.run(
            call_route(
                schedule_action_route,
                "http-project",
                method="POST",
                schedule_id=schedule["id"],
                action="run",
            )
        )
        assert run_schedule_response.status_code == 202
        assert len(json.loads(run_schedule_response.body)["runIds"]) == 1

        create_webhook_response = asyncio.run(
            call_route(
                webhook_triggers_route,
                "http-project",
                method="POST",
                body=json.dumps(
                    {
                        "name": "CI hook",
                        "revisionId": rollback["revisionId"],
                        "environmentId": "env-1",
                    }
                ).encode(),
            )
        )
        assert create_webhook_response.status_code == 201
        webhook = json.loads(create_webhook_response.body)
        trigger = webhook["trigger"]
        signing_secret = webhook["signingSecret"]

        disable_webhook_response = asyncio.run(
            call_route(
                webhook_action_route,
                "http-project",
                method="POST",
                trigger_id=trigger["id"],
                action="disable",
            )
        )
        assert disable_webhook_response.status_code == 200
        assert json.loads(disable_webhook_response.body)["enabled"] is False

        webhook_timestamp = str(int(time.time() * 1000))
        webhook_body = b'{"commit":"abc"}'
        webhook_signature = (
            "sha256="
            + hmac.new(
                signing_secret.encode(),
                f"{webhook_timestamp}.{webhook_body.decode()}".encode(),
                hashlib.sha256,
            ).hexdigest()
        )
        try:
            asyncio.run(
                call_route(
                    public_webhook_route,
                    "http-project",
                    method="POST",
                    body=webhook_body,
                    headers=[
                        (b"x-autoflow-timestamp", webhook_timestamp.encode()),
                        (b"x-autoflow-signature", webhook_signature.encode()),
                        (b"x-autoflow-delivery-id", b"delivery-1"),
                    ],
                    trigger_id=trigger["id"],
                )
            )
            raise AssertionError("disabled webhook should not be invocable")
        except PlatformError as exc:
            assert exc.code == "WEBHOOK_TRIGGER_NOT_FOUND"

        enable_webhook_response = asyncio.run(
            call_route(
                webhook_action_route,
                "http-project",
                method="POST",
                trigger_id=trigger["id"],
                action="enable",
            )
        )
        assert enable_webhook_response.status_code == 200
        enabled_trigger = services.database.execute(
            "SELECT enabled, archived_at FROM webhook_triggers WHERE id = ?",
            (trigger["id"],),
        ).fetchone()
        assert enabled_trigger == (1, None)
        invoke_webhook_response = asyncio.run(
            call_route(
                public_webhook_route,
                "http-project",
                method="POST",
                body=webhook_body,
                headers=[
                    (b"x-autoflow-timestamp", webhook_timestamp.encode()),
                    (b"x-autoflow-signature", webhook_signature.encode()),
                    (b"x-autoflow-delivery-id", b"delivery-1"),
                ],
                trigger_id=trigger["id"],
            )
        )
        assert invoke_webhook_response.status_code == 202
        assert len(json.loads(invoke_webhook_response.body)["runIds"]) == 1

        services.notification_target = lambda value: {
            "url": value,
            "address": "127.0.0.1",
        }
        create_channel_response = asyncio.run(
            call_route(
                notification_channels_route,
                "http-project",
                method="POST",
                body=json.dumps(
                    {
                        "name": "Ops",
                        "type": "webhook",
                        "config": {
                            "url": "http://127.0.0.1:8787/api/auth/logout",
                            "keyword": "AutoFlow",
                        },
                    }
                ).encode(),
                workspace_id=workspace["id"],
            )
        )
        assert create_channel_response.status_code == 201
        channel = json.loads(create_channel_response.body)["channel"]

        save_subscription_response = asyncio.run(
            call_route(
                notification_subscriptions_route,
                "http-project",
                method="PUT",
                body=json.dumps(
                    {"channelId": channel["id"], "onSuccess": True, "onFailure": False}
                ).encode(),
            )
        )
        assert save_subscription_response.status_code == 200
        subscription = json.loads(save_subscription_response.body)
        assert subscription["onSuccess"] is True
        assert subscription["onFailure"] is False

        list_subscriptions_response = asyncio.run(
            call_route(notification_subscriptions_route, "http-project")
        )
        assert list_subscriptions_response.status_code == 200
        subscriptions = json.loads(list_subscriptions_response.body)[
            "subscriptions"
        ]
        assert subscriptions[0]["channelId"] == channel["id"]

        deliveries_response = asyncio.run(
            call_route(deliveries_route, "http-project")
        )
        assert deliveries_response.status_code == 200
        assert json.loads(deliveries_response.body)["deliveries"] == []

        delete_channel_response = asyncio.run(
            call_route(
                notification_channel_detail_route,
                "http-project",
                method="DELETE",
                workspace_id=workspace["id"],
                channel_id=channel["id"],
            )
        )
        assert delete_channel_response.status_code == 200
        assert json.loads(delete_channel_response.body)["archived"] is True

        create_run_response = asyncio.run(
            call_route(
                platform_runs_route,
                "http-project",
                method="POST",
                body=json.dumps(
                    {
                        "revisionId": rollback["revisionId"],
                        "environmentId": "env-1",
                    }
                ).encode(),
            )
        )
        assert create_run_response.status_code == 202
        created_run = json.loads(create_run_response.body)
        run_id = created_run["runIds"][0]
        assert created_run["run"]["status"] == "queued"

        list_runs_response = asyncio.run(
            call_route(platform_runs_route, "http-project")
        )
        assert list_runs_response.status_code == 200
        listed_runs = json.loads(list_runs_response.body)["runs"]
        assert run_id in [item["id"] for item in listed_runs]

        get_run_response = asyncio.run(
            call_route(
                platform_run_detail_route,
                "http-project",
                run_id=run_id,
            )
        )
        assert get_run_response.status_code == 200
        assert json.loads(get_run_response.body)["run"]["id"] == run_id

        cancel_run_response = asyncio.run(
            call_route(
                platform_run_cancel_route,
                "http-project",
                method="POST",
                run_id=run_id,
            )
        )
        assert cancel_run_response.status_code == 202
        assert json.loads(cancel_run_response.body)["run"]["status"] == "canceled"

        retry_run_response = asyncio.run(
            call_route(
                platform_run_retry_route,
                "http-project",
                method="POST",
                run_id=run_id,
            )
        )
        assert retry_run_response.status_code == 202
        retried_run_id = json.loads(retry_run_response.body)["runIds"][0]
        assert retried_run_id != run_id

        services.database.execute(
            """
            INSERT INTO project_resources (
              project_id, resource_type, resource_id, data, version,
              updated_at, updated_by
            ) VALUES (?, 'environments', 'env-1', ?, 1, ?, ?)
            """,
            (
                "http-project",
                '{"id":"env-1","name":"Env","browser":"Chromium",'
                '"baseUrl":"https://example.test","timeout":30}',
                now(),
                user.id,
            ),
        )

        create_validation_response = asyncio.run(
            call_route(
                element_validations_route,
                "http-project",
                method="POST",
                body=json.dumps(
                    {
                        "environmentId": "env-1",
                        "element": {
                            "id": "element-1",
                            "name": "Login",
                            "path": "/login",
                        },
                    }
                ).encode(),
            )
        )
        assert create_validation_response.status_code == 202
        validation_id = json.loads(create_validation_response.body)["validation"][
            "id"
        ]
        get_validation_response = asyncio.run(
            call_route(
                element_validation_detail_route,
                "http-project",
                validation_id=validation_id,
            )
        )
        assert get_validation_response.status_code == 200
        assert (
            json.loads(get_validation_response.body)["validation"]["id"]
            == validation_id
        )

        import_body = json.dumps(
            {
                "sourceId": "local-storage-1",
                "data": {
                    "projects": [{"id": "source-project-1", "name": "Imported"}],
                    "flowsByProject": {"source-project-1": []},
                    "elementsByProject": {"source-project-1": []},
                    "variablesByProject": {"source-project-1": []},
                    "environmentsByProject": {"source-project-1": []},
                    "activeEnvironmentByProject": {"source-project-1": ""},
                    "membersByProject": {"source-project-1": []},
                },
            }
        ).encode()
        import_response = asyncio.run(
            call_route(
                local_storage_import_route,
                "http-project",
                method="POST",
                body=import_body,
                workspace_id=workspace["id"],
            )
        )
        assert import_response.status_code == 201
        assert json.loads(import_response.body)["imported"] is True

        repeat_import_response = asyncio.run(
            call_route(
                local_storage_import_route,
                "http-project",
                method="POST",
                body=import_body,
                workspace_id=workspace["id"],
            )
        )
        assert repeat_import_response.status_code == 200
        assert json.loads(repeat_import_response.body)["imported"] is False
    finally:
        services.close()
