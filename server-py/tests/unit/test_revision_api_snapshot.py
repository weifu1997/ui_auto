import asyncio
import json

from starlette.requests import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.services import AuthUser, PlatformServices


def test_revision_snapshot_duplicate_and_execution_change(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        router = create_platform_router(services)
        user = AuthUser("snapshot-user", "snapshot@example.test", "Snapshot")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user.id, user.email, user.name, now()),
        )
        workspace = services.create_workspace(user, "Snapshot workspace")
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "snapshot-project",
                workspace["id"],
                "snapshot-project",
                "Snapshot project",
                "",
                now(),
                now(),
            ),
        )
        session = services.create_auth_session(user)
        revisions_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/revisions"
        )

        async def call_route(body: bytes):
            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": "/api/platform/projects/snapshot-project",
                "raw_path": "/api/platform/projects/snapshot-project".encode(),
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
                    "body": body,
                    "more_body": False,
                }

            return await revisions_route.endpoint(
                Request(scope, receive=receive),
                project_id="snapshot-project",
            )

        base_body = (
            b'{"flow":{"id":"flow-1","name":"Flow",'
            b'"updatedAt":"2030-01-01T00:00:00.000Z",'
            b'"steps":[{"id":"step-1","title":"Step",'
            b'"action":"open","value":"/login","timeout":30,'
            b'"failurePolicy":"immediate","status":"success"}]},'
            b'"environment":{"id":"env-1","browser":"Chromium",'
            b'"baseUrl":"https://example.test","updatedAt":"recent"},'
            b'"elements":[{"id":"element-1","name":"login",'
            b'"path":"/login","method":"testid","value":"login-button",'
            b'"environment":"env-1","validation":"unverified",'
            b'"updatedAt":"recent"}]}'
        )
        first_response = asyncio.run(call_route(base_body))
        assert first_response.status_code == 201
        first_revision = json.loads(first_response.body)["revision"]

        duplicate_body = base_body.replace(
            b'"updatedAt":"2030-01-01T00:00:00.000Z"',
            b'"updatedAt":"2030-01-02T00:00:00.000Z"',
        ).replace(
            b'"status":"success"',
            b'"status":"failed"',
        ).replace(
            b'"validation":"unverified"',
            b'"validation":"valid"',
        )
        duplicate_response = asyncio.run(call_route(duplicate_body))
        assert duplicate_response.status_code == 200
        duplicate_revision = json.loads(duplicate_response.body)["revision"]
        assert duplicate_revision["id"] == first_revision["id"]

        changed_body = base_body.replace(
            b'"value":"login-button"',
            b'"value":"other-button"',
        )
        changed_response = asyncio.run(call_route(changed_body))
        assert changed_response.status_code == 201
        changed_revision = json.loads(changed_response.body)["revision"]
        assert changed_revision["id"] != first_revision["id"]
    finally:
        services.database.close()
