"""Retry snapshot clone regression tests for the P0 follow-up."""

from autoflow.core import json
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
    workspace = services.create_workspace(user, "Retry workspace")
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
    return services, project_id, user


def _insert_revision(
    services,
    project_id,
    revision_id,
    flow_id="flow-1",
    environment_id="env-1",
    status="published",
    published_at="2026-08-16T00:00:00.000Z",
    steps=(),
    dataset_snapshot=None,
    checksum=None,
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
            json(dataset_snapshot or {}),
            checksum or f"checksum-{revision_id}",
            "owner-1",
            published_at,
            published_at,
        ),
    )


def _insert_dataset(services, project_id, version_id="dv-1", rows=None):
    services.database.execute(
        """
        INSERT INTO datasets (
          id, project_id, name, description, created_by, created_at, updated_at
        ) VALUES (?, ?, 'DS', '', ?, ?, ?)
        """,
        ("ds-1", project_id, "owner-1", "2026-08-16T00:00:00.000Z", "2026-08-16T00:00:00.000Z"),
    )
    rows = rows or [{"name": "alice"}, {"name": "bob"}]
    services.database.execute(
        """
        INSERT INTO dataset_versions (
          id, dataset_id, version_number, columns_json, row_count, checksum,
          source_name, created_by, created_at
        ) VALUES (?, ?, 1, ?, ?, 'checksum-ds', 's', ?, ?)
        """,
        (version_id, "ds-1", json(["name"]), len(rows), "owner-1", "2026-08-16T00:00:00.000Z"),
    )
    for index, row in enumerate(rows, start=1):
        services.database.execute(
            """
            INSERT INTO dataset_rows (id, dataset_version_id, row_number, data_json)
            VALUES (?, ?, ?, ?)
            """,
            (f"dr-{index}", version_id, index, json(row)),
        )


def _run_count(services):
    return services.database.execute(
        "SELECT COUNT(*) FROM platform_runs"
    ).fetchone()[0]


def _event_count(services, run_id, kind):
    return services.database.execute(
        "SELECT COUNT(*) FROM platform_run_events WHERE run_id = ? AND kind = ?",
        (run_id, kind),
    ).fetchone()[0]


def test_single_retry_is_exact_one_to_one_snapshot_clone(tmp_path):
    services, project_id, user = _setup_services(tmp_path)
    try:
        _insert_revision(
            services,
            project_id,
            "revision-1",
            steps=[{"id": "s1"}, {"id": "s2"}],
            checksum="checksum-abc",
        )
        queued = services.queue_published_runs(
            {
                "projectId": project_id,
                "flowId": "flow-1",
                "environmentId": "env-1",
                "upToStepId": "s1",
                "createdBy": user.id,
                "source": "manual",
            }
        )
        source = services.run_by_id(queued["runIds"][0])
        services.database.execute(
            "UPDATE platform_runs SET status = 'failed' WHERE id = ?",
            (source["id"],),
        )
        retried = services.retry_run_snapshot(project_id, source["id"], user.id)
        assert len(retried["runIds"]) == 1
        assert _run_count(services) == 2
        new_run = retried["runs"][0]
        assert new_run["retryOfRunId"] == source["id"]
        assert new_run["revisionId"] == source["revisionId"]
        assert new_run["snapshot"]["flowRevisionChecksum"] == "checksum-abc"
        assert new_run["snapshot"]["upToStepId"] == "s1"
        # snapshot 保留完整 flow steps，upToStepId 是执行边界，不截断持久化快照
        assert new_run["snapshot"]["flow"]["steps"] == [{"id": "s1"}, {"id": "s2"}]
        assert _event_count(services, new_run["id"], "run.retried") == 1
        assert _event_count(services, new_run["id"], "run.queued") == 1
        # 原 run 历史不变
        assert _event_count(services, source["id"], "run.retried") == 0
    finally:
        services.close()


def test_single_retry_dataset_clones_one_row_not_all_rows(tmp_path):
    services, project_id, user = _setup_services(tmp_path)
    try:
        _insert_dataset(services, project_id)
        _insert_revision(
            services,
            project_id,
            "revision-1",
            steps=[{"id": "s1"}],
            dataset_snapshot={"versionId": "dv-1"},
            checksum="checksum-abc",
        )
        queued = services.queue_published_runs(
            {
                "projectId": project_id,
                "flowId": "flow-1",
                "environmentId": "env-1",
                "datasetVersionId": "dv-1",
                "createdBy": user.id,
                "source": "manual",
            }
        )
        assert len(queued["runIds"]) == 2
        source = services.run_by_id(queued["runIds"][1])
        services.database.execute(
            "UPDATE platform_runs SET status = 'canceled' WHERE id = ?",
            (source["id"],),
        )
        retried = services.retry_run_snapshot(project_id, source["id"], user.id)
        assert len(retried["runIds"]) == 1
        assert _run_count(services) == 3
        new_run = retried["runs"][0]
        assert new_run["retryOfRunId"] == source["id"]
        assert new_run["snapshot"]["datasetRow"] == source["snapshot"]["datasetRow"]
        assert new_run["snapshot"]["datasetRow"]["number"] == 2
        assert _event_count(services, new_run["id"], "run.retried") == 1
    finally:
        services.close()


