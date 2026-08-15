import asyncio
import json
import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from autoflow.http import PlatformError
from autoflow.worker import WorkerService, create_worker_router


def _run_request():
    return {
        "environment": {
            "id": "env-1",
            "name": "Worker environment",
            "baseUrl": "http://127.0.0.1:8787",
            "browser": "Chromium",
            "timeout": 10,
        },
        "flow": {"id": "flow-1", "name": "Retry flow", "steps": []},
        "elements": [],
    }


def _worker_app(worker):
    app = FastAPI()
    app.include_router(create_worker_router(worker))

    @app.exception_handler(PlatformError)
    async def platform_error_handler(request, exc):
        return JSONResponse(status_code=exc.status, content={"error": exc.code})

    return app


def test_worker_restores_tasks_artifacts_and_marks_interrupted(tmp_path):
    data_directory = str(tmp_path / "data")
    artifact_directory = str(tmp_path / "artifacts")
    worker = WorkerService(data_directory, artifact_directory)
    try:
        completed = worker.create_task("project-1", "run", _run_request())
        artifact_path = tmp_path / "artifacts" / "shot.png"
        artifact_path.write_bytes(b"png")
        artifact_id = worker._save_artifact(
            completed,
            "shot.png",
            "image/png",
            str(artifact_path),
        )
        worker.database.execute(
            "UPDATE worker_tasks SET status = 'success', result = ? WHERE id = ?",
            (
                json.dumps({"status": "success", "completedSteps": 2}),
                completed["id"],
            ),
        )
        interrupted = worker.create_task("project-1", "run", _run_request())
    finally:
        worker.close()

    worker = WorkerService(data_directory, artifact_directory)
    try:
        restored_completed = worker.task_by_id(
            "project-1", completed["id"], "run"
        )
        assert restored_completed["status"] == "success"
        assert restored_completed["result"]["completedSteps"] == 2
        assert worker.artifacts[artifact_id]["path"] == str(artifact_path)
        assert [
            artifact["id"]
            for artifact in worker.task_response(restored_completed)["artifacts"]
        ] == [artifact_id]

        restored_interrupted = worker.task_by_id(
            "project-1", interrupted["id"], "run"
        )
        assert restored_interrupted["status"] == "failed"
        assert restored_interrupted["result"]["error"] == "WORKER_RESTARTED"
        assert any(
            event["data"].get("error") == "WORKER_RESTARTED"
            for event in restored_interrupted["events"]
        )
    finally:
        worker.close()


def test_worker_retry_route_creates_a_new_run(tmp_path, monkeypatch):
    worker = WorkerService(str(tmp_path / "data"), str(tmp_path / "artifacts"))
    try:
        original = worker.create_task("project-1", "run", _run_request())
        enqueued = []
        monkeypatch.setattr(worker, "enqueue_run", enqueued.append)

        app = FastAPI()
        app.include_router(create_worker_router(worker))

        async def retry():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                return await client.post(
                    f"/api/projects/project-1/runs/{original['id']}/retry"
                )

        response = asyncio.run(retry())

        assert response.status_code == 202
        retried_id = response.json()["runId"]
        retried = worker.task_by_id("project-1", retried_id, "run")
        assert retried["summary"]["flowName"] == "Retry flow"
        assert enqueued == [retried]
    finally:
        worker.close()


def test_worker_cancel_route_returns_full_task(tmp_path, monkeypatch):
    worker = WorkerService(str(tmp_path / "data"), str(tmp_path / "artifacts"))
    try:
        original = worker.create_task("project-1", "run", _run_request())
        monkeypatch.setattr(worker, "enqueue_run", lambda task: None)

        app = _worker_app(worker)

        async def cancel():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                return await client.post(
                    f"/api/projects/project-1/runs/{original['id']}/cancel"
                )

        response = asyncio.run(cancel())

        assert response.status_code == 202
        body = response.json()
        assert body["id"] == original["id"]
        assert body["status"] == "canceled"
        assert body["artifacts"] == []
        assert isinstance(body["events"], list)
        assert body["queue"]["position"] is None
        assert body["queue"]["active"] is False
    finally:
        worker.close()


def test_worker_run_post_requires_secret_values(tmp_path, monkeypatch):
    worker = WorkerService(str(tmp_path / "data"), str(tmp_path / "artifacts"))
    try:
        enqueued = []
        monkeypatch.setattr(worker, "enqueue_run", enqueued.append)
        app = _worker_app(worker)

        async def post_run(variables):
            body = {**_run_request(), "secretKeys": ["project.password"]}
            body["variables"] = variables
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                return await client.post(
                    "/api/projects/project-1/runs", json=body
                )

        missing = asyncio.run(post_run({}))
        empty = asyncio.run(post_run({"project.password": ""}))

        assert missing.status_code == 409
        assert missing.json() == {"error": "RUN_SECRETS_REQUIRED"}
        assert empty.status_code == 409
        assert empty.json() == {"error": "RUN_SECRETS_REQUIRED"}
        assert enqueued == []
    finally:
        worker.close()


