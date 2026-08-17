import asyncio

from fastapi import Request

from autoflow.core import json
from autoflow.handler import create_platform_router
from autoflow.http import PlatformError
from autoflow.services import AuthUser, PlatformServices


def _setup_services(tmp_path):
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-1", "owner@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-16T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Batch workspace")
    project_id = "project-1"
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            workspace["id"],
            project_id,
            "Project",
            "",
            "2026-08-16T00:00:00.000Z",
            "2026-08-16T00:00:00.000Z",
        ),
    )
    services.enqueue_managed_run = lambda run_id: None
    return services, project_id


def _insert_revision(
    services,
    project_id,
    revision_id,
    flow_id,
    environment_id="env-1",
    status="published",
    published_at="2026-08-16T00:00:00.000Z",
    steps=(),
):
    revision_number = 1 + services.database.execute(
        "SELECT COUNT(*) FROM flow_revisions WHERE project_id = ?",
        (project_id,),
    ).fetchone()[0]
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
            revision_id,
            project_id,
            flow_id,
            f"Flow {flow_id}",
            environment_id,
            revision_number,
            status,
            json({"id": flow_id, "name": f"Flow {flow_id}", "steps": list(steps)}),
            json({"id": environment_id, "name": "Env", "browser": "Chromium"}),
            "[]",
            "{}",
            f"checksum-{revision_id}",
            "owner-1",
            published_at,
            published_at,
        ),
    )


def _create_two_flow_batch(services, project_id, key="key-1"):
    for revision_id, flow_id, step_id in (
        ("revision-a", "flow-a", "a-1"),
        ("revision-b", "flow-b", "b-1"),
    ):
        present = services.database.execute(
            "SELECT 1 FROM flow_revisions WHERE id = ?", (revision_id,)
        ).fetchone()
        if not present:
            _insert_revision(
                services, project_id, revision_id, flow_id, steps=[{"id": step_id}]
            )
    return services.create_run_batch(
        {
            "projectId": project_id,
            "flowIds": ["flow-a", "flow-b"],
            "environmentId": "env-1",
            "clientRequestId": key,
            "createdBy": "owner-1",
        }
    )


def _batch_count(services, project_id):
    return services.database.execute(
        "SELECT COUNT(*) FROM run_batches WHERE project_id = ?", (project_id,)
    ).fetchone()[0]


def _run_count(services, project_id):
    return services.database.execute(
        "SELECT COUNT(*) FROM platform_runs WHERE project_id = ?", (project_id,)
    ).fetchone()[0]


def _set_run_status(services, run, status):
    services.database.execute(
        "UPDATE platform_runs SET status = ? WHERE id = ?",
        (status, run["id"]),
    )


