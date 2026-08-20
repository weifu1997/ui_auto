import asyncio
import json

import pytest
from starlette.requests import Request

from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices
from autoflow.core import now


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


def test_notification_channel_test_cannot_cross_workspace_or_write_audit(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        user = _user(services, "workspace-a-user", "a@example.test")
        workspace_a = services.create_workspace(user, "Workspace A")
        workspace_b = services.create_workspace(
            _user(services, "workspace-b-user", "b@example.test"), "Workspace B"
        )
        channel_id = "channel-b"
        encrypted = services.encrypt(json.dumps({"url": "https://hooks.example.test"}))
        services.database.execute(
            """
            INSERT INTO notification_channels (
              id, workspace_id, name, channel_type, config_iv, config_tag,
              config_ciphertext, enabled, created_by, created_at, updated_at
            ) VALUES (?, ?, 'B', 'webhook', ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                channel_id,
                workspace_b["id"],
                encrypted["iv"],
                encrypted["tag"],
                encrypted["ciphertext"],
                user.id,
                now(),
                now(),
            ),
        )
        session = services.create_auth_session(user)
        before_audits = services.database.execute(
            "SELECT COUNT(*) FROM audit_events"
        ).fetchone()[0]
        route = next(
            route
            for route in create_platform_router(services).routes
            if getattr(route, "path", "")
            == (
                "/api/platform/workspaces/{workspace_id}/notification-channels/"
                "{channel_id}/test"
            )
        )
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
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
            return {"type": "http.request", "body": b"", "more_body": False}

        with pytest.raises(PlatformError) as error:
            asyncio.run(
                route.endpoint(
                    Request(scope, receive=receive),
                    workspace_id=workspace_a["id"],
                    channel_id=channel_id,
                )
            )
        assert error.value.status == 404
        assert error.value.code == "NOTIFICATION_CHANNEL_NOT_FOUND"
        assert services.database.execute(
            "SELECT COUNT(*) FROM audit_events"
        ).fetchone()[0] == before_audits
    finally:
        services.close()


def test_scoped_child_resolvers_return_not_found_for_foreign_project(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        owner_a = _user(services, "owner-a", "owner-a@example.test")
        owner_b = _user(services, "owner-b", "owner-b@example.test")
        workspace_a = services.create_workspace(owner_a, "Workspace A")
        workspace_b = services.create_workspace(owner_b, "Workspace B")
        _project(services, "project-a", workspace_a["id"])
        _project(services, "project-b", workspace_b["id"])
        services.database.execute(
            """
            INSERT INTO flow_revisions (
              id, project_id, revision_number, status, flow_snapshot,
              environment_snapshot, element_snapshot, dataset_snapshot,
              checksum, created_by, created_at
            ) VALUES ('revision-b', 'project-b', 1, 'published', '{}', '{}',
                      '[]', '{}', 'checksum-b', ?, ?)
            """,
            (owner_b.id, now()),
        )
        services.database.execute(
            """
            INSERT INTO agents (
              id, workspace_id, name, credential_hash, status, browser_version,
              os, max_concurrency, created_at
            ) VALUES ('agent-b', ?, 'Agent B', 'hash', 'online', 'Chromium',
                      'linux', 1, ?)
            """,
            (workspace_b["id"], now()),
        )
        services.database.execute(
            """
            INSERT INTO element_validations (
              id, project_id, environment_id, agent_id, status,
              element_snapshot, created_by, created_at, updated_at
            ) VALUES ('validation-b', 'project-b', 'env-b', 'agent-b',
                      'queued', '{}', ?, ?, ?)
            """,
            (owner_b.id, now(), now()),
        )
        with pytest.raises(PlatformError) as validation_error:
            services.element_validation_by_id("validation-b", "project-a")
        assert validation_error.value.code == "ELEMENT_VALIDATION_NOT_FOUND"

        services.database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id, status,
              snapshot, created_by, created_at, updated_at
            ) VALUES ('run-b', 'project-b', 'revision-b', 'env-b', 'agent-b',
                      'failed', '{}', ?, ?, ?)
            """,
            (owner_b.id, now(), now()),
        )
        with pytest.raises(PlatformError) as run_error:
            services.run_by_id("run-b", "project-a")
        assert run_error.value.code == "RUN_NOT_FOUND"
    finally:
        services.close()


def test_dataset_version_route_rejects_foreign_project_child(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        owner_a = _user(services, "dataset-owner-a", "dataset-a@example.test")
        owner_b = _user(services, "dataset-owner-b", "dataset-b@example.test")
        workspace_a = services.create_workspace(owner_a, "Workspace A")
        workspace_b = services.create_workspace(owner_b, "Workspace B")
        _project(services, "dataset-project-a", workspace_a["id"])
        _project(services, "dataset-project-b", workspace_b["id"])
        services.database.execute(
            """
            INSERT INTO datasets (
              id, project_id, name, description, created_by, created_at, updated_at
            ) VALUES ('dataset-b', 'dataset-project-b', 'B', '', ?, ?, ?)
            """,
            (owner_b.id, now(), now()),
        )
        services.database.execute(
            """
            INSERT INTO dataset_versions (
              id, dataset_id, version_number, columns_json, row_count,
              checksum, source_name, created_by, created_at
            ) VALUES ('dataset-version-b', 'dataset-b', 1, '[]', 0,
                      'checksum-b', 'b.csv', ?, ?)
            """,
            (owner_b.id, now()),
        )
        session = services.create_auth_session(owner_a)
        route = next(
            route
            for route in create_platform_router(services).routes
            if getattr(route, "path", "")
            == "/api/platform/projects/{project_id}/dataset-versions/{version_id}"
        )
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
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
            return {"type": "http.request", "body": b"", "more_body": False}

        with pytest.raises(PlatformError) as error:
            asyncio.run(
                route.endpoint(
                    Request(scope, receive=receive),
                    project_id="dataset-project-a",
                    version_id="dataset-version-b",
                )
            )
        assert error.value.status == 404
        assert error.value.code == "DATASET_VERSION_NOT_FOUND"
    finally:
        services.close()
