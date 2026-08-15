import asyncio
import json

from starlette.requests import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.services import AuthUser, PlatformServices


def test_automation_edit_endpoints(tmp_path, monkeypatch):
    services = PlatformServices(str(tmp_path))
    try:
        router = create_platform_router(services)
        user = AuthUser("edit-user", "edit@example.test", "Edit")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user.id, user.email, user.name, now()),
        )
        workspace = services.create_workspace(user, "Edit workspace")
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "edit-project",
                workspace["id"],
                "edit-project",
                "Edit project",
                "",
                now(),
                now(),
            ),
        )
        session = services.create_auth_session(user)

        route_map = {
            getattr(route, "path"): route
            for route in router.routes
            if hasattr(route, "path")
        }
        revisions_route = route_map["/api/platform/projects/{project_id}/revisions"]
        schedules_route = route_map["/api/platform/projects/{project_id}/schedules"]
        schedule_detail_route = route_map[
            "/api/platform/projects/{project_id}/schedules/{schedule_id}"
        ]
        webhook_triggers_route = route_map[
            "/api/platform/projects/{project_id}/webhook-triggers"
        ]
        webhook_detail_route = route_map[
            "/api/platform/projects/{project_id}/webhook-triggers/{trigger_id}"
        ]
        webhook_rotate_route = route_map[
            (
                "/api/platform/projects/{project_id}/webhook-triggers/"
                "{trigger_id}/rotate-secret"
            )
        ]
        notification_channels_route = route_map[
            "/api/platform/workspaces/{workspace_id}/notification-channels"
        ]
        notification_channel_detail_route = route_map[
            (
                "/api/platform/workspaces/{workspace_id}/notification-channels/"
                "{channel_id}"
            )
        ]
        notification_channel_test_route = route_map[
            (
                "/api/platform/workspaces/{workspace_id}/notification-channels/"
                "{channel_id}/test"
            )
        ]

        async def call_route(
            route,
            method="GET",
            body: bytes | None = None,
            **path_params: str,
        ):
            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": "/api",
                "raw_path": b"/api",
                "query_string": b"",
                "headers": [
                    (b"authorization", f"Bearer {session['token']}".encode())
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

            return await route.endpoint(Request(scope, receive=receive), **path_params)

        revision_response = asyncio.run(
            call_route(
                revisions_route,
                method="POST",
                project_id="edit-project",
                body=json.dumps(
                    {
                        "flow": {
                            "id": "flow-1",
                            "name": "Flow",
                            "steps": [{"id": "step-1", "action": "open"}],
                        },
                        "environment": {
                            "id": "env-1",
                            "browser": "Chromium",
                            "baseUrl": "https://example.test",
                        },
                        "elements": [],
                    }
                ).encode(),
            )
        )
        assert revision_response.status_code == 201
        revision_id = json.loads(revision_response.body)["revision"]["id"]

        schedule_response = asyncio.run(
            call_route(
                schedules_route,
                method="POST",
                project_id="edit-project",
                body=json.dumps(
                    {
                        "name": "Daily",
                        "revisionId": revision_id,
                        "environmentId": "env-1",
                        "cron": "0 9 * * 1-5",
                        "timezone": "Asia/Shanghai",
                    }
                ).encode(),
            )
        )
        assert schedule_response.status_code == 201
        schedule = json.loads(schedule_response.body)["schedule"]

        schedule_update_response = asyncio.run(
            call_route(
                schedule_detail_route,
                method="PUT",
                project_id="edit-project",
                schedule_id=schedule["id"],
                body=json.dumps(
                    {
                        "name": "Nightly",
                        "revisionId": revision_id,
                        "environmentId": "env-1",
                        "cron": "0 0 * * *",
                        "timezone": "UTC",
                    }
                ).encode(),
            )
        )
        assert schedule_update_response.status_code == 200
        updated_schedule = json.loads(schedule_update_response.body)["schedule"]
        assert updated_schedule["name"] == "Nightly"
        assert updated_schedule["cron"] == "0 0 * * *"

        webhook_response = asyncio.run(
            call_route(
                webhook_triggers_route,
                method="POST",
                project_id="edit-project",
                body=json.dumps(
                    {
                        "name": "CI hook",
                        "revisionId": revision_id,
                        "environmentId": "env-1",
                    }
                ).encode(),
            )
        )
        assert webhook_response.status_code == 201
        trigger = json.loads(webhook_response.body)["trigger"]
        original_secret = json.loads(webhook_response.body)["signingSecret"]

        webhook_update_response = asyncio.run(
            call_route(
                webhook_detail_route,
                method="PUT",
                project_id="edit-project",
                trigger_id=trigger["id"],
                body=json.dumps(
                    {
                        "name": "Release hook",
                        "revisionId": revision_id,
                        "environmentId": "env-1",
                    }
                ).encode(),
            )
        )
        assert webhook_update_response.status_code == 200
        assert json.loads(webhook_update_response.body)["trigger"]["name"] == "Release hook"

        rotate_response = asyncio.run(
            call_route(
                webhook_rotate_route,
                method="POST",
                project_id="edit-project",
                trigger_id=trigger["id"],
            )
        )
        assert rotate_response.status_code == 200
        rotated_secret = json.loads(rotate_response.body)["signingSecret"]
        assert rotated_secret.startswith("whsec_")
        assert rotated_secret != original_secret

        services.notification_target = lambda value: {
            "url": value,
            "address": "127.0.0.1",
        }
        channel_response = asyncio.run(
            call_route(
                notification_channels_route,
                method="POST",
                workspace_id=workspace["id"],
                body=json.dumps(
                    {
                        "name": "Ops",
                        "type": "webhook",
                        "config": {
                            "url": "https://hooks.example.test/ops",
                            "keyword": "AutoFlow",
                        },
                    }
                ).encode(),
            )
        )
        assert channel_response.status_code == 201
        channel = json.loads(channel_response.body)["channel"]

        channel_update_response = asyncio.run(
            call_route(
                notification_channel_detail_route,
                method="PUT",
                workspace_id=workspace["id"],
                channel_id=channel["id"],
                body=json.dumps(
                    {
                        "name": "Ops renamed",
                        "type": "feishu",
                        "enabled": False,
                    }
                ).encode(),
            )
        )
        assert channel_update_response.status_code == 200
        updated_channel = json.loads(channel_update_response.body)["channel"]
        assert updated_channel["name"] == "Ops renamed"
        assert updated_channel["type"] == "feishu"
        assert updated_channel["enabled"] is False

        monkeypatch.setattr(
            "autoflow.services._post_notification",
            lambda *args, **kwargs: {"status": 200, "body": ""},
        )
        test_response = asyncio.run(
            call_route(
                notification_channel_test_route,
                method="POST",
                workspace_id=workspace["id"],
                channel_id=channel["id"],
            )
        )
        assert test_response.status_code == 200
        assert json.loads(test_response.body) == {
            "tested": True,
            "status": 200,
            "error": None,
        }
    finally:
        services.database.close()