def test_retry_missing_ordinary_variable_is_zero_write(tmp_path):
    services, project_id, user = _setup_services(tmp_path)
    try:
        _insert_revision(
            services,
            project_id,
            "revision-1",
            steps=[{"id": "s1", "value": "{{env.USERNAME}}"}],
            checksum="checksum-abc",
        )
        queued = services.queue_published_runs(
            {
                "projectId": project_id,
                "flowId": "flow-1",
                "environmentId": "env-1",
                "createdBy": user.id,
                "source": "manual",
            }
        )
        source = services.run_by_id(queued["runIds"][0])
        services.database.execute(
            "UPDATE platform_runs SET status = 'failed' WHERE id = ?",
            (source["id"],),
        )
        before = _run_count(services)
        try:
            services.retry_run_snapshot(project_id, source["id"], user.id)
            raise AssertionError("missing ordinary variable must be rejected")
        except PlatformError as exc:
            assert exc.code == "RUN_VARIABLE_NOT_CONFIGURED"
        assert _run_count(services) == before
        assert _event_count(services, source["id"], "run.retried") == 0
    finally:
        services.close()


def test_batch_retry_replays_existing_batch_for_same_key(tmp_path):
    services, project_id, user = _setup_services(tmp_path)
    try:
        for revision_id, flow_id in (("r-a", "flow-a"), ("r-b", "flow-b")):
            _insert_revision(
                services,
                project_id,
                revision_id,
                flow_id=flow_id,
                steps=[{"id": f"{flow_id}-1"}],
            )
        created = services.create_run_batch(
            {
                "projectId": project_id,
                "flowIds": ["flow-a", "flow-b"],
                "environmentId": "env-1",
                "clientRequestId": "key-1",
                "createdBy": user.id,
            }
        )
        for run in services.batch_runs(project_id, created["batch"]["id"]):
            services.database.execute(
                "UPDATE platform_runs SET status = 'failed' WHERE id = ?",
                (run["id"],),
            )
        first = services.retry_run_batch(
            project_id, created["batch"]["id"], user.id, "retry-key"
        )
        batch_count_before = services.database.execute(
            "SELECT COUNT(*) FROM run_batches"
        ).fetchone()[0]
        replay = services.retry_run_batch(
            project_id, created["batch"]["id"], user.id, "retry-key"
        )
        assert replay["replayed"] is True
        assert replay["batch"]["id"] == first["batch"]["id"]
        assert services.database.execute(
            "SELECT COUNT(*) FROM run_batches"
        ).fetchone()[0] == batch_count_before
    finally:
        services.close()


def test_batch_retry_writes_retried_event_per_child(tmp_path):
    services, project_id, user = _setup_services(tmp_path)
    try:
        for revision_id, flow_id in (("r-a", "flow-a"), ("r-b", "flow-b")):
            _insert_revision(
                services,
                project_id,
                revision_id,
                flow_id=flow_id,
                steps=[{"id": f"{flow_id}-1"}],
            )
        created = services.create_run_batch(
            {
                "projectId": project_id,
                "flowIds": ["flow-a", "flow-b"],
                "environmentId": "env-1",
                "clientRequestId": "key-1",
                "createdBy": user.id,
            }
        )
        runs = services.batch_runs(project_id, created["batch"]["id"])
        services.database.execute(
            "UPDATE platform_runs SET status = 'failed' WHERE id = ?",
            (runs[0]["id"],),
        )
        services.database.execute(
            "UPDATE platform_runs SET status = 'success' WHERE id = ?",
            (runs[1]["id"],),
        )
        retried = services.retry_run_batch(
            project_id, created["batch"]["id"], user.id, "retry-key"
        )
        new_runs = retried["runs"]
        assert len(new_runs) == 1
        assert new_runs[0]["retryOfRunId"] == runs[0]["id"]
        assert _event_count(services, new_runs[0]["id"], "run.retried") == 1
    finally:
        services.close()
