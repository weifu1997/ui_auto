"""Manual run dispatch-key idempotency regression tests.

`POST /api/platform/projects/{id}/runs` 必须把客户端 dispatchKey 透传到
`queue_published_runs`，使同一派发意图的超时重试/双击按 key 去重。
"""

from autoflow.core import json
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
    services.enqueue_managed_run = lambda run_id: None
    return services, project_id, user


def _insert_revision(services, project_id, revision_id, flow_id="flow-1"):
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
            revision_id,
            project_id,
            flow_id,
            f"Flow {flow_id}",
            "env-1",
            json({"id": flow_id, "name": f"Flow {flow_id}", "steps": [{"id": "a-1"}]}),
            json({"id": "env-1", "name": "Env", "browser": "Chromium"}),
            f"checksum-{revision_id}",
            "owner-1",
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )


def _manual_input(project_id, dispatch_key=None, flow_id="flow-1"):
    value = {
        "projectId": project_id,
        "flowId": flow_id,
        "environmentId": "env-1",
        "createdBy": "owner-1",
        "source": "manual",
    }
    if dispatch_key:
        value["dispatchKey"] = dispatch_key
    return value


def _run_count(services, project_id):
    return services.database.execute(
        "SELECT COUNT(*) FROM platform_runs WHERE project_id = ?",
        (project_id,),
    ).fetchone()[0]


def test_same_dispatch_key_dedupes_manual_runs(tmp_path):
    services, project_id, _user = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a")
        first = services.queue_published_runs(_manual_input(project_id, "web-key-1"))
        second = services.queue_published_runs(_manual_input(project_id, "web-key-1"))
        assert first["runIds"] == second["runIds"]
        assert _run_count(services, project_id) == 1
    finally:
        services.close()


def test_different_dispatch_key_creates_independent_runs(tmp_path):
    services, project_id, _user = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a")
        first = services.queue_published_runs(_manual_input(project_id, "web-key-1"))
        second = services.queue_published_runs(_manual_input(project_id, "web-key-2"))
        assert first["runIds"] != second["runIds"]
        assert _run_count(services, project_id) == 2
    finally:
        services.close()


def test_without_dispatch_key_each_submission_creates_a_run(tmp_path):
    services, project_id, _user = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a")
        services.queue_published_runs(_manual_input(project_id))
        services.queue_published_runs(_manual_input(project_id))
        assert _run_count(services, project_id) == 2
    finally:
        services.close()


def test_same_dispatch_key_is_scoped_per_project(tmp_path):
    """F1 回归：dispatchKey 去重必须限定在同一项目内，
    两个项目复用同一 key 时互不吞并。"""
    services, project_id, _user = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a")
        workspace_id = services.database.execute(
            "SELECT workspace_id FROM platform_projects WHERE id = ?",
            (project_id,),
        ).fetchone()[0]
        project_2 = "project-2"
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_2,
                workspace_id,
                project_2,
                "Project 2",
                "",
                "2026-08-22T00:00:00.000Z",
                "2026-08-22T00:00:00.000Z",
            ),
        )
        _insert_revision(services, project_2, "revision-b", flow_id="flow-2")
        first = services.queue_published_runs(_manual_input(project_id, "web-key-shared"))
        second = services.queue_published_runs(
            _manual_input(project_2, "web-key-shared", flow_id="flow-2")
        )
        assert first["runIds"] != second["runIds"]
        assert _run_count(services, project_id) == 1
        assert _run_count(services, project_2) == 1
    finally:
        services.close()


def test_retry_run_snapshot_dedupes_by_dispatch_key(tmp_path):
    """P5 回归：按原快照重试也走 dispatchKey 幂等，
    同一 key 的重复重试不创建第二条运行。"""
    services, project_id, _user = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a")
        created = services.queue_published_runs(_manual_input(project_id, "web-key-run"))
        run_id = created["runIds"][0]
        services.database.execute(
            "UPDATE platform_runs SET status = 'failed' WHERE id = ?",
            (run_id,),
        )
        first = services.retry_run_snapshot(project_id, run_id, "owner-1", "web-key-retry")
        second = services.retry_run_snapshot(project_id, run_id, "owner-1", "web-key-retry")
        assert first["runIds"] == second["runIds"]
        # 原始运行 + 一次重试（第二次按 key 去重）
        assert _run_count(services, project_id) == 2
    finally:
        services.close()


def test_retry_run_snapshot_different_keys_create_independent_retries(tmp_path):
    services, project_id, _user = _setup_services(tmp_path)
    try:
        _insert_revision(services, project_id, "revision-a")
        created = services.queue_published_runs(_manual_input(project_id, "web-key-run"))
        run_id = created["runIds"][0]
        services.database.execute(
            "UPDATE platform_runs SET status = 'failed' WHERE id = ?",
            (run_id,),
        )
        first = services.retry_run_snapshot(project_id, run_id, "owner-1", "web-key-retry-1")
        second = services.retry_run_snapshot(project_id, run_id, "owner-1", "web-key-retry-2")
        assert first["runIds"] != second["runIds"]
        # 原始运行 + 两次独立重试
        assert _run_count(services, project_id) == 3
    finally:
        services.close()
