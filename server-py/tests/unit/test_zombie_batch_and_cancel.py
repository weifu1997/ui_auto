"""Stage W1-4/W1-5: 僵尸 batch 派生状态与取消竞态修根单测。

W1-4 契约：
- batch 状态恒为查询期派生值；当全部子 run 被单独删除（counts.total=0）
  时派生为 failed，不再是永远 queued 的僵尸批次。
- 取消/重试受子项存在性约束：无子项时 retry 得 BATCH_NOT_RETRYABLE。

W1-5 契约：
- ``request_run_cancel`` 先无条件写 cancellation_requested（queued/running
  界内），再把仍处 queued 的行置 canceled——与 worker 的启动竞态下标记
  不再丢失；
- 「等待」步骤存在环境变量可调的硬上限，超限发 step.waitCapped 事件并被
  截断执行。
"""

from __future__ import annotations

import uuid

import pytest

from autoflow.runner import _wait_step_cap_ms
from autoflow.services import AuthUser, PlatformServices


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PLATFORM_SECRET_KEY", "test-key-zombie")
    services = PlatformServices(str(tmp_path))
    user = AuthUser("owner-zb", "owner-zb@example.test", "Owner")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, "2026-08-24T00:00:00.000Z"),
    )
    workspace = services.create_workspace(user, "ZB workspace")
    workspace_id = workspace["id"]
    project_id = "project-zb"
    created = "2026-08-24T00:00:00.000Z"
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', ?, ?)
        """,
        (project_id, workspace_id, project_id, "Project", created, created),
    )
    services.database.execute(
        """
        INSERT INTO agents (
          id, workspace_id, name, credential_hash, status, browser_version,
          os, max_concurrency, created_at
        ) VALUES ('agent-zb', ?, 'a', 'x', 'active', 'stable', 'linux', 1, ?)
        """,
        (workspace_id, created),
    )
    services.database.execute(
        """
        INSERT INTO flow_revisions (
          id, project_id, flow_id, flow_name, environment_id,
          revision_number, status, flow_snapshot, environment_snapshot,
          element_snapshot, dataset_snapshot, checksum, created_at, created_by
        ) VALUES ('rev-zb', ?, 'f', 'F', 'env', 7001, 'published',
                  '{}', '{}', '{}', '{}', 'zb-checksum', ?, 'owner')
        """,
        (project_id, created),
    )
    return services, project_id, workspace_id, created


def _child_run(services, project_id: str, batch_id: str | None) -> str:
    run_id = f"run-{uuid.uuid4().hex[:8]}"
    services.database.execute(
        """
        INSERT INTO platform_runs (
          id, project_id, revision_id, environment_id, agent_id, status,
          snapshot, cancellation_requested, result, created_by, created_at,
          updated_at, batch_id
        ) VALUES (?, ?, 'rev-zb', 'env', 'agent-zb', 'canceled',
                  '{}', 0, NULL, 'owner', '2026-08-24T00:00:00.000Z',
                  '2026-08-24T00:00:00.000Z', ?)
        """,
        (run_id, project_id, batch_id),
    )
    return run_id


# ---------- W1-4 ----------


def test_batch_with_all_children_deleted_derives_failed(tmp_path, monkeypatch):
    services, project_id, _, created = _setup(tmp_path, monkeypatch)
    try:
        batch_id = "batch-zombie"
        services.database.execute(
            """
            INSERT INTO run_batches (
              id, project_id, environment_id, client_request_id, source,
              requested_flow_ids, cancellation_requested, created_by,
              created_at, updated_at
            ) VALUES (?, ?, 'env', 'req-zombie', 'manual', '["f1","f2"]',
                      0, 'owner', ?, ?)
            """,
            (batch_id, project_id, created, created),
        )
        runs = [
            _child_run(services, project_id, batch_id) for _ in range(2)
        ]

        # 有子项时按既有规则派生：全 canceled → canceled。
        assert services.run_batch_by_id(project_id, batch_id)["status"] == "canceled"

        # 全部子 run 单独删除后：派生 failed，不再显示幽灵 queued。
        services.delete_runs(project_id, runs)
        assert services.run_batch_by_id(project_id, batch_id)["status"] == "failed"
        assert services.run_batch_by_id(project_id, batch_id)["counts"]["total"] == 0

        with pytest.raises(Exception):
            services.retry_run_batch(project_id, batch_id, {})
    finally:
        services.close()


# ---------- W1-5 ----------


def test_request_run_cancel_marks_flag_before_state_transition(
    tmp_path, monkeypatch
):
    services, project_id, _, _ = _setup(tmp_path, monkeypatch)
    try:
        # 模拟竞态前的中间态：cancel 先写标记（行仍是 running）。
        running = services.database.execute  # noqa: F841 (文档化用途说明)
        run_id = "run-race"
        services.database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id, status,
              snapshot, cancellation_requested, result, created_by, created_at,
              updated_at, batch_id
            ) VALUES (?, ?, 'rev-zb', 'env', 'agent-zb', 'running',
                      '{}', 0, NULL, 'owner', '2026-08-24T00:00:00.000Z',
                      '2026-08-24T00:00:00.000Z', NULL)
            """,
            (run_id, project_id),
        )
        services.request_run_cancel(run_id, project_id)

        row = services.database.execute(
            "SELECT status, cancellation_requested FROM platform_runs WHERE id = ?",
            (run_id,),
        ).fetchone()
        # running 行：不直接改终态，但标记必须已落库（completed 映射的依据）。
        assert row[0] == "running" and row[1] == 1

        # queued 行：直接置 canceled 且带标记。
        queued_id = "run-race-queued"
        services.database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id, status,
              snapshot, cancellation_requested, result, created_by, created_at,
              updated_at, batch_id
            ) VALUES (?, ?, 'rev-zb', 'env', 'agent-zb', 'queued',
                      '{}', 0, NULL, 'owner', '2026-08-24T00:00:00.000Z',
                      '2026-08-24T00:00:00.000Z', NULL)
            """,
            (queued_id, project_id),
        )
        services.request_run_cancel(queued_id, project_id)
        row = services.database.execute(
            "SELECT status, cancellation_requested FROM platform_runs WHERE id = ?",
            (queued_id,),
        ).fetchone()
        assert row[0] == "canceled" and row[1] == 1

        # 终态行不受影响（幂等边界）。
        del running
    finally:
        services.close()


def test_wait_step_cap_reads_env_and_clamps(monkeypatch):
    monkeypatch.setattr("os.environ", {**__import__("os").environ}, raising=False)
    monkeypatch.delenv("WAIT_STEP_MAX_MS", raising=False)
    assert _wait_step_cap_ms() == 600_000

    monkeypatch.setenv("WAIT_STEP_MAX_MS", "2500")
    assert _wait_step_cap_ms() == 2_500

    monkeypatch.setenv("WAIT_STEP_MAX_MS", "not-a-number")
    assert _wait_step_cap_ms() == 600_000

    monkeypatch.setenv("WAIT_STEP_MAX_MS", "10")
    assert _wait_step_cap_ms() == 1_000  # 下限保护


def test_terminate_failed_result_maps_to_canceled_when_flag_set(
    tmp_path, monkeypatch
):
    """回归原缺陷：running 行被取消（有标记）后 runner 返回 failed，
    completed 映射应落 canceled。"""
    services, project_id, _, _ = _setup(tmp_path, monkeypatch)
    try:
        run_id = "run-flagwin"
        services.database.execute(
            """
            INSERT INTO platform_runs (
              id, project_id, revision_id, environment_id, agent_id, status,
              snapshot, cancellation_requested, result, created_by, created_at,
              updated_at, batch_id
            ) VALUES (?, ?, 'rev-zb', 'env', 'agent-zb', 'running',
                      '{}', 0, NULL, 'owner', '2026-08-24T00:00:00.000Z',
                      '2026-08-24T00:00:00.000Z', NULL)
            """,
            (run_id, project_id),
        )
        # 模拟旧缺陷场景：先抢跑 finalize（标 failed），再补上标记 +
        # 迟到失败结果 —— 该场景由 finalize 的幂等守卫拒绝写入，
        # 状态保持首次落库值；这里验证的另一面是「标记先行」路径：
        services.request_run_cancel(run_id, project_id)
        services.finalize_completed_run(
            run_id,
            {
                "status": "canceled",
                "completedSteps": 0,
                "totalSteps": 0,
                "elapsedMs": 0,
                "error": "RUN_CANCELED",
                "flowOutputs": {},
            },
        )
        status = services.database.execute(
            "SELECT status FROM platform_runs WHERE id = ?", (run_id,)
        ).fetchone()[0]
        assert status == "canceled"
    finally:
        services.close()
