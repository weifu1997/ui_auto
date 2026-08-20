import asyncio
from json import dumps, loads

import pytest
from fastapi import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices


def _setup_services(tmp_path):
    services = PlatformServices(str(tmp_path))
    database = services.database
    user = AuthUser("u1", "u@test.com", "User")
    database.execute(
        "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
        (user.id, user.email, user.name, now()),
    )
    workspace_id = services.create_workspace(user, "W1")["id"]
    for project_id in ("p1", "p2"):
        database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, '', ?, ?)
            """,
            (project_id, workspace_id, project_id, project_id.upper(), now(), now()),
        )
    database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at, last_seen_at
        ) VALUES ('ag1', ?, 'Agent1', 'h', 'online', '1.0', 'Linux', 1, ?, ?)
        """,
        (workspace_id, now(), now()),
    )
    for project_id in ("p1", "p2"):
        database.execute(
            """
            INSERT INTO flow_revisions (
              id, project_id, revision_number, status, flow_snapshot,
              environment_snapshot, element_snapshot, dataset_snapshot,
              checksum, created_at, created_by
            ) VALUES (?, ?, 1, 'published', '{}', '{}', '[]', '{}', ?, ?, ?)
            """,
            (f"rev-{project_id}", project_id, f"chk-{project_id}", now(), user.id),
        )

    runs = (
        ("r1", "p1", "success"),
        ("r2", "p1", "failed"),
        ("r3", "p1", "canceled"),
        ("r-active", "p1", "running"),
        ("r-foreign", "p2", "success"),
    )
    for run_id, project_id, status in runs:
        database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id,
              executor_type, status, snapshot, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, 'env1', 'ag1', 'browser', ?, '{}', ?, ?, ?)
            """,
            (run_id, project_id, f"rev-{project_id}", status, user.id, now(), now()),
        )
    for run_id, project_id in (("r1", "p1"), ("r-foreign", "p2")):
        database.execute(
            "INSERT INTO platform_run_events (run_id, kind, data, created_at) VALUES (?, 'step', '{}', ?)",
            (run_id, now()),
        )
        database.execute(
            """
            INSERT INTO platform_artifacts (
              id, run_id, project_id, name, content_type, path, created_at
            ) VALUES (?, ?, ?, 'screen.png', 'image/png', '/path', ?)
            """,
            (f"artifact-{run_id}", run_id, project_id, now()),
        )
    return services, user


def _call_route(route, token, project_id, method, body=None, **path_params):
    async def execute():
        payload = dumps(body).encode() if body is not None else b""
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": f"/api/platform/projects/{project_id}/runs",
            "raw_path": f"/api/platform/projects/{project_id}/runs".encode(),
            "query_string": b"",
            "headers": [
                (b"authorization", f"Bearer {token}".encode()),
                (b"content-type", b"application/json"),
            ],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8787),
        }

        async def receive():
            return {"type": "http.request", "body": payload, "more_body": False}

        return await route.endpoint(
            Request(scope, receive=receive), project_id=project_id, **path_params
        )

    return asyncio.run(execute())


def test_run_deletion_is_terminal_and_project_scoped(tmp_path):
    services, _user = _setup_services(tmp_path)
    database = services.database
    try:
        with pytest.raises(PlatformError) as error:
            services.delete_run("p1", "r-active")
        assert error.value.status == 409
        assert error.value.code == "RUN_NOT_DELETABLE"

        deleted = services.delete_run("p1", "r1")
        assert deleted == {"runId": "r1", "deleted": True}
        assert database.execute(
            "SELECT COUNT(*) FROM platform_run_events WHERE run_id = 'r1'"
        ).fetchone()[0] == 0
        assert database.execute(
            "SELECT COUNT(*) FROM platform_artifacts WHERE run_id = 'r1'"
        ).fetchone()[0] == 0

        batch = services.delete_runs(
            "p1", ["r2", "r3", "r-active", "r-foreign", "missing"]
        )
        assert set(batch["runIds"]) == {"r2", "r3"}
        assert batch["deletedCount"] == 2
        remaining_ids = {
            row[0] for row in database.execute("SELECT id FROM platform_runs").fetchall()
        }
        assert remaining_ids == {"r-active", "r-foreign"}
        assert database.execute(
            "SELECT COUNT(*) FROM platform_run_events WHERE run_id = 'r-foreign'"
        ).fetchone()[0] == 1
        assert database.execute(
            "SELECT COUNT(*) FROM platform_artifacts WHERE run_id = 'r-foreign'"
        ).fetchone()[0] == 1
    finally:
        services.close()


def test_single_and_batch_delete_routes(tmp_path):
    services, user = _setup_services(tmp_path)
    try:
        token = services.create_auth_session(user)["token"]
        router = create_platform_router(services)

        def route(path):
            return next(item for item in router.routes if getattr(item, "path", None) == path)

        single_route = route("/api/platform/projects/{project_id}/runs/{run_id}")
        batch_route = route("/api/platform/projects/{project_id}/runs/batch-delete")

        single_response = _call_route(
            single_route, token, "p1", "DELETE", run_id="r1"
        )
        assert single_response.status_code == 200
        assert loads(single_response.body) == {"runId": "r1", "deleted": True}

        batch_response = _call_route(
            batch_route, token, "p1", "POST", {"runIds": ["r2", "r3"]}
        )
        assert batch_response.status_code == 200
        assert set(loads(batch_response.body)["runIds"]) == {"r2", "r3"}

        with pytest.raises(PlatformError) as error:
            _call_route(single_route, token, "p1", "DELETE", run_id="r-active")
        assert error.value.code == "RUN_NOT_DELETABLE"

        with pytest.raises(PlatformError) as error:
            _call_route(batch_route, token, "p1", "POST", {"runIds": []})
        assert error.value.code == "RUN_DELETE_INPUT_INVALID"
    finally:
        services.close()