def test_worker_redacts_secret_values_in_events_results_and_persistence(tmp_path):
    worker = WorkerService(str(tmp_path / "data"), str(tmp_path / "artifacts"))
    try:
        request = _run_request()
        request["variables"] = {
            "project.password": "hunter2",
            "public": "visible",
        }
        request["secretKeys"] = ["project.password"]
        task = worker.create_task("project-1", "run", request)

        assert task["request"]["variables"]["project.password"] == "***"

        worker._publish(
            task,
            "step.failed",
            {
                "message": "expected hunter2",
                "items": ["hunter2"],
                "nested": {"detail": "hunter2"},
                "safe": "visible",
            },
        )
        event = task["events"][-1]
        assert event["data"]["message"] == "expected ***"
        assert event["data"]["items"] == ["***"]
        assert event["data"]["nested"] == {"detail": "***"}
        assert event["data"]["safe"] == "visible"
        assert "hunter2" not in json.dumps(event["data"])

        task["result"] = {
            "status": "failed",
            "error": "TEXT_ASSERTION_FAILED expected hunter2",
            "flowOutputs": {"value": "hunter2"},
        }
        worker._publish(task, "result", task["result"])

        response = worker.task_response(task)
        assert response["result"]["error"] == "TEXT_ASSERTION_FAILED expected ***"
        assert response["result"]["flowOutputs"] == {"value": "***"}

        event_row = worker.database.execute(
            """
            SELECT data FROM worker_events
            WHERE task_id = ? AND kind = 'result'
            """,
            (task["id"],),
        ).fetchone()
        assert event_row is not None
        assert "hunter2" not in event_row[0]
        assert "***" in event_row[0]

        task_row = worker.database.execute(
            "SELECT result FROM worker_tasks WHERE id = ?",
            (task["id"],),
        ).fetchone()
        assert task_row is not None
        assert "hunter2" not in task_row[0]
    finally:
        worker.close()


def test_sensitive_worker_retry_requires_fresh_secrets(tmp_path):
    worker = WorkerService(str(tmp_path / "data"), str(tmp_path / "artifacts"))
    try:
        request = _run_request()
        request["variables"] = {"project.password": "secret-value"}
        request["secretKeys"] = ["project.password"]
        original = worker.create_task("project-1", "run", request)
        with pytest.raises(PlatformError) as error:
            worker.retry_run("project-1", original["id"])
        assert error.value.status == 409
        assert error.value.code == "RUN_SECRETS_REQUIRED"
    finally:
        worker.close()


def test_picker_screenshot_refresh_updates_buffer(tmp_path):
    worker = WorkerService(str(tmp_path / "data"), str(tmp_path / "artifacts"))
    try:
        class FakePage:
            def __init__(self):
                self.calls = 0

            def screenshot(self, type):
                self.calls += 1
                return f"png-{self.calls}".encode()

        session = {
            "id": "picker-1",
            "page": FakePage(),
            "screenshotBuffer": b"old",
        }
        worker._refresh_picker_screenshot(session)
        assert session["screenshotBuffer"] == b"png-1"
        worker._refresh_picker_screenshot(session)
        assert session["screenshotBuffer"] == b"png-2"
    finally:
        worker.close()


def test_picker_sessions_expire_after_idle(tmp_path, monkeypatch):
    worker = WorkerService(str(tmp_path / "data"), str(tmp_path / "artifacts"))
    try:
        ended = []

        def end_session(session):
            ended.append(session["id"])
            worker.picker_sessions.pop(session["id"], None)

        monkeypatch.setattr(worker, "end_local_picker_session", end_session)
        now_ms = time.time() * 1000
        worker.picker_sessions["idle"] = {
            "id": "idle",
            "lastActivityAt": now_ms - 60_000,
            "expiresAt": now_ms + 60_000,
        }
        worker.picker_sessions["active"] = {
            "id": "active",
            "lastActivityAt": now_ms,
            "expiresAt": now_ms + 60_000,
        }
        worker.picker_idle_ms = 15_000

        worker._expire_picker_sessions()

        assert ended == ["idle"]
        assert "idle" not in worker.picker_sessions
        assert "active" in worker.picker_sessions
    finally:
        worker.close()
