"""Dataset-dispatch default cap regression tests (P1-3).

A schedule/manual dispatch bound to a dataset fans out one run per row inside a
single ``BEGIN IMMEDIATE``. A dataset may legitimately hold thousands of rows
(import allows up to 10,000), so an unbounded dispatch mints thousands of run +
event rows — each duplicating the full flow/environment/element snapshot — under
one global write lock, with nothing written unless every row preflights.

Webhooks already cap themselves (``WEBHOOK_MAX_RUNS``). Schedule and manual
dispatches passed no cap at all. The fix enforces a platform default
``MAX_RUNS_PER_DISPATCH`` (env ``AUTOFLOW_MAX_RUNS_PER_DISPATCH``, default 1000)
in ``resolve_run_spec`` before any row is written, rejecting oversize dispatches
with the same 413 the webhook path already surfaces.
"""

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
        (user.id, user.email, user.name, "2026-08-22T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "Dispatch workspace")
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
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, flow_id, flow_name, environment_id,
          revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_by,
          created_at, published_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'published', ?, ?, '[]', '{}', ?, ?, ?, ?)
        """,
        (
            "revision-a",
            project_id,
            "flow-1",
            "Flow flow-1",
            "env-1",
            json({"id": "flow-1", "name": "Flow flow-1", "steps": [{"id": "a-1"}]}),
            json({"id": "env-1", "name": "Env", "browser": "Chromium"}),
            "checksum-revision-a",
            "owner-1",
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )
    services.enqueue_managed_run = lambda run_id: None
    return services, project_id


def _insert_dataset(services, project_id, *, row_count: int) -> None:
    services.database.execute(
        """
        INSERT INTO datasets (id, project_id, name, description, created_by,
                              created_at, updated_at)
        VALUES (?, ?, ?, '', ?, ?, ?)
        """,
        (
            "dataset-1",
            project_id,
            "Rows",
            "owner-1",
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )
    services.database.execute(
        """
        INSERT INTO dataset_versions (
          id, dataset_id, version_number, columns_json, row_count,
          checksum, source_name, created_by, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, 'rows.csv', ?, ?)
        """,
        (
            "version-1",
            "dataset-1",
            json([{"name": "name"}]),
            row_count,
            "checksum-version-1",
            "owner-1",
            "2026-08-22T00:00:00.000Z",
        ),
    )
    for row_number in range(1, row_count + 1):
        services.database.execute(
            """
            INSERT INTO dataset_rows (
              id, dataset_version_id, row_number, data_json
            ) VALUES (?, ?, ?, ?)
            """,
            (
                f"row-{row_number}",
                "version-1",
                row_number,
                json({"name": f"row-{row_number}"}),
            ),
        )


def _dispatch(services, project_id) -> list[str]:
    return services.queue_published_runs(
        {
            "projectId": project_id,
            "flowId": "flow-1",
            "environmentId": "env-1",
            "datasetVersionId": "version-1",
            "createdBy": "owner-1",
            "source": "manual",
            "dispatchKey": "cap-key-1",
        }
    )["runIds"]


def _run_count(services, project_id) -> int:
    return services.database.execute(
        "SELECT COUNT(*) FROM platform_runs WHERE project_id = ?",
        (project_id,),
    ).fetchone()[0]


def test_dataset_dispatch_over_default_cap_rejected_before_write(
    monkeypatch, tmp_path
):
    """超过默认单次派发上限必须在写任何行之前拒绝，不能产生半批运行。"""
    import autoflow.services.runs._lifecycle as lifecycle

    services, project_id = _setup_services(tmp_path)
    try:
        _insert_dataset(services, project_id, row_count=5)
        # 用小上限让测试快速且不依赖环境；逻辑与默认 1000 完全一致。
        monkeypatch.setattr(lifecycle, "MAX_RUNS_PER_DISPATCH", 3)

        try:
            _dispatch(services, project_id)
        except PlatformError as error:
            assert error.status == 413
            assert error.code == "RUN_COUNT_LIMIT_EXCEEDED"
        else:
            raise AssertionError("oversize dispatch must be rejected with 413")

        # 拒绝发生在写任何一行之前：不得留下半批 run / 事件。
        assert _run_count(services, project_id) == 0
    finally:
        services.close()


def test_dispatch_within_default_cap_still_queues_every_row(monkeypatch, tmp_path):
    """等于上限的数据集仍按行全部入队（不超过上限不误伤）。"""
    import autoflow.services.runs._lifecycle as lifecycle

    services, project_id = _setup_services(tmp_path)
    try:
        _insert_dataset(services, project_id, row_count=3)
        monkeypatch.setattr(lifecycle, "MAX_RUNS_PER_DISPATCH", 3)

        run_ids = _dispatch(services, project_id)
        assert len(run_ids) == 3
        assert _run_count(services, project_id) == 3
    finally:
        services.close()


def test_platform_default_dispatch_cap_is_1000():
    from autoflow.core import MAX_RUNS_PER_DISPATCH

    assert MAX_RUNS_PER_DISPATCH == 1000
