import asyncio
import json
import shutil

import pytest
from fastapi import Request

from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.main import (
    MAINTENANCE_FAILURE_CODE,
    MaintenanceHealth,
    _MaintenanceSchedule,
    _maintenance_pass,
    _maintenance_loop,
    create_app,
)
from autoflow.services import AuthUser, PlatformServices


def _route(app, path: str):
    return next(route for route in app.routes if getattr(route, "path", None) == path)


def _endpoint_response(app, path: str):
    return asyncio.run(_route(app, path).endpoint())


def _artifact_response(services: PlatformServices, token: str):
    async def request():
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/platform/artifacts/artifact-restored",
            "raw_path": b"/api/platform/artifacts/artifact-restored",
            "query_string": b"",
            "headers": [(b"authorization", f"Bearer {token}".encode())],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8787),
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        route = next(
            route
            for route in create_platform_router(services).routes
            if getattr(route, "path", None)
            == "/api/platform/artifacts/{artifact_id}"
        )
        return await route.endpoint(
            Request(scope, receive=receive), artifact_id="artifact-restored"
        )

    return asyncio.run(request())


def _create_owner_run(services: PlatformServices) -> tuple[AuthUser, str]:
    user = AuthUser("artifact-owner", "artifact-owner@example.test", "Artifact owner")
    services.database.execute(
        "INSERT INTO platform_users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
        (user.id, user.email, user.name, now()),
    )
    workspace = services.create_workspace(user, "Artifact workspace")
    project_id = "artifact-project"
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', ?, ?)
        """,
        (project_id, workspace["id"], project_id, "Artifact project", now(), now()),
    )
    services.database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at, last_seen_at
        ) VALUES ('artifact-agent', ?, 'Managed', 'hash', 'online', 'chromium',
                  'linux', 1, ?, ?)
        """,
        (workspace["id"], now(), now()),
    )
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, revision_number, status, flow_snapshot,
          environment_snapshot, element_snapshot, dataset_snapshot,
          checksum, created_at, created_by
        ) VALUES ('artifact-revision', ?, 1, 'published', '{}', '{}', '[]', '{}',
                  'artifact-checksum', ?, ?)
        """,
        (project_id, now(), user.id),
    )
    services.database.execute(
        """
        INSERT INTO platform_runs (
          id, project_id, revision_id, environment_id, agent_id, executor_type,
          status, snapshot, created_by, created_at, updated_at
        ) VALUES ('artifact-run', ?, 'artifact-revision', 'environment-1',
                  'artifact-agent', 'managed', 'success', '{}', ?, ?, ?)
        """,
        (project_id, user.id, now(), now()),
    )
    return user, project_id


def test_platform_services_artifacts_are_data_scoped_and_download_after_restore(
    tmp_path, monkeypatch
):
    legacy_artifact_directory = tmp_path / "legacy-artifacts"
    monkeypatch.setenv("PLATFORM_ARTIFACT_DIRECTORY", str(legacy_artifact_directory))
    data_directory = tmp_path / "platform-data"
    services = PlatformServices(str(data_directory))
    try:
        artifact_directory = services.managed_runner.artifact_directory
        assert artifact_directory == data_directory / "artifacts"
        assert artifact_directory != legacy_artifact_directory

        artifact_directory.mkdir(parents=True, exist_ok=True)
        artifact_path = artifact_directory / "artifact-restored.png"
        artifact_content = b"restored artifact fixture"
        artifact_path.write_bytes(artifact_content)

        backup_artifacts = tmp_path / "backup" / "artifacts"
        shutil.copytree(artifact_directory, backup_artifacts)
        shutil.rmtree(artifact_directory)
        shutil.copytree(backup_artifacts, artifact_directory)

        user, project_id = _create_owner_run(services)
        services.database.execute(
            """
            INSERT INTO platform_artifacts (
              id, run_id, project_id, name, content_type, path, created_at
            ) VALUES ('artifact-restored', 'artifact-run', ?, 'restored.png',
                      'image/png', ?, ?)
            """,
            (project_id, str(artifact_path), now()),
        )
        token = services.create_auth_session(user)["token"]
        response = _artifact_response(services, token)
        assert response.status_code == 200
        assert str(response.path) == str(artifact_path)
        assert artifact_path.read_bytes() == artifact_content
        assert response.media_type == "image/png"
    finally:
        services.close()


def test_ready_exposes_safe_normal_and_degraded_maintenance_state(tmp_path):
    services = PlatformServices(str(tmp_path / "data"))
    app = create_app(services)
    maintenance = app.state.maintenance_health

    try:
        health = _endpoint_response(app, "/health")
        normal = _endpoint_response(app, "/ready")
        assert health.status_code == 200
        assert json.loads(health.body) == {"ok": True, "queue": "online"}
        assert normal.status_code == 200
        assert json.loads(normal.body) == {
            "ready": True,
            "maintenance": {
                "healthy": True,
                "lastFailureAt": None,
                "failureCode": None,
            },
        }

        maintenance.mark_failed("2026-08-20T00:00:00.000Z")
        degraded = _endpoint_response(app, "/ready")

        assert degraded.status_code == 200
        assert json.loads(degraded.body) == {
            "ready": True,
            "maintenance": {
                "healthy": False,
                "lastFailureAt": "2026-08-20T00:00:00.000Z",
                "failureCode": MAINTENANCE_FAILURE_CODE,
            },
        }
    finally:
        services.close()


class _UnavailableDatabase:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, *_args, **_kwargs):
        raise RuntimeError("database-url=https://secret.example.test/?token=secret-token")

    def close(self):
        self.connection.close()


def test_ready_reports_sqlite_failure_without_exception_details(tmp_path):
    services = PlatformServices(str(tmp_path / "data"))
    app = create_app(services)
    services.database = _UnavailableDatabase(services.database)
    try:
        response = _endpoint_response(app, "/ready")

        assert response.status_code == 503
        assert json.loads(response.body) == {
            "ready": False,
            "maintenance": {
                "healthy": True,
                "lastFailureAt": None,
                "failureCode": None,
            },
        }
        response_text = response.body.decode()
        for sensitive_fragment in (
            "database-url",
            "https://",
            "secret.example.test",
            "token=",
            "secret-token",
        ):
            assert sensitive_fragment not in response_text
    finally:
        services.close()


def test_lifespan_starts_the_maintenance_loop(tmp_path, monkeypatch):
    services = PlatformServices(str(tmp_path / "data"))
    app = create_app(services)
    started = asyncio.Event()

    async def running_maintenance_loop(received_services, received_health):
        assert received_services is services
        assert received_health is app.state.maintenance_health
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(
        "autoflow.main._maintenance_loop", running_maintenance_loop
    )
    try:
        async def exercise_lifespan():
            async with app.router.lifespan_context(app):
                await asyncio.wait_for(started.wait(), timeout=1)

        asyncio.run(exercise_lifespan())
    finally:
        services.close()


def test_failed_retention_cleanup_does_not_mark_schedule_complete():
    class _Rows:
        def fetchall(self):
            return []

    class _FailingDatabase:
        def execute(self, statement, *_args):
            if "SELECT id FROM platform_runs" in statement:
                return _Rows()
            raise RuntimeError("retention cleanup failed")

    class _RecordingCoordinator:
        def sweep_expired(self):
            return None

    class _Services:
        database = _FailingDatabase()
        recording_coordinator = _RecordingCoordinator()

        def process_due_schedules(self):
            return None

        def deliver_pending_notifications(self):
            return None

        def retention_cleanup(self, **kwargs):
            raise RuntimeError("retention cleanup failed")

    schedule = _MaintenanceSchedule(
        retention_audit_days=180,
        retention_run_days=90,
        retention_artifact_days=15,
        retention_dry_run=False,
        last_retention_cleanup=-3600,
    )

    with pytest.raises(RuntimeError, match="retention cleanup failed"):
        _maintenance_pass(_Services(), schedule)

    assert schedule.last_retention_cleanup == -3600


def test_maintenance_failure_is_redacted_and_a_successful_pass_recovers(
    tmp_path, caplog, monkeypatch
):
    services = PlatformServices(str(tmp_path / "data"))
    maintenance = MaintenanceHealth()
    sensitive_message = "password=super-secret url=https://secret.example.test/?token=abc"

    async def fail_maintenance_pass(_services, _schedule):
        raise RuntimeError(sensitive_message)

    monkeypatch.setattr("autoflow.main._run_maintenance_pass", fail_maintenance_pass)
    try:
        with caplog.at_level("ERROR", logger="autoflow.main"):
            asyncio.run(
                _maintenance_loop(
                    services,
                    maintenance,
                    interval_seconds=0,
                    max_passes=1,
                )
            )

        failure_records = [
            record for record in caplog.records if record.name == "autoflow.main"
        ]
        assert len(failure_records) == 1
        failure_event = json.loads(failure_records[0].getMessage())
        assert failure_event["event"] == "maintenance.failed"
        assert failure_event["failureCode"] == MAINTENANCE_FAILURE_CODE
        assert failure_event["failureAt"] == maintenance.last_failure_at
        assert maintenance.healthy is False
        assert maintenance.failure_code == MAINTENANCE_FAILURE_CODE
        for sensitive_fragment in (
            sensitive_message,
            "password=",
            "url=",
            "token=",
            "secret.example.test",
            "super-secret",
        ):
            assert sensitive_fragment not in caplog.text
        failed_at = maintenance.last_failure_at

        async def successful_maintenance_pass(_services, _schedule):
            return None

        monkeypatch.setattr(
            "autoflow.main._run_maintenance_pass", successful_maintenance_pass
        )
        asyncio.run(
            _maintenance_loop(
                services,
                maintenance,
                interval_seconds=0,
                max_passes=1,
            )
        )

        assert maintenance.healthy is True
        assert maintenance.failure_code is None
        assert maintenance.last_failure_at == failed_at
    finally:
        services.close()
