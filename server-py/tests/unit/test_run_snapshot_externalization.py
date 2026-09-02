"""P1-5c run snapshot 外置 + 迁移回归（写放大，审计 P1-3/P1-5 剩余）。

现状（修复前）：``insert_run_from_spec`` 把整份运行快照（flow/environment/
elements/dataset 元数据/secretNames…）内嵌到 ``platform_runs.snapshot`` 这一
高频扫描表的每一行 —— 数据集/批次派发按行复制整份 JSON，且列表/聚合/去重查询
每次都要背着它。本测试要求：
  * 新增 run 不再把全量 snapshot 写进 ``platform_runs``（热行瘦身）；
  * 快照外置到 ``run_snapshots``（run_id 引用 platform_runs，级联删除）；
  * ``platform_runs`` 上补轻量列 flow_name/environment_name/total_steps，
    供列表摘要/按流程名过滤使用，无需再读整份快照；
  * ``run_by_id`` 等消费点仍返回与原来一致的含 snapshot 的 run 字典；
  * 存量行通过迁移 v16 回填到 run_snapshots 并派生轻量列。
"""

from autoflow.core import json, parse_json
from autoflow.services import AuthUser, PlatformServices

SNAPSHOT_FLOW_NAME = "Flow flow-1"


def _seed_services(tmp_path):
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
            SNAPSHOT_FLOW_NAME,
            "env-1",
            json({"id": "flow-1", "name": SNAPSHOT_FLOW_NAME, "steps": [{"id": "a-1"}]}),
            json({"id": "env-1", "name": "Env", "browser": "Chromium"}),
            "checksum-revision-a",
            "owner-1",
            "2026-08-22T00:00:00.000Z",
            "2026-08-22T00:00:00.000Z",
        ),
    )
    services.enqueue_managed_run = lambda run_id: None
    return services, project_id


def _dispatch(services, project_id, dispatch_key: str) -> list[str]:
    return services.queue_published_runs(
        {
            "projectId": project_id,
            "flowId": "flow-1",
            "environmentId": "env-1",
            "createdBy": "owner-1",
            "source": "manual",
            "dispatchKey": dispatch_key,
        }
    )["runIds"]


def _snapshot_row(services, run_id):
    return services.database.execute(
        "SELECT snapshot FROM run_snapshots WHERE run_id = ?",
        (run_id,),
    ).fetchone()


def test_new_runs_keep_hot_row_lean_and_externalize_snapshot(tmp_path):
    """派发后 platform_runs 不再背全量快照，快照落在 run_snapshots，轻量列已派生。"""
    services, project_id = _seed_services(tmp_path)
    try:
        run_ids = _dispatch(services, project_id, "externalize-key-1")
        assert len(run_ids) == 1
        run_id = run_ids[0]
        row = services.database.execute(
            """
            SELECT snapshot, flow_name, environment_name, total_steps
            FROM platform_runs WHERE id = ?
            """,
            (run_id,),
        ).fetchone()
        assert row is not None
        # 热行不再携带全量快照文本
        assert row[0] in ("", None)
        # 轻量列已从快照派生，列表/过滤无需再读整份 JSON
        assert row[1] == SNAPSHOT_FLOW_NAME
        assert row[2] == "Env"
        assert row[3] == 1
        # 快照已外置到 run_snapshots，内容与原语义一致
        stored = _snapshot_row(services, run_id)
        assert stored is not None and stored[0]
        parsed = parse_json(stored[0], {})
        assert isinstance(parsed, dict)
        assert parsed["flow"]["name"] == SNAPSHOT_FLOW_NAME
        assert parsed["environment"]["name"] == "Env"
    finally:
        services.close()


def test_run_by_id_still_returns_full_parsed_snapshot(tmp_path):
    """run_by_id 详情读取经 run_snapshots 仍回同结构的解析快照。"""
    services, project_id = _seed_services(tmp_path)
    try:
        run_id = _dispatch(services, project_id, "read-path-key-1")[0]
        run = services.run_by_id(run_id)
        assert isinstance(run["snapshot"], dict)
        assert run["snapshot"]["flow"]["name"] == SNAPSHOT_FLOW_NAME
        assert run["snapshot"]["flow"]["steps"][0]["id"] == "a-1"
        # run_response（详情/重试/取消）消费同一 run 字典，快照随行返回
        response = services.run_response(run)
        assert response["snapshot"]["flow"]["name"] == SNAPSHOT_FLOW_NAME
    finally:
        services.close()


def test_migration_v16_backfills_legacy_inline_runs(tmp_path):
    """存量（snapshot 内嵌在 platform_runs 的行）升到 v16 后回填 run_snapshots。"""
    services, project_id = _seed_services(tmp_path)
    try:
        # 先正常派发一个 run，取得真实存在的 agent_id/revision_id。
        run_ids = _dispatch(services, project_id, "migrate-key-1")
        assert len(run_ids) == 1
        base = services.database.execute(
            """
            SELECT agent_id, revision_id, environment_id
            FROM platform_runs WHERE id = ?
            """,
            (run_ids[0],),
        ).fetchone()
        created_at = "2026-08-22T00:00:00.000Z"
        legacy_snapshot = {
            "flowRevisionId": "revision-a",
            "flowRevisionChecksum": "checksum-revision-a",
            "environmentId": "env-1",
            "flow": {"id": "flow-1", "name": SNAPSHOT_FLOW_NAME, "steps": [{"id": "a-1"}]},
            "environment": {"id": "env-1", "name": "Env"},
            "elements": [],
            "dataset": None,
            "datasetRow": None,
            "secretNames": [],
            "upToStepId": None,
            "executor": {"type": "managed", "id": base[0]},
            "trigger": "manual",
        }
        legacy_run_id = "legacy-run-1"
        services.database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id,
              executor_type, status, snapshot, cancellation_requested,
              created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'managed', 'success', ?, 0, 'owner-1', ?, ?)
            """,
            (
                legacy_run_id,
                project_id,
                base[1],
                base[2],
                base[0],
                json(legacy_snapshot),
                created_at,
                created_at,
            ),
        )
        # 模拟「仍是 v15 且快照内嵌」的旧库：撤掉 v16 的痕迹（若已应用），
        # 让下次打开触发迁移 v16 对存量行做回填。
        services.database.execute(
            "DELETE FROM schema_migrations WHERE version = 16"
        )
        services.database.execute("DROP TABLE IF EXISTS run_snapshots")
        services.database.execute(
            "UPDATE platform_runs SET snapshot = ? WHERE id = ?",
            (json(legacy_snapshot), legacy_run_id),
        )
        services.close()

        reopened = PlatformServices(str(tmp_path))
        try:
            migrated = reopened.database.execute(
                """
                SELECT snapshot, flow_name, environment_name, total_steps
                FROM platform_runs WHERE id = ?
                """,
                (legacy_run_id,),
            ).fetchone()
            assert migrated is not None
            assert migrated[0] in ("", None)  # 回填后热行清空
            assert migrated[1] == SNAPSHOT_FLOW_NAME
            assert migrated[2] == "Env"
            assert migrated[3] == 1
            external = _snapshot_row(reopened, legacy_run_id)
            assert external is not None
            assert parse_json(external[0], {})["flow"]["name"] == SNAPSHOT_FLOW_NAME
        finally:
            reopened.close()
    finally:
        services.close()
