import asyncio
import json

import pytest
from starlette.requests import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices


def _user(services: PlatformServices, user_id: str, email: str) -> AuthUser:
    user = AuthUser(user_id, email, user_id)
    services.database.execute(
        "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
        (user.id, user.email, user.name, now()),
    )
    return user


def _project(services: PlatformServices, project_id: str, workspace_id: str) -> None:
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', ?, ?)
        """,
        (project_id, workspace_id, project_id, project_id, now(), now()),
    )


def _route(services: PlatformServices, path: str, method: str):
    return next(
        route
        for route in create_platform_router(services).routes
        if getattr(route, "path", "") == path
        and method in (getattr(route, "methods", None) or set())
    )


def test_resource_version_conflict_reports_actor_and_time(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        user = _user(services, "member-a", "member-a@example.test")
        workspace = services.create_workspace(user, "Workspace A")
        _project(services, "project-a", workspace["id"])
        updated_at = "2026-08-20T10:00:00.000Z"
        services.database.execute(
            """
            INSERT INTO project_resources (
              project_id, resource_type, resource_id, data, version,
              updated_at, updated_by
            ) VALUES ('project-a', 'flows', 'flow-a', '{}', 1, ?, ?)
            """,
            (updated_at, user.id),
        )
        session = services.create_auth_session(user)
        route = _route(
            services,
            "/api/platform/projects/{project_id}/resources/{resource_type}/{resource_id}",
            "PUT",
        )
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "PUT",
            "scheme": "http",
            "path": "/api",
            "raw_path": b"/api",
            "query_string": b"",
            "headers": [(b"authorization", f"Bearer {session['token']}".encode())],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8787),
        }

        async def receive():
            return {
                "type": "http.request",
                "body": json.dumps(
                    {"data": {"name": "changed"}, "expectedVersion": 0}
                ).encode(),
                "more_body": False,
            }

        with pytest.raises(PlatformError) as error:
            asyncio.run(
                route.endpoint(
                    Request(scope, receive=receive),
                    project_id="project-a",
                    resource_type="flows",
                    resource_id="flow-a",
                )
            )
        assert error.value.status == 409
        assert error.value.code == "RESOURCE_VERSION_CONFLICT"
        assert error.value.detail == {"updatedBy": user.id, "updatedAt": updated_at}
    finally:
        services.close()
