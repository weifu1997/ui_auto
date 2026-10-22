"""Run-detail event window regression tests (P1-5).

`run_response` 内嵌事件带 `LIMIT 500`，但取的是 `ORDER BY id ASC`（最早 500 条）。
长流程事件超过 500 条后，**最新**事件（进度、错误、结束标记）被截掉，UI 永远看不到
尾部 → 表现为卡在“运行中”。窗口必须改为保留最近 500 条（仍按时间正序）。
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
    workspace = services.create_workspace(user, "Events workspace")
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


def _queue_managed_run(services, project_id) -> str:
    created = services.queue_published_runs(
        {
            "projectId": project_id,
            "flowId": "flow-1",
            "environmentId": "env-1",
            "createdBy": "owner-1",
            "source": "manual",
            "dispatchKey": "window-key-1",
        }
    )
    return created["runIds"][0]


def test_run_response_keeps_newest_events_when_over_500(tmp_path):
    """超过 500 条事件时，run 详情必须保留最新事件，而不是最早的 500 条。

    修复前：窗口 = 最早 500 条 → 第 600 条（最新进度）丢失，run 看起来卡住。
    修复后：窗口 = 最近 500 条（时间正序），第 101..600 条都在。
    """
    services, project_id = _setup_services(tmp_path)
    try:
        run_id = _queue_managed_run(services, project_id)
        total = 600
        for index in range(1, total + 1):
            services.append_run_event(
                run_id, "step.progress", {"index": index}
            )

        response = services.run_response(services.run_by_id(run_id))
        events = response["events"]
        progress = [
            event["data"]["index"]
            for event in events
            if event["kind"] == "step.progress"
        ]

        # 事件窗口有 500 条封顶。
        assert len(events) <= 500
        # 尾部不被截掉：保留的是最近 500 条（第 101..600 步）。
        assert progress == list(range(total - 499, total + 1))
    finally:
        services.close()


def test_run_response_keeps_chronological_order_within_cap(tmp_path):
    """事件数在封顶内时顺序不变：窗口改造（取最近 N 条）不得反转时间序。"""
    services, project_id = _setup_services(tmp_path)
    try:
        run_id = _queue_managed_run(services, project_id)
        for index in range(1, 4):
            services.append_run_event(run_id, "step.progress", {"index": index})

        response = services.run_response(services.run_by_id(run_id))
        events = response["events"]
        assert len(events) == 4  # 入队 + 3 步进度
        progress = [
            event["data"]["index"]
            for event in events
            if event["kind"] == "step.progress"
        ]
        assert progress == [1, 2, 3]
    finally:
        services.close()