def test_batch_create_orders_runs_and_sets_batch_context(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        created = _create_two_flow_batch(services, project_id)
        assert created["replayed"] is False
        batch = created["batch"]
        assert batch["status"] == "queued"
        assert batch["counts"] == {
            "total": 2, "queued": 2, "running": 0,
            "success": 0, "failed": 0, "canceled": 0, "completed": 0,
        }
        runs = created["runs"]
        assert [run["batchItemIndex"] for run in runs] == [0, 1]
        assert [run["revisionId"] for run in runs] == ["revision-a", "revision-b"]
        for run in services.batch_runs(project_id, batch["id"]):
            snapshot = run["snapshot"]
            assert snapshot["batchId"] == batch["id"]
            assert snapshot["batchItemIndex"] == run["batchItemIndex"]
        queued_rows = services.database.execute(
            """
            SELECT COUNT(*) FROM platform_runs
            WHERE executor_type = 'managed' AND status = 'queued'
            """
        ).fetchone()[0]
        assert queued_rows == 2
    finally:
        services.close()


def test_batch_preflight_failure_rejects_whole_batch(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a", "flow-a", steps=[{"id": "a-1"}])
        try:
            services.create_run_batch(
                {
                    "projectId": project_id,
                    "flowIds": ["flow-a", "flow-missing"],
                    "environmentId": "env-1",
                    "clientRequestId": "key-1",
                    "createdBy": "owner-1",
                }
            )
            raise AssertionError("preflight failure must reject the batch")
        except PlatformError as exc:
            assert exc.status == 409
            assert exc.code == "BATCH_PREFLIGHT_FAILED"
            assert exc.detail == {
                "items": [{"flowId": "flow-missing", "code": "PUBLISHED_REVISION_REQUIRED"}]
            }
        assert _batch_count(services, project_id) == 0
        assert _run_count(services, project_id) == 0
    finally:
        services.close()


def test_batch_input_validation_limits(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a", "flow-a", steps=[{"id": "a-1"}])

        def expect_error(payload, code):
            try:
                services.create_run_batch(payload)
                raise AssertionError(f"expected {code}")
            except PlatformError as exc:
                assert exc.code == code

        expect_error(
            {"projectId": project_id, "flowIds": ["flow-a"], "environmentId": "env-1",
             "clientRequestId": "k", "createdBy": "owner-1"},
            "BATCH_FLOW_COUNT_INVALID",
        )
        expect_error(
            {"projectId": project_id, "flowIds": ["flow-a"] * 2, "environmentId": "env-1",
             "clientRequestId": "k", "createdBy": "owner-1"},
            "BATCH_DUPLICATE_FLOW",
        )
        expect_error(
            {"projectId": project_id, "flowIds": ["flow-a", "flow-b"], "environmentId": "",
             "clientRequestId": "k", "createdBy": "owner-1"},
            "ENVIRONMENT_REQUIRED",
        )
        expect_error(
            {"projectId": project_id, "flowIds": ["flow-a", "flow-b"], "environmentId": "env-1",
             "clientRequestId": "", "createdBy": "owner-1"},
            "BATCH_CLIENT_REQUEST_ID_REQUIRED",
        )
        expect_error(
            {"projectId": project_id, "flowIds": ["flow-a", "flow-b"], "environmentId": "env-1",
             "clientRequestId": "k", "createdBy": "owner-1", "upToStepId": "a-1"},
            "BATCH_INPUT_NOT_SUPPORTED",
        )
        assert _run_count(services, project_id) == 0
    finally:
        services.close()


def test_batch_total_steps_limit(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        _insert_revision(
            services, project_id, "revision-a", "flow-a",
            steps=[{"id": f"a-{i}"} for i in range(1200)],
        )
        _insert_revision(
            services, project_id, "revision-b", "flow-b",
            steps=[{"id": f"b-{i}"} for i in range(1200)],
        )
        try:
            services.create_run_batch(
                {"projectId": project_id, "flowIds": ["flow-a", "flow-b"],
                 "environmentId": "env-1", "clientRequestId": "k",
                 "createdBy": "owner-1"}
            )
            raise AssertionError("expected total step limit")
        except PlatformError as exc:
            assert exc.status == 413
            assert exc.code == "BATCH_TOTAL_STEPS_EXCEEDED"
        assert _batch_count(services, project_id) == 0
    finally:
        services.close()


def test_batch_idempotency_replay_and_key_conflict(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        created = _create_two_flow_batch(services, project_id, key="key-1")
        replay = services.create_run_batch(
            {"projectId": project_id, "flowIds": ["flow-a", "flow-b"],
             "environmentId": "env-1", "clientRequestId": "key-1",
             "createdBy": "owner-1"}
        )
        assert replay["replayed"] is True
        assert replay["batch"]["id"] == created["batch"]["id"]
        assert _batch_count(services, project_id) == 1
        assert _run_count(services, project_id) == 2
        try:
            services.create_run_batch(
                {"projectId": project_id, "flowIds": ["flow-b", "flow-a"],
                 "environmentId": "env-1", "clientRequestId": "key-1",
                 "createdBy": "owner-1"}
            )
            raise AssertionError("payload conflict must be rejected")
        except PlatformError as exc:
            assert exc.status == 409
            assert exc.code == "IDEMPOTENCY_KEY_REUSED"
        assert _run_count(services, project_id) == 2
    finally:
        services.close()


def test_batch_status_aggregation_matrix(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        created = _create_two_flow_batch(services, project_id)
        batch_id = created["batch"]["id"]
        runs = created["runs"]

        def assert_status(expected, statuses):
            for run, status in zip(runs, statuses):
                _set_run_status(services, run, status)
            batch = services.run_batch_by_id(project_id, batch_id)
            assert batch["status"] == expected

        assert_status("queued", ["queued", "queued"])
        assert_status("running", ["running", "queued"])
        assert_status("running", ["success", "queued"])
        assert_status("success", ["success", "success"])
        assert_status("canceled", ["canceled", "canceled"])
        assert_status("partial_failed", ["success", "failed"])
        assert_status("failed", ["failed", "canceled"])
        batch = services.run_batch_by_id(project_id, batch_id)
        assert batch["counts"]["completed"] == 2
        assert batch["counts"]["failed"] == 1
        assert batch["counts"]["canceled"] == 1
    finally:
        services.close()


def test_batch_cancel_idempotent_and_scoped(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        created = _create_two_flow_batch(services, project_id)
        batch_id = created["batch"]["id"]
        runs = created["runs"]
        _set_run_status(services, runs[0], "success")
        _set_run_status(services, runs[1], "running")
        services.cancel_managed_run = lambda run_id: True
        result = services.cancel_run_batch(project_id, batch_id, "owner-1")
        assert result["affectedQueued"] == 0
        assert result["affectedRunning"] == 1
        after = services.batch_runs(project_id, batch_id)
        assert after[0]["status"] == "success"
        assert after[0]["cancellationRequested"] is False
        assert after[1]["status"] == "running"
        assert after[1]["cancellationRequested"] is True
        events = services.database.execute(
            """
            SELECT COUNT(*) FROM platform_run_events
            WHERE kind = 'run.cancel_requested'
            """
        ).fetchone()[0]
        assert events == 1
        replay = services.cancel_run_batch(project_id, batch_id, "owner-1")
        assert replay["affectedQueued"] == 0
        assert replay["affectedRunning"] == 0
        events = services.database.execute(
            """
            SELECT COUNT(*) FROM platform_run_events
            WHERE kind = 'run.cancel_requested'
            """
        ).fetchone()[0]
        assert events == 1

        created2 = _create_two_flow_batch(services, project_id, key="key-2")
        result2 = services.cancel_run_batch(project_id, created2["batch"]["id"], "owner-1")
        assert result2["affectedQueued"] == 2
        after2 = services.batch_runs(project_id, created2["batch"]["id"])
        assert [run["status"] for run in after2] == ["canceled", "canceled"]
        assert services.run_batch_by_id(project_id, created2["batch"]["id"])["status"] == "canceled"
    finally:
        services.close()


def test_batch_cancel_queued_children_removed_from_runner(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        created = _create_two_flow_batch(services, project_id)
        cancel_calls: list[str] = []
        services.cancel_managed_run = lambda run_id: (cancel_calls.append(run_id), True)[1]
        result = services.cancel_run_batch(project_id, created["batch"]["id"], "owner-1")
        assert result["affectedQueued"] == 2
        assert result["affectedRunning"] == 0
        assert sorted(cancel_calls) == sorted(run["id"] for run in created["runs"])
    finally:
        services.close()


def test_batch_retry_uses_original_revision_snapshots(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        created = _create_two_flow_batch(services, project_id)
        batch_id = created["batch"]["id"]
        runs = created["runs"]
        _set_run_status(services, runs[0], "running")
        _set_run_status(services, runs[1], "failed")
        try:
            services.retry_run_batch(project_id, batch_id, "owner-1", "retry-key-1")
            raise AssertionError("batch with running child must not be retryable")
        except PlatformError as exc:
            assert exc.status == 409
            assert exc.code == "BATCH_NOT_RETRYABLE"

        _insert_revision(
            services, project_id, "revision-b2", "flow-b",
            published_at="2026-08-16T12:00:00.000Z",
            steps=[{"id": "b-1"}, {"id": "b-2"}],
        )
        services.database.execute(
            """
            UPDATE flow_revisions SET status = 'superseded'
            WHERE id = 'revision-b'
            """
        )
        _set_run_status(services, runs[0], "failed")
        retried = services.retry_run_batch(project_id, batch_id, "owner-1", "retry-key-1")
        new_batch = retried["batch"]
        assert new_batch["retryOfBatchId"] == batch_id
        assert new_batch["flowIds"] == ["flow-a", "flow-b"]
        new_runs = services.batch_runs(project_id, new_batch["id"])
        assert [run["revisionId"] for run in new_runs] == ["revision-a", "revision-b"]
        assert [run["retryOfRunId"] for run in new_runs] == [
            runs[0]["id"], runs[1]["id"],
        ]
        assert new_runs[1]["snapshot"]["flowRevisionId"] == "revision-b"
        assert len(new_runs[1]["snapshot"]["flow"]["steps"]) == 1
        original = services.run_batch_by_id(project_id, batch_id)
        assert original["status"] == "failed"
        assert len(services.batch_runs(project_id, batch_id)) == 2

        try:
            services.retry_run_batch(project_id, new_batch["id"], "owner-1", "retry-key-2")
            raise AssertionError("queued batch must not be retryable")
        except PlatformError as exc:
            assert exc.code == "BATCH_NOT_RETRYABLE"
    finally:
        services.close()


def test_batch_list_pagination_and_status_filter(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        first = _create_two_flow_batch(services, project_id, key="key-1")
        services.database.execute(
            "UPDATE run_batches SET created_at = ? WHERE id = ?",
            ("2026-08-16T10:00:00.000Z", first["batch"]["id"]),
        )
        second = _create_two_flow_batch(services, project_id, key="key-2")
        services.database.execute(
            "UPDATE run_batches SET created_at = ? WHERE id = ?",
            ("2026-08-16T11:00:00.000Z", second["batch"]["id"]),
        )
        for run in services.batch_runs(project_id, second["batch"]["id"]):
            _set_run_status(services, run, "success")
        page = services.run_batches_page(project_id, 1, 20)
        assert [batch["id"] for batch in page["batches"]] == [
            second["batch"]["id"], first["batch"]["id"],
        ]
        assert page["total"] == 2
        success_only = services.run_batches_page(project_id, 1, 20, status="success")
        assert [batch["id"] for batch in success_only["batches"]] == [
            second["batch"]["id"]
        ]
        single = services.run_batches_page(project_id, 2, 1)
        assert [batch["id"] for batch in single["batches"]] == [first["batch"]["id"]]
    finally:
        services.close()


def test_batch_route_replays_do_not_write_duplicate_audit_events(tmp_path):
    services, project_id = _setup_services(tmp_path)
    try:
        token = services.create_auth_session(
            AuthUser("owner-1", "owner@example.test", "Owner")
        )["token"]
        router = create_platform_router(services)

        def route(path):
            return next(item for item in router.routes if getattr(item, "path", None) == path)

        def call(endpoint, method="POST", body=None, **path_params):
            async def execute():
                scope = {
                    "type": "http",
                    "asgi": {"version": "3.0"},
                    "http_version": "1.1",
                    "method": method,
                    "scheme": "http",
                    "path": f"/api/platform/projects/{project_id}",
                    "raw_path": f"/api/platform/projects/{project_id}".encode(),
                    "query_string": b"",
                    "headers": [(b"authorization", f"Bearer {token}".encode())],
                    "client": ("127.0.0.1", 1234),
                    "server": ("127.0.0.1", 8787),
                }

                async def receive():
                    return {"type": "http.request", "body": body or b"", "more_body": False}

                return await endpoint.endpoint(
                    Request(scope, receive=receive), project_id=project_id, **path_params
                )

            return asyncio.run(execute())

        batch = {
            "id": "batch-1",
            "flowIds": ["flow-a", "flow-b"],
            "environmentId": "env-1",
            "counts": {"total": 2},
            "retryOfBatchId": None,
        }
        run = {
            "id": "run-1",
            "status": "queued",
            "revisionId": "revision-1",
            "environmentId": "env-1",
            "snapshot": {"flow": {"name": "Flow A"}},
            "cancellationRequested": False,
            "createdAt": "2026-08-16T00:00:00.000Z",
            "updatedAt": "2026-08-16T00:00:00.000Z",
        }
        created = iter((
            {"batch": batch, "runs": [run], "replayed": False},
            {"batch": batch, "runs": [run], "replayed": True},
        ))
        canceled = iter((
            {"batch": batch, "runs": [run], "affectedQueued": 1, "affectedRunning": 0},
            {"batch": batch, "runs": [run], "affectedQueued": 0, "affectedRunning": 0},
        ))
        retry_batch = {**batch, "id": "batch-2", "retryOfBatchId": "batch-1"}
        retried = iter((
            {"batch": retry_batch, "runs": [run], "replayed": False},
            {"batch": retry_batch, "runs": [run], "replayed": True},
        ))
        audit_actions = []
        services.create_run_batch = lambda _input: next(created)
        services.cancel_run_batch = lambda *_args: next(canceled)
        services.retry_run_batch = lambda *_args: next(retried)
        services.audit = lambda *_args: audit_actions.append(_args[2])

        batches_route = route("/api/platform/projects/{project_id}/run-batches")
        cancel_route = route(
            "/api/platform/projects/{project_id}/run-batches/{batch_id}/cancel"
        )
        retry_route = route(
            "/api/platform/projects/{project_id}/run-batches/{batch_id}/retry-failed"
        )
        create_body = json({
            "flowIds": ["flow-a", "flow-b"],
            "environmentId": "env-1",
            "clientRequestId": "create-key",
        }).encode()
        retry_body = json({"clientRequestId": "retry-key"}).encode()

        assert call(batches_route, body=create_body).status_code == 202
        assert call(batches_route, body=create_body).status_code == 200
        assert call(cancel_route, batch_id="batch-1").status_code == 202
        assert call(cancel_route, batch_id="batch-1").status_code == 202
        assert call(retry_route, body=retry_body, batch_id="batch-1").status_code == 202
        assert call(retry_route, body=retry_body, batch_id="batch-1").status_code == 202
        assert audit_actions == [
            "run_batch.created",
            "run_batch.cancel_requested",
            "run_batch.retried",
        ]
    finally:
        services.close()
